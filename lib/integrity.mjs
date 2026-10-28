/**
 * 上游校验：给安装目录存一份「本机首次信任」的哈希基线，之后每次只比 mtime+大小，
 * 只有对不上才真正去算哈希。
 *
 * 为什么要这样：安装目录约 7,800 个文件 / 1GB，全量算 sha256 大约 3-5 秒。
 * 每次扫都算太浪费，而只看 mtime 又会被「改了内容但把时间戳改回去」骗过去。
 * 折中：第一次建基线时全量算一次，之后用 mtime+大小当闸门 —— 平时零哈希、零额外 IO
 * （扫描本来就要 walk 一遍拿 mtime），一旦时间戳或大小变了才去哈希确认。
 *
 * 诚实说明：这是「本机首次信任」，不是官方签名。它的价值在于「从我装上那天起有没有被
 * 换过」。要和官方源文件对账，用 --upstream（解包后的安装包目录）或 --installer（自动
 * 用 7-Zip 解包），那条路径才是真正的上游比对。
 */
import nodeFs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readJson, writeJsonAtomic, ensureDir } from "./util.mjs";
import { SCHEMA } from "./version.mjs";

/**
 * 和 walk.mjs 同样的坑：Electron 下 node:fs 会把 .asar 当归档，open 直接 ENOENT。
 * 算 app.asar 的哈希必须走 original-fs，否则会以为「这个文件读不了」而漏进基线。
 */
function pickFs() {
  try {
    const require = createRequire(import.meta.url);
    const ofs = require("original-fs");
    if (ofs && typeof ofs.existsSync === "function") return ofs;
  } catch { /* 普通 node 环境没有 original-fs */ }
  return nodeFs;
}

const fs = pickFs();

const SKIP_UPSTREAM = /^(\$PLUGINSDIR|\$TEMP)(\\|$)/i;
const PKG_ARTIFACT = /\.(7z|zip|nsis)$/i;

export function baselinePath(stateDir) { return path.join(stateDir, "baseline.json"); }

export function hashFile(abs) {
  try {
    const h = crypto.createHash("sha256");
    const fd = fs.openSync(abs, "r");
    try {
      const buf = Buffer.allocUnsafe(1 << 20);
      let n;
      while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
    } finally { fs.closeSync(fd); }
    return h.digest("base64url");
  } catch { return null; }
}

function pack(size, mtime, hash) { return size + "|" + hash + "|" + mtime; }

function unpack(v) {
  const i = String(v).split("|");
  return { size: Number(i[0]) || 0, hash: i[1] || "", mtime: Number(i[2]) || 0 };
}

export function loadBaseline(stateDir) {
  const doc = readJson(baselinePath(stateDir), null);
  if (!doc || !doc.files || typeof doc.files !== "object") return null;
  return doc;
}

/** 用一次 walk 的结果建基线（全量哈希，只在没有基线 / 明确 --rebase 时调用）。 */
function mtimeOf(entry) {
  const ms = entry[5];
  return typeof ms === "number" ? Math.floor(ms) : Math.floor((entry[2] || 0) * 1000);
}

export function buildBaseline({ stateDir, installDir, entries, dshVersion, source }) {
  const files = {};
  let hashed = 0;
  let failed = 0;
  for (const e of entries) {
    const [rel, size] = e;
    const abs = path.join(installDir, rel.split("/").join(path.sep));
    const h = hashFile(abs);
    if (!h) { failed += 1; continue; }
    files[rel] = pack(size, mtimeOf(e), h);
    hashed += 1;
  }
  const doc = {
    schema: SCHEMA,
    source: source || "tofu",
    installPath: installDir,
    dshVersion: dshVersion || "",
    createdAt: Date.now(),
    count: hashed,
    failed,
    files,
  };
  writeJsonAtomic(baselinePath(stateDir), doc);
  return doc;
}

/**
 * 比对一次 walk 结果与基线。
 * status: ok | drift | no-baseline | version-changed
 */
