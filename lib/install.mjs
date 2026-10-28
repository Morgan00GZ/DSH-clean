import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ensureDir, readJson, writeJsonAtomic, shortPath } from "./util.mjs";
import { VERSION, SCHEMA } from "./version.mjs";

const HOME = os.homedir();
const LOCAL = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");

export function appRoot() { return process.env.DSH_CLEAN_HOME || path.join(LOCAL, "dsh-clean"); }
export function installedAppDir() { return path.join(appRoot(), "app"); }
export function defaultStateDir() { return appRoot(); }
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

export function install({ srcDir, project = false }) {
  const appDir = installedAppDir();
  ensureDir(appRoot());

  copyTree(path.join(srcDir, "lib"), path.join(appDir, "lib"));
  copyTree(path.join(srcDir, "data"), path.join(appDir, "data"));
  for (const f of ["dsh-clean.mjs", "dsh-clean.cmd", "LICENSE", "README.md"]) {
    const from = path.join(srcDir, f);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(appDir, f));
  }

  const skillSrc = path.join(srcDir, "skill", "SKILL.md");
  const skillDir = userSkillDir(project);
  ensureDir(skillDir);
  const cmd = path.join(appDir, "dsh-clean.cmd");
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
    sourceRepo: srcDir,
  };
  writeJsonAtomic(installRecordPath(), record);
  ensureDir(path.join(appRoot(), "inventory"));
  ensureDir(path.join(appRoot(), "reports"));

  return { record, lines: [
    "已安装 DSH-clean " + VERSION,
    "  程序  " + shortPath(appDir),
    "  技能  " + shortPath(skillPath),
    "  状态  " + shortPath(appRoot()),
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
    for (const name of ["roots.json", "known.json", "last-run.json", "patches.json"]) {
      const p = path.join(appRoot(), name);
      if (fs.existsSync(p)) { fs.rmSync(p, { force: true }); lines.push("已移除状态 " + name); }
    }
    for (const name of ["inventory", "reports"]) {
      const p = path.join(appRoot(), name);
      if (fs.existsSync(p)) { fs.rmSync(p, { recursive: true, force: true }); lines.push("已移除 " + name + "\\"); }
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
