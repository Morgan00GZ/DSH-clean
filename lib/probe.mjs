import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { readJson, writeJsonAtomic } from "./util.mjs";

/**
 * 已知根之外的相关目录探测（证据制，不靠猜）。
 *
 * dsh-clean 原先只认识固定位置（安装目录、~/.dsh、AppData\@deepseek-ai、更新缓存、工作区），
 * 名字里带 dsh/deepseek/harness 的也会被顺手捞到。但插件往别处写数据时（例如 ~/.mnemon、
 * ~/.agent-helm）名字里什么都没有，就漏了。
 *
 * 这里改成找证据：
 *   1) 内容特征：目录里有 cordis.yml / .dsh / resources\app.asar —— 只可能是 DSH 相关
 *   2) 插件代码里点过名：已装插件的入口文件里出现 ".某目录名" —— 说明这个目录是那个插件建的
 *   3) 目录名与已装插件同名 —— pnpm 包的常见做法（包 dsh-x 的数据目录就叫 dsh-x）
 * 有证据的纳入扫描，弱证据的只在报告里列「疑似」，没证据的不提。
 *
 * 免重复计算：插件代码只扫一遍，结果按「已装插件版本签名」缓存在 state/probe-cache.json，
 * 插件没变时下次直接读缓存，不再读任何文件。
 */
const HOME = os.homedir();
const LOCAL = process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local");
const ROAM = process.env.APPDATA || path.join(HOME, "AppData", "Roaming");
const PROGRAMDATA = process.env.ProgramData || "C:\\ProgramData";

const CACHE_SCHEMA = 1;
const BUDGET_BYTES = 160 * 1024 * 1024;
const MAX_FILE = 4 * 1024 * 1024;
const ENTRY_RE = /^(?:index|main|cli|paths?|store|state|config|consts?|env)\.(?:m?js|cjs)$/i;
const MARKERS = [["cordis.yml", "cordis.yml"], ["cordis.patch.yml", "cordis.patch.yml"], [".dsh", ".dsh"], [path.join("resources", "app.asar"), "resources\\app.asar"]];

// 名字太普通、容易误中的，不当作线索
const STOP = new Set(["cache", "caches", "config", "data", "temp", "tmp", "logs", "log", "lib", "bin", "docs", "test", "tests", "store", "state", "skills", "workspace", "workspaces", "node_modules", "packages", "public", "assets", "dist", "build", "src", "app", "apps", "backup", "backups"]);

// 一眼就知道跟 DSH 无关的系统目录，不读特征文件（省时间）
const SYSTEM_SKIP = new Set([
  "AppData", "Application Data", "Contacts", "Desktop", "Documents", "Downloads", "Favorites", "Links",
  "Music", "OneDrive", "Pictures", "Saved Games", "Searches", "Videos", "3D Objects", "PrintHood", "SendTo",
  "Intel", "Microsoft", "MicrosoftEdge", "Packages", "Programs", "Temp", "CrashDumps", "D3DSCache",
  "ConnectedDevicesPlatform", "Comms", "Publishers", "Backup", "AMD", "NVIDIA", "NVIDIA Corporation", "NRC",
  "Sentry", "pip", "pipx", "uv", "npm", "npm-cache", "pnpm", "pnpm-cache", "pnpm-state", "node_modules",
  "Windows", "WindowsPowerShell", "IntuneManagementExtension", "TuringShield", ".cache", ".config", ".local",
  ".ssh", ".npm", "Crashpad", "Dictionaries", "GroupPolicy", "IconCache", "Identities", "Package Cache",
  "PlaceholderTileLogoFolder", "Places", "PPCR", "Staged", "TileDataLayer", "VirtualStore", "WinX",
]);

function listDirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(dir, d.name)); }
  catch { return []; }
}

function insideKnown(dir, knownKeys) {
  const key = path.resolve(dir).toLowerCase();
  return knownKeys.some((k) => key === k || key.startsWith(k + "\\") || k.startsWith(key + "\\"));
}

function contentMarker(dir) {
  for (const [rel, label] of MARKERS) {
    try { if (fs.existsSync(path.join(dir, rel))) return label; } catch { /* 忽略 */ }
  }
  return "";
}

