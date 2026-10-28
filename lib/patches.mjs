import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readJson, writeJsonAtomic } from "./util.mjs";

/**
 * 用户认可的改动（打补丁）。
 *
 * 插件包里的文件被改过，可能是：装进来时就这样、被升级覆盖、被第三方动过，也可能是用户自己改的。
 * 前三者要报，第四种不该报。这里记下「这个文件、这个哈希，是用户认可的样子」，
 * 之后每次扫描只多算一次哈希：
 *   - 哈希还对得上            → 补丁在位，不算脏
 *   - 哈希变成仓库原件        → 升级/重装把它覆盖回去了，补丁丢了（这正是要提醒的事）
 *   - 哈希变成第三种          → 又被别人改过，照常报
 * 只存哈希，不存文件内容。
 */

export function patchesPath(stateDir) { return path.join(stateDir, "patches.json"); }

export function keyOf(p) { return path.resolve(p).toLowerCase(); }

export function hashOf(abs) {
  try { return crypto.createHash("sha512").update(fs.readFileSync(abs)).digest("hex"); } catch { return null; }
}

export function loadPatches(stateDir) {
  const doc = readJson(patchesPath(stateDir), null);
  if (!doc || !Array.isArray(doc.items)) return { schema: 1, items: [] };
  return doc;
}

export function savePatches(stateDir, doc) {
  writeJsonAtomic(patchesPath(stateDir), doc);
  return doc;
}

export function acceptPatch(stateDir, absPath, note) {
  const abs = path.resolve(absPath);
  let st = null;
  try { st = fs.statSync(abs); } catch { throw new Error("文件不存在：" + abs); }
  if (!st.isFile()) throw new Error("不是文件：" + abs);
  const hex = hashOf(abs);
  if (!hex) throw new Error("读不到文件：" + abs);
  const doc = loadPatches(stateDir);
  const key = keyOf(abs);
  doc.items = doc.items.filter((x) => keyOf(x.path) !== key);
  const item = { path: abs, sha512: hex, size: st.size, note: note || "", acceptedAt: Date.now() };
  doc.items.push(item);
  savePatches(stateDir, doc);
  return item;
}

export function forgetPatch(stateDir, absPath) {
  const doc = loadPatches(stateDir);
  const key = absPath ? keyOf(absPath) : null;
  const before = doc.items.length;
  doc.items = key ? doc.items.filter((x) => keyOf(x.path) !== key) : [];
  savePatches(stateDir, doc);
  return before - doc.items.length;
}

function inStore(storeDir, hex) {
  if (!storeDir || !hex) return false;
  try { return fs.existsSync(path.join(storeDir, "files", hex.slice(0, 2), hex.slice(2))); } catch { return false; }
}

export function evaluatePatches(stateDir, storeDir) {
  const doc = loadPatches(stateDir);
  const out = { items: [], ok: new Set(), bad: [], accepted: 0 };
  for (const it of doc.items) {
    const abs = path.resolve(it.path);
    let status = "ok";
    let size = 0;
    let mtime = 0;
    try {
      const st = fs.statSync(abs);
      size = st.size;
      mtime = Math.floor(st.mtimeMs / 1000);
      const hex = hashOf(abs);
      if (hex !== it.sha512) status = inStore(storeDir, hex) ? "restored" : "changed";
    } catch { status = "missing"; }
    const rec = { path: abs, note: it.note || "", acceptedAt: it.acceptedAt, status, size, mtime };
    out.items.push(rec);
    if (status === "ok") { out.ok.add(keyOf(abs)); out.accepted += 1; } else out.bad.push(rec);
  }
  return out;
}
