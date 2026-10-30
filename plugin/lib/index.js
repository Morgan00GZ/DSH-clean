import { defineTool } from "@deepseek-ai/dsh-tools";
import path from "node:path";
import fs from "node:fs";

export const name = "dsh-clean-report";

const REPORT_RE = /^\d{8}-\d{6}$/;

function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

/** 定位状态目录：环境变量 > 安装记录 > 当前目录 Temp\dsh-clean。 */
function resolveStateDir() {
  if (process.env.DSH_CLEAN_STATE) return process.env.DSH_CLEAN_STATE;
  try {
    const local = process.env.LOCALAPPDATA || "";
    if (local) {
      const rec = readJsonSafe(path.join(local, "dsh-clean", "install.json"));
      if (rec && rec.stateDir) return rec.stateDir;
    }
  } catch { /* 忽略 */ }
  return path.join(process.cwd(), "Temp", "dsh-clean");
}

/** 最近一次报告目录路径；无报告时返回 null。 */
function latestReportDir(stateDir) {
  const reports = path.join(stateDir, "reports");
  try {
    const dirs = fs.readdirSync(reports).filter((n) => REPORT_RE.test(n)).sort();
    if (!dirs.length) return null;
    return path.join(reports, dirs[dirs.length - 1]);
  } catch { return null; }
}

/** 组装报告视图：只读，不重新扫描。 */
function buildView(args, stateDir) {
  const lastRun = readJsonSafe(path.join(stateDir, "last-run.json"));
  const dir = latestReportDir(stateDir);
  const out = {
    stateDir,
    hasReport: !!dir,
    lastRunLine: lastRun ? lastRun.line : null,
    lastRunAt: lastRun ? lastRun.at : null,
  };
  if (!dir) return { ...out, report: null };

  const run = readJsonSafe(path.join(dir, "run.json"));
  const plan = readJsonSafe(path.join(dir, "plan.json"));
  let markdown = "";
  try { markdown = fs.readFileSync(path.join(dir, "report.md"), "utf8"); } catch { }
  out.report = {
    dir: path.basename(dir),
    generatedAt: plan ? plan.generatedAt : null,
    run: run ? {
      startedAt: run.startedAt, finishedAt: run.finishedAt,
      roots: run.roots, stats: run.stats, args: run.args,
    } : null,
    planItems: plan ? plan.items : [],
    markdown,
  };
  return out;
}

function summarize(view) {
  const s = { hasReport: view.hasReport, stateDir: view.stateDir };
  if (view.lastRunLine) s.lastRunLine = view.lastRunLine;
  const r = view.report;
  if (!r) return s;
  const st = r.run?.stats || {};
  s.generatedAt = r.generatedAt;
  s.files = st.files;
  s.bytes = st.bytes;
  s.seconds = st.seconds;
  s.residue = (r.planItems || []).filter((i) => i.class === "RESIDUE").length;
  s.unknown = (r.planItems || []).filter((i) => i.class === "UNKNOWN").length;
  s.residueBytes = st.residueBytes;
  return s;
}

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: "dsh_clean_report",
    description: "读取 DSH-clean 最近一次扫描报告（只读，不重新扫描、不清理）。返回报告摘要、待清理清单与 Markdown 全文。",
    parameters: {
      section: {
        type: "string",
        description: "可选：只取报告的一段。summary / residue / folders / plugins / sessions / purity / top；省略则返回完整摘要。",
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["stateDir", "hasReport", "summary"],
        properties: {
          stateDir: { type: "string" },
          hasReport: { type: "boolean" },
          lastRunLine: { type: "string" },
          lastRunAt: { type: "number" },
          summary: { type: "object", additionalProperties: true, properties: {} },
          report: { type: "object", additionalProperties: true, properties: {} },
        },
      },
      render: (args, value) => {
        const md = value?.report?.markdown;
        if (!md) {
          return [{ type: "text", text: "DSH-clean 还没有生成过报告。先运行一次扫描（scan）再来看。\n\n状态目录：" + (value?.stateDir || "") }];
        }
        const lines = [];
        if (value?.lastRunLine) lines.push(value.lastRunLine);
        lines.push("");
        const want = args?.section;
        if (want === "summary") {
          lines.push("## 摘要");
          lines.push(JSON.stringify(value?.summary || {}, null, 2));
        } else if (want === "residue") {
          const seg = extractSection(md, "残留");
          lines.push(seg ? seg : "（报告里没有「残留」段）");
        } else if (want === "folders") {
          const seg = extractSection(md, "DSH 相关文件夹");
          lines.push(seg ? seg : "（报告里没有该段）");
        } else if (want === "plugins") {
          const seg = extractSection(md, "插件包");
          lines.push(seg ? seg : "（报告里没有该段）");
        } else if (want === "sessions") {
          const seg = extractSection(md, "会话");
          lines.push(seg ? seg : "（报告里没有该段）");
        } else if (want === "purity") {
          const seg = extractSection(md, "纯净度");
          lines.push(seg ? seg : "（报告里没有该段）");
        } else {
          lines.push("## 残留与待确认");
          const res = extractSection(md, "残留");
          if (res) lines.push(res);
          const unk = extractSection(md, "未归类");
          if (unk) lines.push(unk);
          lines.push("");
          lines.push("（完整报告见 report.md；用 --section=<段> 取指定段落）");
        }
        return [{ type: "text", text: lines.join("\n") }];
      },
    },
    async execute(args) {
      const stateDir = resolveStateDir();
      const view = buildView(args, stateDir);
      return {
        stateDir,
        hasReport: view.hasReport,
        lastRunLine: view.lastRunLine ?? null,
        lastRunAt: view.lastRunAt ?? null,
        summary: summarize(view),
        report: view.report,
      };
    },
  }));
}

/** 从 Markdown 里按二级标题取一段（到下一个同级标题为止）。 */
function extractSection(md, title) {
  const re = new RegExp("^## " + escapeRe(title) + ".*$", "m");
  const m = re.exec(md);
  if (!m) return null;
  const start = m.index;
  const next = md.indexOf("\n## ", start + 2);
  const end = next === -1 ? md.length : next;
  return md.slice(start, end).trim();
}
function escapeRe(s) { return s.replace(/[{}.*+?^$()|[\]\\]/g, "\\$&"); }