function norm(s) {
  return String(s).toLowerCase().replace(/^@[^/]+\//, "").replace(/[^a-z0-9]/g, "");
}

export function installedPlugins(dataRootPath) {
  const out = new Map();
  if (!dataRootPath) return out;
  let profiles = [];
  try { profiles = fs.readdirSync(path.join(dataRootPath, "profiles"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return out; }
  for (const p of profiles) {
    const nm = path.join(dataRootPath, "profiles", p, "node_modules");
    let entries = [];
    try { entries = fs.readdirSync(nm, { withFileTypes: true }); } catch { continue; }
    for (const de of entries) {
      if (de.name.startsWith(".")) continue;
      const names = de.name.startsWith("@")
        ? (() => { try { return fs.readdirSync(path.join(nm, de.name), { withFileTypes: true }).map((d) => de.name + "/" + d.name); } catch { return []; } })()
        : [de.name];
      for (const name of names) {
        if (out.has(name)) continue;
        let version = "";
        try { version = JSON.parse(fs.readFileSync(path.join(nm, name, "package.json"), "utf8")).version || ""; } catch { /* 跳过 */ }
        out.set(name, version);
      }
    }
  }
  return out;
}

function signature(installed) {
  const text = [...installed.entries()].map(([n, v]) => n + "@" + v).sort().join("|");
  return crypto.createHash("sha1").update(text).digest("hex").slice(0, 16);
}

function entryFiles(pkgDir, budget) {
  const out = [];
  const stack = [{ dir: pkgDir, depth: 0 }];
  while (stack.length) {
    const cur = stack.pop();
    let ents = [];
    try { ents = fs.readdirSync(cur.dir, { withFileTypes: true }); } catch { continue; }
    for (const de of ents) {
      const p = path.join(cur.dir, de.name);
      if (de.isDirectory()) { if (cur.depth < 2 && de.name !== "node_modules") stack.push({ dir: p, depth: cur.depth + 1 }); continue; }
      if (!de.isFile()) continue;
      if (!(ENTRY_RE.test(de.name) || de.name === "package.json" || de.name === "cordis.yml")) continue;
      let st;
      try { st = fs.statSync(p); } catch { continue; }
      if (!st.size || st.size > MAX_FILE) continue;
      if (budget.left - st.size < 0) continue;
      budget.left -= st.size;
      out.push(p);
    }
  }
  return out;
}

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** 在已装插件的入口文件里，一次性查找所有候选名字，返回 名字 -> 插件名 */
function scanMentions({ installed, dataRootPath, names }) {
  const hits = new Map();
  if (!names.length) return hits;
  const re = new RegExp("[\\\\/\x27\"]\\.?(" + names.map(escapeRe).join("|") + ")(?=[\\\\/\x27\")])", "gi");
  const budget = { left: BUDGET_BYTES };
  const profiles = (() => { try { return fs.readdirSync(path.join(dataRootPath, "profiles"), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; } })();
  outer: for (const prof of profiles) {
    const nm = path.join(dataRootPath, "profiles", prof, "node_modules");
    for (const pkg of installed.keys()) {
      const dir = path.join(nm, pkg);
      let isDir = false;
      try { isDir = fs.statSync(dir).isDirectory(); } catch { isDir = false; }
      if (!isDir) continue;
      for (const file of entryFiles(dir, budget)) {
        if (budget.left <= 0) break outer;
        let text = "";
        try { text = fs.readFileSync(file, "utf8"); } catch { continue; }
        if (text.length > MAX_FILE) continue;
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text))) {
          const name = m[1].toLowerCase();
          if (!hits.has(name)) hits.set(name, pkg);
        }
      }
    }
  }
  return hits;
}

export function probeRelated({ roots, stateDir, dataRootPath }) {
  const knownKeys = roots.map((r) => path.resolve(r.path).toLowerCase());
  const installed = installedPlugins(dataRootPath);
  const sig = signature(installed);
  const cachePath = path.join(stateDir, "probe-cache.json");
  const cache = readJson(cachePath, null) || { schema: CACHE_SCHEMA, sig: "", names: {} };
  if (!cache.names) cache.names = {};
  const cacheValid = cache.sig === sig && cache.schema === CACHE_SCHEMA;

  const bases = [HOME, ROAM, LOCAL, PROGRAMDATA].filter(Boolean);
  const cands = [];
  for (const base of bases) {
    for (const dir of listDirs(base)) {
      const name = path.basename(dir);
      if (SYSTEM_SKIP.has(name)) continue;
      if (insideKnown(dir, knownKeys)) continue;
      cands.push({ dir, name });
    }
  }

  const byNorm = new Map();
  for (const [name] of installed) byNorm.set(norm(name), name);

  // 需要查代码的名字：有缓存就用缓存，否则攒起来一次扫完
  const wantScan = [];
  const mention = new Map();
  for (const c of cands) {
    const bare = c.name.replace(/^[.]/, "");
    if (bare.length < 4 || STOP.has(bare.toLowerCase())) continue;
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(bare)) continue;
    const key = c.name.toLowerCase();
    if (cacheValid && Object.prototype.hasOwnProperty.call(cache.names, key)) {
      const hit = cache.names[key];
      if (hit && hit.owner) mention.set(key, hit.owner);
      continue;
    }
    wantScan.push(bare);
  }
  if (wantScan.length) {
    const scanned = scanMentions({ installed, dataRootPath, names: [...new Set(wantScan)] });
    for (const c of cands) {
      const bare = c.name.replace(/^[.]/, "");
      if (bare.length < 4 || STOP.has(bare.toLowerCase())) continue;
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(bare)) continue;
      const key = c.name.toLowerCase();
      const owner = scanned.get(bare.toLowerCase()) || null;
      cache.names[key] = { owner, at: Date.now() };
      if (owner) mention.set(key, owner);
    }
    cache.sig = sig;
    cache.schema = CACHE_SCHEMA;
    writeJsonAtomic(cachePath, cache);
  }

  const extraRoots = [];
  const suspects = [];
  for (const c of cands) {
    const key = c.name.toLowerCase();
    const bare = c.name.replace(/^[.]/, "");
    const evidence = [];
    const marker = contentMarker(c.dir);
    if (marker) evidence.push("目录里有 " + marker);
    const owner = mention.get(key) || byNorm.get(norm(bare)) || "";
    if (owner) evidence.push("由插件 " + owner + " 使用");
    if (/dsh|deepseek|harness/i.test(c.name)) evidence.push("名字含 dsh/deepseek/harness");
    const strong = Boolean(marker) || Boolean(owner);
    const slug = c.name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 24);
    if (strong) {
      extraRoots.push({
        id: "probe:" + slug, kind: "related", path: path.resolve(c.dir), source: owner ? "probe:plugin" : "probe:content",
        confidence: "medium", label: owner ? c.name + "（插件 " + owner + " 的数据目录）" : c.name,
        evidence,
      });
    } else if (evidence.length) {
      suspects.push({ path: path.resolve(c.dir), name: c.name, evidence });
    }
  }

  return { extraRoots, suspects, installed: installed.size, cacheHit: cacheValid && !wantScan.length };
}
