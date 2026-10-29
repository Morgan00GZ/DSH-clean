import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const HOME = os.homedir();
const isWin = process.platform === "win32";

function reg(args) {
  try {
    return execFileSync("reg", args, {
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20000,
    });
  } catch {
    return "";
  }
}

function parseValues(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const m = raw.match(/^\s{2,}([^\s].*?)\s{4}(REG_[A-Z_]+)\s{4}(.*)$/);
    if (m) out[m[1].trim()] = m[3].trim();
  }
  return out;
}

function findRegistryInstalls() {
  if (!isWin) return [];
  const hives = [
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];
  const hits = [];
  for (const hive of hives) {
    const text = reg(["query", hive, "/s", "/v", "DisplayName"]);
    if (!text) continue;
    let cur = "";
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (/^HKEY_/i.test(line)) { cur = line; continue; }
      const m = line.match(/^DisplayName\s+REG_SZ\s+(.*)$/i);
      if (m && /deepseek\s+harness/i.test(m[1]) && cur) {
        hits.push({ key: cur, displayName: m[1].trim() });
      }
    }
  }
  const out = [];
  for (const hit of hits) {
    const vals = parseValues(reg(["query", hit.key]));
    const icon = (vals.DisplayIcon || "").replace(/,\d+$/, "").trim();
    const un = (vals.UninstallString || "").replace(/^"([^"]+)".*$/, "$1").trim();
    let dir = "";
    if (icon) dir = path.dirname(icon);
    else if (un) dir = path.dirname(un);
    out.push({ dir, displayName: hit.displayName, displayVersion: vals.DisplayVersion || "", key: hit.key });
  }
  return out;
}

function looksLikeInstall(dir) {
  try {
    return fs.existsSync(path.join(dir, "resources", "app.asar")) || fs.existsSync(path.join(dir, "DeepSeek Harness.exe"));
  } catch { return false; }
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name));
  } catch { return []; }
}

function readVersion(dir) {
  try { return fs.readFileSync(path.join(dir, "version"), "utf8").trim(); } catch { return ""; }
}

function discoverPortable() {
  const out = [];
  for (const base of [path.join(HOME, "AppData", "Local")]) {
    for (const dir of listDirs(base)) {
      const name = path.basename(dir).toLowerCase();
      if (!/dsh|deepseek/.test(name)) continue;
      if (looksLikeInstall(dir)) out.push(dir);
    }
  }
  return out;
}

function discoverWorkspaces(dataRoot) {
  const out = [];
  const hist = path.join(dataRoot, "tool-management", "history-workspaces.json");
  try {
    const raw = JSON.parse(fs.readFileSync(hist, "utf8"));
    const items = raw && raw.items ? Object.values(raw.items) : [];
    for (const it of items) {
      if (it && typeof it.path === "string" && fs.existsSync(it.path)) out.push(it.path);
    }
  } catch { /* 没有就跳过 */ }
  return out;
}

/** 安装记录里存了桌面端主程序路径，省得每次重新找（旧版的 node-path.txt 已废弃）。 */
function readNodeCache() {
  const base = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(base, "dsh-clean", "install.json"), "utf8"));
    return (rec && rec.desktopExe) || "";
  } catch { return ""; }
}

const MARKERS = [".dsh", ".agents", "cordis.yml", "cordis.patch.yml", "dsh-service-config.json", "resources/app.asar"];

function looksRelated(dir, byName) {
  if (byName) return true;
  try {
    return MARKERS.some((m) => fs.existsSync(path.join(dir, m)));
  } catch { return false; }
}

function probeRelated(knownPaths) {
  const known = knownPaths.map((p) => path.resolve(p).toLowerCase());
  const bases = [
    HOME,
    path.join(HOME, "Documents"),
    path.join(HOME, "Desktop"),
    path.join(HOME, "Downloads"),
    process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local"),
    process.env.APPDATA || path.join(HOME, "AppData", "Roaming"),
    process.env.ProgramData || "C:\\ProgramData",
  ];
  for (const letter of "CDEFGHIJ".split("")) {
    const drive = letter + ":\\";
    try { if (fs.existsSync(drive)) bases.push(drive); } catch { /* 忽略 */ }
  }

  const found = [];
  for (const baseDir of bases) {
    if (!baseDir) continue;
    for (const dir of listDirs(baseDir)) {
      const key = path.resolve(dir).toLowerCase();
      if (known.some((k) => key === k || key.startsWith(k + "\\") || k.startsWith(key + "\\"))) continue;
      const name = path.basename(dir);
      const byName = /dsh|deepseek|harness/i.test(name);
      if (!byName && !looksRelated(dir, false)) continue;
      if (!looksRelated(dir, byName)) continue;
      found.push(dir);
    }
  }
  return found;
}

