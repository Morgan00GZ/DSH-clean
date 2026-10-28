import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * 插件基线 = pnpm 的文件仓库（store）。
 *
 * pnpm 不往包里复制文件，而是把每个文件在仓库里存一份（按内容哈希命名），再给包里的文件做硬链接。
 *   - 没被动过 → 仍链着仓库 → nlink >= 2
 *   - 被改过/换过 → 链接断开 → nlink === 1
 * 对 nlink === 1 的少数文件，再算 sha512 去仓库里查：
 *   - 查到  → 内容仍是原件（被复制/重写过，比如备份）
 *   - 查不到 → 内容不是 pnpm 装进来的
 * 另外用锁文件对账：装了什么、声明了什么、有没有孤儿与版本不符。
 */
const PKG_A = /^profiles\/[^/]+\/node_modules\/((?:@[^/]+\/)?[^/]+)\//;
const PKG_B = /^profiles\/[^/]+\/node_modules\/\.pnpm\/([^/@]+)[^/]*\/node_modules\/((?:@[^/]+\/)?[^/]+)\//;
const SKIP_TOP = new Set([".bin", ".pnpm", ".modules.yaml", ".pnpm-workspace-state-v1.json", "lock.yaml"]);
const HARD = /\.(bak|orig|rej)$|-\.bak$|\.bak-\d{4}/i;

function packageOf(rel) {
  const b = rel.match(PKG_B);
  if (b) return b[2];
  const a = rel.match(PKG_A);
  if (a && !SKIP_TOP.has(a[1]) && !a[1].startsWith(".")) return a[1];
  return null;
}

function readStoreDir(profileDir) {
  try {
    const text = fs.readFileSync(path.join(profileDir, "node_modules", ".modules.yaml"), "utf8");
    const m = text.match(/"storeDir"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) return m[1].replace(/\\\\/g, "\\");
  } catch { /* 没有就算了 */ }
  return "";
}

function inStore(storeDir, absPath) {
  try {
    const hex = crypto.createHash("sha512").update(fs.readFileSync(absPath)).digest("hex");
    return fs.existsSync(path.join(storeDir, "files", hex.slice(0, 2), hex.slice(2)));
  } catch { return false; }
}

function splitNameVersion(key) {
  const at = key.lastIndexOf("@");
  if (at <= 0) return null;
  return { name: key.slice(0, at), version: key.slice(at + 1) };
}

function parseLock(profileDir) {
  const candidates = [path.join(profileDir, "pnpm-lock.yaml"), path.join(profileDir, "node_modules", ".pnpm", "lock.yaml")];
  let lines = null;
  for (const p of candidates) {
    try { lines = fs.readFileSync(p, "utf8").split(/\r?\n/); break; } catch { /* 试下一个 */ }
  }
  const names = new Map();
  if (!lines) return names;
  let inSection = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^\S/.test(line)) { inSection = /^(packages|snapshots):$/.test(line); continue; }
    if (!inSection) continue;
    const m = line.match(/^  '?([^'\s:]+)'?:$/);
    if (!m) continue;
    const nv = splitNameVersion(m[1]);
    if (!nv) continue;
    if (!names.has(nv.name)) names.set(nv.name, new Set());
    names.get(nv.name).add(nv.version.replace(/\(.*$/, ""));
  }
  return names;
}

function parseDirect(profileDir) {
  const candidates = [path.join(profileDir, "pnpm-lock.yaml"), path.join(profileDir, "node_modules", ".pnpm", "lock.yaml")];
  let lines = null;
  for (const cand of candidates) {
    try { lines = fs.readFileSync(cand, "utf8").split(/\r?\n/); break; } catch { /* 试下一个 */ }
  }
  const direct = new Set();
  if (!lines) return direct;
  let inImporters = false;
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    if (/^\S/.test(line)) { inImporters = line === "importers:"; continue; }
    if (!inImporters) continue;
    const m = line.match(/^      '?([^'\s:]+)'?:$/);
    if (!m) continue;
    if (/^(dependencies|devDependencies|optionalDependencies)$/.test(m[1])) continue;
    direct.add(m[1]);
  }
  return direct;
}

