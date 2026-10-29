import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ensureDir, readJson, writeJsonAtomic, shortPath } from "./util.mjs";
import { VERSION, SCHEMA } from "./version.mjs";
import { discover } from "./find-dsh.mjs";

const HOME = os.homedir();
const LOCAL = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");

export function appRoot() { return process.env.DSH_CLEAN_HOME || path.join(LOCAL, "dsh-clean"); }
export function installedAppDir() { return path.join(appRoot(), "app"); }

/**
 * 默认状态目录：安装时定下的工作区 Temp\dsh-clean（沙箱内可直接写），
 * 没有安装记录时退回当前目录，最后才是 %LOCALAPPDATA%。
 */
export function defaultStateDir() {
  if (process.env.DSH_CLEAN_STATE) return process.env.DSH_CLEAN_STATE;
  try {
    const rec = readJson(installRecordPath(), null);
    if (rec && rec.stateDir) return rec.stateDir;
  } catch { }
  return path.join(process.cwd(), "Temp", "dsh-clean");
}

/** 找到能从 .mjs 直接跑起来的 Electron 运行时（DSH 不自带 node.exe）。 */
export function resolveDesktopExe() {
  const fromEnv = process.env.DSH_CLEAN_DESKTOP_EXE || process.env.DSH_DESKTOP_NODE_EXECUTABLE || "";
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  try {
    const rec = readJson(installRecordPath(), null);
    if (rec && rec.desktopExe && fs.existsSync(rec.desktopExe)) return rec.desktopExe;
  } catch { }
  try {
    const { roots } = discover({});
    for (const r of roots) {
      if (r.kind !== "install") continue;
      const cand = path.join(r.path, "DeepSeek Harness.exe");
      if (fs.existsSync(cand)) return cand;
    }
  } catch { }
  return "";
}

/** 让 agent 一行就能跑：不经过 .cmd —— 多套一层壳，输出会被吞掉。 */
export function engineCommand(appDir) {
  const exe = resolveDesktopExe();
  const mjs = path.join(appDir, "dsh-clean.mjs").replaceAll("\\", "/");
  if (exe) return 'ELECTRON_RUN_AS_NODE=1 "' + exe.replaceAll("\\", "/") + '" "' + mjs + '"';
  return '"' + path.join(appDir, "dsh-clean.cmd") + '"';
}

function migrateState(from, to) {
  const moved = [];
  if (path.resolve(from) === path.resolve(to)) return moved;
  try { ensureDir(to); } catch { return moved; }
  for (const name of ["roots.json", "patches.json", "roster.json", "probe-cache.json", "last-run.json"]) {
    const s = path.join(from, name), d = path.join(to, name);
    try { if (fs.existsSync(s) && !fs.existsSync(d)) { fs.copyFileSync(s, d); moved.push(name); } } catch { }
  }
  for (const name of ["reports", "inventory"]) {
    const s = path.join(from, name), d = path.join(to, name);
    try { if (fs.existsSync(s) && !fs.existsSync(d)) { fs.cpSync(s, d, { recursive: true }); moved.push(name + "\\"); } } catch { }
  }
  return moved;
}
export function installRecordPath() { return path.join(appRoot(), "install.json"); }

function copyTree(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  ensureDir(dst);
  fs.cpSync(src, dst, { recursive: true });
}

export function userSkillDir(project) {
  return project
    ? path.join(process.cwd(), ".dsh", "skills", "dsh-clean")
    : path.join(HOME, ".dsh", "skills", "dsh-clean");
}

