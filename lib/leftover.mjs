import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

/**
 * 升级 / 出错遗留物检测。
 *
 * 目前只覆盖一个真实存在的类别：dsh-ops 的「受限模式 MSYS 运行时」缓存。
 *
 * 机制（见 dsh-ops/lib/bash-ipc.js）：
 *   - 受限模式（read-only / workspace-write）只允许跑「带 DSH IPC 兼容收据的固定 MSYS」。
 *   - dsh-ops 会把这份 MSYS 按 identity 缓存到 ~/.dsh/dsh-ops/bash-ipc/<identity>/，
 *     其中 identity = sha256({root, msys: receipt.msysSha256, files: receipt.files}).slice(0, 24)，
 *     完全由包内 runtime/win32-x64/bash-ipc/provenance.json 决定（收据在 dsh-ops 包，不在 @dsh-ops/bash-win32-x64）。
 *   - 每次调用 confinedBash 只会算「当前收据」对应的 identity，只选中同名缓存目录。
 *
 * 升级 / 降级 dsh-ops 后收据改变 → 新 identity 生成新缓存目录；旧 identity 目录既不被复用
 * 也不会被 dsh-ops 清理 → 成为死缓存（升级遗留物）。这正是本检测要找的。
 *
 * 判定：
 *   - 目录名 !== 目录里 .ops-ipc.json 的 identity   → 残缺 / 中断的暂存（staging 写一半）
 *   - identity 不在「当前安装的所有收据」算出的集合里 → 旧版本遗留
 */
export function bashIpcLeftovers(dataRoot, opts = {}) {
  const HOME = os.homedir();
  const cacheRoot = opts.cacheRoot || path.join(HOME, ".dsh", "dsh-ops", "bash-ipc");
  const leftovers = [];
  let current = 0;
  if (!fs.existsSync(cacheRoot)) return { leftovers, current, checked: 0, receiptMissing: false };

  // 1) 收集当前所有 dsh-ops 收据（可能有多个 profile / 版本并存）
  const profilesDir = path.join(dataRoot, "profiles");
  const receipts = [];
  for (const prof of listDirs(profilesDir)) {
    const rp = path.join(profilesDir, prof, "node_modules", "dsh-ops", "runtime", "win32-x64", "bash-ipc", "provenance.json");
    try { receipts.push({ profile: prof, receipt: JSON.parse(fs.readFileSync(rp, "utf8")) }); } catch { /* 没有就跳过 */ }
  }
  const receiptMissing = receipts.length === 0;

  // 2) 找所有 @dsh-ops/* 包里带 usr/bin/msys-2.0.dll 的包（bash 载荷），算它与收据的配对
  const bashDirs = [];
  for (const prof of listDirs(profilesDir)) {
    const nm = path.join(profilesDir, prof, "node_modules", "@dsh-ops");
    for (const sub of listDirs(nm)) {
      const pkgDir = path.join(nm, sub);
      if (fs.existsSync(path.join(pkgDir, "usr", "bin", "msys-2.0.dll"))) bashDirs.push({ profile: prof, pkgDir });
    }
  }

  // 3) 对每份收据，找 dll 哈希匹配的 bash 包 → 算当前 identity
  const currentIds = new Set();
  for (const { profile, receipt } of receipts) {
    if (receipt.platform !== "win32-x64") continue;
    const msys = String(receipt.msysSha256 || "");
    for (const b of bashDirs) {
      if (b.profile !== profile) continue;
      const dll = path.join(b.pkgDir, "usr", "bin", "msys-2.0.dll");
      let sha = "";
      try { sha = crypto.createHash("sha256").update(fs.readFileSync(dll)).digest("hex"); } catch { continue; }
      if (sha !== msys) continue;
      currentIds.add(identityOf({ root: path.resolve(b.pkgDir), msys, files: receipt.files }));
    }
  }

  // 4) 逐个缓存目录判定
  const checked = listDirs(cacheRoot).length;
  for (const name of listDirs(cacheRoot)) {
    const dir = path.join(cacheRoot, name);
    const marker = readMarker(path.join(dir, ".ops-ipc.json"));
    const id = marker && marker.identity ? String(marker.identity) : "";
    if (id && id !== name) {
      leftovers.push({ dir, name, size: dirSize(dir), files: fileCount(dir), identity: id,
        reason: "缓存目录名与内部标记的 identity 不一致，疑似暂存中断（写入一半）" });
      continue;
    }
    if (!currentIds.has(id)) {
      leftovers.push({ dir, name, size: dirSize(dir), files: fileCount(dir), identity: id,
        reason: "与当前安装的 dsh-ops 收据不匹配，是旧版本留下的死缓存（升级后不再被选中）" });
      continue;
    }
    current += 1;
  }
  return { leftovers, current, checked, receiptMissing };
}

function identityOf({ root, msys, files }) {
  const h = crypto.createHash("sha256").update(Buffer.from(JSON.stringify({ root, msys, files }))).digest("hex");
  return h.slice(0, 24);
}
function listDirs(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
}
function readMarker(p) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
function dirSize(dir) {
  let bytes = 0;
  try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) bytes += dirSize(p);
    else { try { bytes += fs.statSync(p).size; } catch { /* 忽略 */ } }
  } } catch { /* 忽略 */ }
  return bytes;
}
function fileCount(dir) {
  let n = 0;
  try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += fileCount(p);
    else n += 1;
  } } catch { /* 忽略 */ }
  return n;
}