export function verifyAgainstBaseline({ stateDir, installDir, entries, dshVersion, hashBudget }) {
  const doc = loadBaseline(stateDir);
  if (!doc) return { status: "no-baseline", added: [], modified: [], touched: [], removed: [], hashed: 0, capped: false };

  const budget = hashBudget || 5000;
  const base = doc.files;
  const out = { status: "ok", baseline: { source: doc.source, createdAt: doc.createdAt, count: doc.count, dshVersion: doc.dshVersion }, added: [], modified: [], touched: [], removed: [], hashed: 0, capped: false };

  const versionChanged = Boolean(dshVersion && doc.dshVersion && dshVersion !== doc.dshVersion);

  const seen = new Set();
  for (const e of entries) {
    const [rel, size] = e;
    const mtime = mtimeOf(e);
    seen.add(rel);
    const raw = base[rel];
    if (raw === undefined) { out.added.push({ rel, size }); continue; }
    const b = unpack(raw);
    if (b.size === size && b.mtime === mtime) continue; // 闸门：时间与大小都没变，不算
    if (out.hashed >= budget) { out.capped = true; continue; }
    const abs = path.join(installDir, rel.split("/").join(path.sep));
    const h = hashFile(abs);
    out.hashed += 1;
    if (!h) { out.modified.push({ rel, size, reason: "unreadable" }); continue; }
    if (h === b.hash) out.touched.push({ rel, size });
    else out.modified.push({ rel, size });
  }
  for (const rel of Object.keys(base)) if (!seen.has(rel)) out.removed.push({ rel });

  if (out.added.length || out.modified.length || out.removed.length) out.status = versionChanged ? "version-changed" : "drift";
  else if (versionChanged) out.status = "version-changed";
  return out;
}

export function driftCountOf(integrity) {
  if (!integrity) return 0;
  return (integrity.added || []).length + (integrity.modified || []).length + (integrity.removed || []).length;
}

// ---- 上游比对：解包官方安装包，逐文件对账 --------------------------------

export function findSevenZip() {
  const cands = [];
  const envs = process.env || {};
  if (envs.ProgramFiles) cands.push(path.join(envs.ProgramFiles, "7-Zip", "7z.exe"));
  if (envs["ProgramFiles(x86)"]) cands.push(path.join(envs["ProgramFiles(x86)"], "7-Zip", "7z.exe"));
  if (envs.LOCALAPPDATA) cands.push(path.join(envs.LOCALAPPDATA, "Programs", "7-Zip", "7z.exe"));
  cands.push("C:\\Program Files\\7-Zip\\7z.exe", "C:\\Program Files (x86)\\7-Zip\\7z.exe");
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch { /* 忽略 */ } }
  const probe = spawnSync("7z.exe", ["i"], { encoding: "utf8" });
  if (probe && probe.status === 0) return "7z.exe";
  return null;
}

function run7z(exe, args, cwd) {
  const r = spawnSync(exe, args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (!r || r.error) return { ok: false, error: String((r && r.error && r.error.message) || "无法启动 7-Zip") };
  if (r.status !== 0) return { ok: false, error: ((r.stderr || "") + (r.stdout || "")).split(/\r?\n/).filter(Boolean).slice(-3).join(" / ") || ("7-Zip 退出码 " + r.status) };
  return { ok: true };
}

function listFiles(dir, baseDir, out, includeAll) {
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    const abs = path.join(dir, it.name);
    const rel = path.relative(baseDir, abs).split(path.sep).join("/");
    if (!includeAll && SKIP_UPSTREAM.test(rel)) continue;
    if (it.isDirectory()) listFiles(abs, baseDir, out, includeAll);
    else out.push({ rel, abs });
  }
  return out;
}