export function install({ srcDir, project = false, stateDir = null }) {
  const appDir = installedAppDir();
  ensureDir(appRoot());
  const stateDirPath = path.resolve(stateDir || path.join(process.cwd(), "Temp", "dsh-clean"));
  const migrated = migrateState(appRoot(), stateDirPath);

  copyTree(path.join(srcDir, "lib"), path.join(appDir, "lib"));
  copyTree(path.join(srcDir, "data"), path.join(appDir, "data"));
  for (const f of ["dsh-clean.mjs", "dsh-clean.cmd", "LICENSE", "README.md"]) {
    const from = path.join(srcDir, f);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(appDir, f));
  }
  // 双击即用的启动器：仓库里有哪些就装哪些，不必每次改这个清单
  try {
    for (const f of fs.readdirSync(srcDir)) {
      if (!/\.cmd$/i.test(f) || f === "dsh-clean.cmd") continue;
      fs.copyFileSync(path.join(srcDir, f), path.join(appDir, f));
    }
  } catch { }

  const skillSrc = path.join(srcDir, "skill", "SKILL.md");
  const skillDir = userSkillDir(project);
  ensureDir(skillDir);
  const cmd = engineCommand(appDir);
  const body = fs.readFileSync(skillSrc, "utf8").replaceAll("{{DSH_CLEAN_CMD}}", cmd);
  const skillPath = path.join(skillDir, "SKILL.md");
  fs.writeFileSync(skillPath, body, "utf8");

  const record = {
    schema: SCHEMA,
    version: VERSION,
    installedAt: Date.now(),
    appDir,
    skillDir,
    skillPath,
    project,
    stateDir: stateDirPath,
    desktopExe: resolveDesktopExe() || null,
    sourceRepo: srcDir,
  };
  writeJsonAtomic(installRecordPath(), record);
  ensureDir(path.join(stateDirPath, "reports"));

  return { record, lines: [
    "已安装 DSH-clean " + VERSION,
    "  程序  " + shortPath(appDir),
    "  技能  " + shortPath(skillPath),
    "  状态  " + shortPath(stateDirPath) + (migrated.length ? "（已迁移 " + migrated.join(" ") + "）" : ""),
    "",
    "下一步：重启 DSH（或刷新技能列表），在对话框里打 /dsh-clean 或说「扫一下 DSH 有没有残留」。",
    "卸载：双击 uninstall.cmd",
  ] };
}

export function uninstall({ purge = false } = {}) {
  const record = readJson(installRecordPath(), null);
  const appDir = record?.appDir || installedAppDir();
  const skillDir = record?.skillDir || userSkillDir(false);
  const lines = [];
  let code = 0;

  try {
    if (fs.existsSync(skillDir)) { fs.rmSync(skillDir, { recursive: true, force: true }); lines.push("已移除技能 " + shortPath(skillDir)); }
    else lines.push("技能目录本就不存在：" + shortPath(skillDir));
  } catch (e) { lines.push("移除技能失败：" + e.message); code = 3; }

  {
    const rec = installRecordPath();
    if (fs.existsSync(rec)) { fs.rmSync(rec, { force: true }); lines.push("已移除安装记录 install.json"); }
  }

  if (purge) {
    const stateDirs = new Set([record?.stateDir, defaultStateDir(), appRoot()].filter(Boolean));
    for (const dir of stateDirs) {
      for (const name of ["roots.json", "known.json", "last-run.json", "patches.json", "roster.json", "probe-cache.json", "sizes.json", "apply-log.jsonl"]) {
        const p = path.join(dir, name);
        if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); lines.push("已移除状态 " + shortPath(p)); }
      }
      for (const name of ["inventory", "reports"]) {
        const p = path.join(dir, name);
        if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); lines.push("已移除 " + shortPath(p) + "\\"); }
      }
    }
  } else {
    lines.push("已保留状态与历史报告（含判例库）；要一起清掉请用 --purge");
  }

  try {
    if (fs.existsSync(appDir)) { fs.rmSync(appDir, { recursive: true, force: true }); lines.push("已移除程序 " + shortPath(appDir)); }
  } catch (e) { lines.push("移除程序失败：" + e.message); code = 3; }

  if (!fs.existsSync(skillDir)) lines.push("校验：技能目录已不存在，无孤儿残留");
  else { lines.push("校验失败：技能目录仍存在"); code = 3; }

  return { lines, code };
}