function installedVersions(profileDir) {
  const nm = path.join(profileDir, "node_modules");
  const out = new Map();
  let names = [];
  try { names = fs.readdirSync(nm, { withFileTypes: true }); } catch { return out; }
  for (const de of names) {
    if (de.name.startsWith(".")) continue;
    if (!de.isDirectory() && !de.isSymbolicLink()) continue;
    const entries = de.name.startsWith("@")
      ? (() => { try { return fs.readdirSync(path.join(nm, de.name), { withFileTypes: true }).map((d) => de.name + "/" + d.name); } catch { return []; } })()
      : [de.name];
    for (const name of entries) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(nm, name, "package.json"), "utf8"));
        out.set(name, pkg.version || "");
      } catch { /* 跳过 */ }
    }
  }
  return out;
}

export function storeDirOf(dataRootPath) {
  if (!dataRootPath) return "";
  return readStoreDir(path.join(dataRootPath, "profiles", "desktop"));
}

export function analyzePlugins({ roots, snapshots, accepted }) {
  const dataRoot = roots.find((r) => r.kind === "data");
  const out = {
    packages: 0, files: 0, linked: 0, modified: [], added: [], known: [], storeUsable: false, storeDir: "", copyMode: false,
    lock: { declared: 0, direct: 0, installed: 0, orphans: [], missing: [], mismatched: [] },
  };
  if (!dataRoot || !snapshots[dataRoot.id]) return out;

  const entries = snapshots[dataRoot.id].entries;
  const profileDir = path.join(dataRoot.path, "profiles", "desktop");
  const storeDir = readStoreDir(profileDir);
  out.storeDir = storeDir;
  out.storeUsable = Boolean(storeDir) && fs.existsSync(path.join(storeDir, "files"));

  const byPkg = new Map();
  for (const e of entries) {
    const pkg = packageOf(e[0]);
    if (!pkg) continue;
    if (!byPkg.has(pkg)) byPkg.set(pkg, []);
    byPkg.get(pkg).push(e);
  }
  out.packages = byPkg.size;

  for (const [pkg, list] of byPkg) {
    out.files += list.length;
    const singles = list.filter((e) => (e[4] || 1) === 1);
    out.linked += list.length - singles.length;
    if (!singles.length) continue;
    const localCopy = list.length >= 5 && singles.length > list.length * 0.5;
    if (localCopy) out.copyMode = true;

    for (const [rel, size] of singles) {
      const abs = path.join(dataRoot.path, rel);
      const baseName = rel.slice(rel.lastIndexOf("/") + 1);
      const shortRel = rel.slice(rel.indexOf("/node_modules/") + "/node_modules/".length + pkg.length + 1);
      const isOriginal = out.storeUsable && !localCopy ? inStore(storeDir, abs) : null;
      if (accepted && accepted.has(abs.toLowerCase())) {
        out.known.push({ pkg, rel: shortRel, size });
        continue;
      }
      if (HARD.test(baseName)) {
        out.added.push({ pkg, rel: shortRel, size, reason: isOriginal ? "备份副本（内容与仓库原件相同）" : "备份副本" });
      } else if (isOriginal === false) {
        out.modified.push({ pkg, rel: shortRel, size });
      } else if (isOriginal === true) {
        out.added.push({ pkg, rel: shortRel, size, reason: "被重写过，但内容仍是原件" });
      } else {
        out.added.push({ pkg, rel: shortRel, size, reason: "无法校验（缺少 pnpm 仓库或为复制安装）" });
      }
    }
  }

  try {
    const names = parseLock(profileDir);
    const direct = parseDirect(profileDir);
    const installed = installedVersions(profileDir);
    out.lock.declared = names.size;
    out.lock.direct = direct.size;
    out.lock.installed = installed.size;
    for (const [name, ver] of installed) {
      const versions = names.get(name);
      if (!versions) {
        if (!direct.has(name)) out.lock.orphans.push(name);
        continue;
      }
      if (ver && !versions.has(ver)) out.lock.mismatched.push({ name, declared: [...versions].join(" / "), installed: ver });
    }
    // 只对"直接依赖"报缺失：锁文件里还有别的平台的可选包，缺它们是正常的
    for (const name of direct) if (!installed.has(name)) out.lock.missing.push(name);
  } catch { /* 账本读不到就跳过 */ }

  out.driftCount = out.modified.length + out.added.length + out.lock.orphans.length + out.lock.missing.length + out.lock.mismatched.length;
  return out;
}