/** 解包安装包（NSIS exe 里通常还套一层 app-64.7z，最多解三轮）。 */
export function extractInstaller(exePath, workDir) {
  const sevenZip = findSevenZip();
  if (!sevenZip) return { ok: false, reason: "no-7zip" };
  const root = path.join(workDir, "upstream-" + Date.now());
  ensureDir(root);
  const first = run7z(sevenZip, ["x", "-y", "-o" + root, exePath], root);
  if (!first.ok) return { ok: false, reason: "extract-failed", error: first.error, root };

  let round = 0;
  while (round < 3) {
    // 内层包往往放在 $PLUGINSDIR 下（electron-builder 的 app-64.7z），找归档时不能按 SKIP_UPSTREAM 过滤
    const archives = listFiles(root, root, [], true).filter((f) => PKG_ARTIFACT.test(f.rel));
    if (!archives.length) break;
    for (const a of archives) {
      const target = a.abs.replace(/\.[^.]+$/, "") + "-x";
      ensureDir(target); // spawnSync 的 cwd 必须先存在，否则 Windows 上报 ENOENT
      const r = run7z(sevenZip, ["x", "-y", "-o" + target, a.abs], target);
      if (!r.ok) return { ok: false, reason: "nested-extract-failed", error: r.error, root };
      try { fs.unlinkSync(a.abs); } catch { /* 留着也无妨 */ }
    }
    round += 1;
  }
  const appRoot = findAppRoot(root);
  return { ok: true, sevenZip, root, appRoot, rounds: round };
}

/** 从解包根里找真正的应用载荷目录。可靠信号是顶层就有主程序 exe（electron 应用根）；
 * 万一没有 exe（如 mac dmg），退而用「顶层直接是 app.asar 文件」的目录。
 * 注意不能把「含 resources 子目录」当信号——resources 目录下也有 app.asar，会误定位到它。 */
function findAppRoot(root) {
  const exeDirs = [];
  const asarDirs = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let hasExe = false;
    let hasAsar = false;
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) {
      if (n === "DeepSeek Harness.exe" || n === "app.exe" || n === "DSH.exe") hasExe = true;
      else if (n === "app.asar") hasAsar = true;
    }
    if (hasExe) exeDirs.push(dir);
    else if (hasAsar) asarDirs.push(dir); // 只有不含 exe 的层才用 app.asar 兜底
    for (const n of names) {
      const abs = path.join(dir, n);
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      if (st.isDirectory()) stack.push(abs);
    }
  }
  const pool = exeDirs.length ? exeDirs : (asarDirs.length ? asarDirs : []);
  if (!pool.length) return root;
  pool.sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);
  return pool[0];
}

function hashTree(dir) {
  const map = new Map();
  for (const f of listFiles(dir, dir, [])) {
    if (PKG_ARTIFACT.test(f.rel)) continue;
    const h = hashFile(f.abs);
    if (h) map.set(f.rel, h);
  }
  return map;
}

/**
 * 上游目录 vs 本机安装目录。
 * 本机一侧优先用基线里已有的哈希（省一次 1GB 读），没有基线才现算。
 */
export function compareUpstream({ upstreamDir, installDir, baseline, entries }) {
  const up = hashTree(upstreamDir);
  const local = new Map();
  if (baseline && baseline.files) {
    for (const [rel, raw] of Object.entries(baseline.files)) local.set(rel, unpack(raw).hash);
  } else {
    for (const [rel] of entries) {
      const h = hashFile(path.join(installDir, rel.split("/").join(path.sep)));
      if (h) local.set(rel, h);
    }
  }

  const same = [];
  const differ = [];
  const onlyUpstream = [];
  const onlyLocal = [];
  for (const [rel, h] of up) {
    if (!local.has(rel)) { onlyUpstream.push(rel); continue; }
    if (local.get(rel) === h) same.push(rel);
    else differ.push(rel);
  }
  for (const rel of local.keys()) if (!up.has(rel)) onlyLocal.push(rel);
  return { upstreamFiles: up.size, localFiles: local.size, same, differ, onlyUpstream, onlyLocal };
}