export function discover(opts = {}) {
  const roots = [];
  const warnings = [];
  const seen = new Set();
  const push = (r) => {
    const key = path.resolve(r.path).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    roots.push({ ...r, path: path.resolve(r.path) });
  };

  // 1) 安装目录：手动 > 启动器传入 > 缓存 > 注册表 > 默认位置
  let desktopVersion = "";
  if (opts.installDir && looksLikeInstall(opts.installDir)) {
    push({ id: "install", kind: "install", path: opts.installDir, source: "manual", confidence: "high", label: "DeepSeek Harness" });
  }
  for (const [exe, src] of [[process.env.DSH_CLEAN_DESKTOP_EXE, "launcher"], [readNodeCache(), "cache"]]) {
    if (!exe) continue;
    const dir = path.dirname(exe);
    if (looksLikeInstall(dir)) {
      push({ id: "install", kind: "install", path: dir, source: src, confidence: "high", label: "DeepSeek Harness" });
      break;
    }
  }
  const regs = findRegistryInstalls().filter((r) => r.dir && looksLikeInstall(r.dir));
  for (const r of regs) {
    if (!desktopVersion) desktopVersion = r.displayVersion;
    push({ id: "install", kind: "install", path: r.dir, source: "registry", confidence: "high", label: r.displayName });
  }
  if (!roots.some((r) => r.kind === "install")) {
    const fallbacks = [
      path.join(process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local"), "Programs", "DeepSeek Harness"),
      path.join(process.env.ProgramFiles || "C:\\Program Files", "DeepSeek Harness"),
      path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "DeepSeek Harness"),
    ];
    for (const dir of fallbacks) {
      if (looksLikeInstall(dir)) {
        push({ id: "install", kind: "install", path: dir, source: "default", confidence: "medium", label: "DeepSeek Harness" });
        break;
      }
    }
    if (!roots.some((r) => r.kind === "install")) {
      warnings.push("未找到安装目录；可用 --install-dir 指定");
    }
  }
  for (const dir of discoverPortable()) {
    push({ id: "install-portable", kind: "install", path: dir, source: "portable", confidence: "medium", label: "DSH portable" });
  }

  // 2) 用户数据
  const dataRoot = path.join(HOME, ".dsh");
  if (fs.existsSync(dataRoot)) {
    push({ id: "data", kind: "data", path: dataRoot, source: "default", confidence: "high", label: ".dsh" });
  } else {
    warnings.push("未找到用户数据目录 ~/.dsh");
  }

  // 3) AppData
  const appdata = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");
  const deepseekAppData = path.join(appdata, "@deepseek-ai");
  if (fs.existsSync(deepseekAppData)) {
    push({ id: "appdata", kind: "appdata", path: deepseekAppData, source: "default", confidence: "high", label: "Electron 用户数据" });
  }

  // 4) 更新缓存
  const local = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");
  for (const dir of listDirs(local)) {
    const name = path.basename(dir).toLowerCase();
    if (name.startsWith("@deepseek-ai")) {
      push({ id: "updater:" + name.replace(/^@deepseek-ai/, ""), kind: "cache", path: dir, source: "default", confidence: "medium", label: "更新缓存" });
    }
  }

  // 5) 工作区
  if (fs.existsSync(dataRoot)) {
    const wss = discoverWorkspaces(dataRoot);
    if (wss.length === 0) warnings.push("未从配置中解出工作区列表");
    wss.forEach((p, i) => push({ id: "workspace:" + (i + 1), kind: "workspace", path: p, source: "config", confidence: "high", label: path.basename(p) }));
  }

  // 6) 探测：名字相近 / 带 DSH 特征的其它目录
  for (const dir of probeRelated(roots.map((r) => r.path))) {
    const slug = path.basename(dir).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 24);
    push({ id: "related:" + slug, kind: "related", path: dir, source: "probe", confidence: "low", label: path.basename(dir) });
  }

  const installRoot = roots.find((r) => r.kind === "install");
  const dshVersion = installRoot ? readVersion(installRoot.path) : "";

  return {
    schema: 1,
    generatedAt: Date.now(),
    machine: {
      platform: process.platform,
      arch: process.arch,
      hostname: os.hostname(),
      dshVersion,
      desktopVersion: process.env.DSH_CLEAN_DESKTOP_VERSION || desktopVersion,
    },
    roots,
    warnings,
  };
}
