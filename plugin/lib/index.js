import { defineTool } from '@deepseek-ai/dsh-tools'
import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-clean-report'
export const inject = ['tools']

/** 安装清单由 CLI 的 install 写入；没有它说明本机还没装 DSH-clean。 */
const LOCAL = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
const INSTALL_JSON = path.join(LOCAL, 'dsh-clean', 'install.json')
const FRESH_MS = 10 * 60 * 1000

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

function readInstall() { return readJson(INSTALL_JSON) }

function lastRun(stateDir) { return readJson(path.join(stateDir, 'last-run.json')) }

/** 报告目录里最新的那份（目录名是 YYYYMMDD-HHMMSS，按名排序即按时间）。 */
function latestReport(stateDir) {
  const dir = path.join(stateDir, 'reports')
  let names = []
  try { names = readdirSync(dir).filter((n) => /^\d{8}-\d{6}$/.test(n)).sort() } catch { return null }
  const last = names[names.length - 1]
  if (!last) return null
  const file = path.join(dir, last, 'report.md')
  try {
    const st = statSync(file)
    return { id: last, path: file, mtimeMs: st.mtimeMs, bytes: st.size, count: names.length }
  } catch { return null }
}

function ageText(ms) {
  const sec = Math.max(0, Math.round(ms / 1000))
  if (sec < 90) return sec + ' 秒前'
  if (sec < 5400) return Math.round(sec / 60) + ' 分钟前'
  return Math.round(sec / 3600) + ' 小时前'
}

/** 用客户端自带的 Electron 以 Node 身份跑扫描器：宿主侧执行，不依赖会话有没有 shell。 */
function runScan(install, full) {
  const exe = install.desktopExe || process.execPath
  const script = path.join(install.appDir, 'dsh-clean.mjs')
  if (!existsSync(script)) return Promise.reject(new Error('扫描器不在 ' + script + '，请先重新运行 install'))
  const args = [script, 'scan', '--agent', '--state-dir=' + install.stateDir]
  if (full) args.push('--full')
  return new Promise((resolve, reject) => {
    execFile(exe, args, {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      cwd: install.stateDir,
      timeout: 180000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) { reject(new Error((stderr || error.message || 'scan failed').trim().split('\n').slice(-3).join(' '))); return }
      const lines = String(stdout).split(/\r?\n/).filter((l) => l.trim() !== '')
      const summary = lines.find((l) => l.startsWith('PURITY ')) ?? lines[lines.length - 1] ?? ''
      resolve(summary)
    })
  })
}

function reportHead(file, limit) {
  const text = readFileSync(file, 'utf8')
  return text.split(/\r?\n/).slice(0, limit).join('\n')
}

function statusText(install) {
  const run = lastRun(install.stateDir)
  const rep = latestReport(install.stateDir)
  if (run === null) return { ok: false, notes: ['还没有扫描记录：用 action="scan" 跑一次，或双击 scan.cmd。'] }
  const age = Date.now() - Number(run.at ?? 0)
  const notes = []
  notes.push(age < FRESH_MS ? '报告是新的（' + ageText(age) + '）。' : '报告较旧（' + ageText(age) + '）；要最新数据用 action="scan"。')
  if (/reports=\d+\/prune/.test(String(run.line))) notes.push('报告攒多了；清理报告用 prune（需要 shell 或双击 prune.cmd）。')
  return {
    ok: true,
    summary: String(run.line ?? ''),
    reportPath: run.reportPath ?? rep?.path ?? '',
    reportAgeSeconds: Math.round(age / 1000),
    reports: rep?.count ?? 0,
    notes,
  }
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'dsh_clean_report',
    description: 'DSH-clean：查看最近一次扫描结论，或现在就跑一次扫描，或读报告前若干行。宿主侧执行，任何会话预设（含标准模式）都能用，不需要 shell。只读：不会删除任何文件。',
    parameters: {
      action: { type: 'string', description: 'status（默认，读最近结论）| scan（现在跑一次扫描）| report（读报告前 N 行）' },
      full: { type: 'boolean', description: '仅 scan：全量扫描（默认增量）' },
      lines: { type: 'number', description: '仅 report：读多少行，默认 60' },
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          summary: { type: 'string' },
          reportPath: { type: 'string' },
          reportAgeSeconds: { type: 'number' },
          reports: { type: 'number' },
          text: { type: 'string' },
        },
        required: ['ok', 'action'],
      },
      render: (_args, value) => [{ type: 'text', text: String(value.text ?? value.summary ?? '') }],
    },
    async execute(args) {
      const action = String(args.action ?? 'status')
      const install = readInstall()
      if (install === null) {
        return { ok: false, action, text: '还没装 DSH-clean：先运行 dsh-clean.mjs install（或问用户是否要装）。', summary: '', reportPath: '' }
      }
      if (action === 'scan') {
        try {
          const summary = await runScan(install, args.full === true)
          const st = statusText(install)
          const path2 = st.reportPath ?? latestReport(install.stateDir)?.path ?? ''
          return {
            ok: true, action, summary, reportPath: path2, reports: st.reports ?? 0,
            text: [summary, '报告：' + path2, '（本轮是现在跑的真扫描）'].join('\n'),
          }
        } catch (error) {
          return { ok: false, action, summary: '', reportPath: '', text: '扫描失败：' + (error?.message ?? String(error)) }
        }
      }
      if (action === 'report') {
        const rep = latestReport(install.stateDir)
        if (rep === null) return { ok: false, action, text: '还没有报告：先 action="scan"。', summary: '', reportPath: '' }
        const limit = Number(args.lines ?? 60) || 60
        return {
          ok: true, action, reportPath: rep.path, reports: rep.count,
          text: reportHead(rep.path, limit),
          summary: '最新报告 ' + rep.id + '（' + ageText(Date.now() - rep.mtimeMs) + '）',
        }
      }
      const st = statusText(install)
      return {
        ok: st.ok === true, action: 'status', summary: st.summary ?? '',
        reportPath: st.reportPath ?? '', reportAgeSeconds: st.reportAgeSeconds ?? 0,
        reports: st.reports ?? 0,
        text: [st.summary ?? '', ...(st.notes ?? []), st.reportPath ? '报告：' + st.reportPath : '']
          .filter((l) => l !== '').join('\n'),
      }
    },
  }))
}
