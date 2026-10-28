import fs from "node:fs";
import path from "node:path";
import { readJson, writeJsonAtomic } from "./util.mjs";

const SCHEMA = 1;
const STALE_DAYS = 90;
const CLASSES = new Set(["KEEP", "CACHE", "RESIDUE", "UNKNOWN"]);

export function knownPath(stateDir) { return path.join(stateDir, "known.json"); }

export function loadKnown(stateDir) {
  const doc = readJson(knownPath(stateDir), null);
  if (!doc || typeof doc !== "object") return { schema: SCHEMA, judged: {}, files: {} };
  return { schema: doc.schema || SCHEMA, judged: doc.judged || {}, files: doc.files || {} };
}

export function saveKnown(stateDir, doc) {
  writeJsonAtomic(knownPath(stateDir), {
    schema: SCHEMA, updatedAt: Date.now(),
    judged: doc.judged || {}, files: doc.files || {},
  });
}

/** 记一条判例。level=container 只记顶层目录名；level=file 记到具体文件。 */
export function recordJudgment(stateDir, item) {
  const cls = String(item.class || "").toUpperCase();
  if (!CLASSES.has(cls)) throw new Error("判定只能是 KEEP / CACHE / RESIDUE / UNKNOWN");
  const doc = loadKnown(stateDir);
  const rel = item.rel.split("/").filter(Boolean).join("/");
  const now = Date.now();
  const entry = {
    class: cls, owner: item.owner || "", tier: item.tier || "",
    reason: item.reason || "", at: now, lastSeen: now,
  };
  let key;
  if (item.level === "container") {
    key = item.rootId + ":" + rel.split("/")[0];
    doc.judged[key] = entry;
  } else {
    key = item.rootId + ":" + rel;
    doc.files[key] = entry;
  }
  saveKnown(stateDir, doc);
  return { key, entry };
}

/** 撤销判例：给 item 删一条，item 为空则全删。返回删掉的条数。 */
export function forgetJudgment(stateDir, item) {
  const doc = loadKnown(stateDir);
  let n = 0;
  if (item && item.level === "container") {
    const k = item.rootId + ":" + item.rel.split("/")[0];
    if (doc.judged[k]) { delete doc.judged[k]; n += 1; }
  } else if (item) {
    const k = item.rootId + ":" + item.rel;
    if (doc.files[k]) { delete doc.files[k]; n += 1; }
  } else {
    n = Object.keys(doc.judged).length + Object.keys(doc.files).length;
    doc.judged = {};
    doc.files = {};
  }
  if (n) saveKnown(stateDir, doc);
  return n;
}

/** 每次扫描顺手续命：还在的判例刷新 lastSeen；消失超过 90 天的标 stale。 */
export function touchKnown(stateDir, doc, opts) {
  const now = Date.now();
  const presentContainers = opts.presentContainers || new Set();
  const rootsById = opts.rootsById || new Map();
  let changed = false;
  const visit = (bucket, key, level) => {
    const e = bucket[key];
    if (!e) return;
    const at = key.indexOf(":");
    const rootId = key.slice(0, at);
    const rel = key.slice(at + 1);
    let exists = false;
    if (level === "container") exists = presentContainers.has(key);
    else {
      const base = rootsById.get(rootId);
      if (base) { try { exists = fs.existsSync(path.join(base, rel.split("/").join(path.sep))); } catch { exists = false; } }
    }
    if (exists) {
      if (!e.lastSeen || now - e.lastSeen > 60000) { e.lastSeen = now; changed = true; }
      if (e.stale) { delete e.stale; changed = true; }
    } else if (!e.stale && e.lastSeen && now - e.lastSeen > STALE_DAYS * 86400000) {
      e.stale = true;
      changed = true;
    }
  };
  for (const k of Object.keys(doc.judged)) visit(doc.judged, k, "container");
  for (const k of Object.keys(doc.files)) visit(doc.files, k, "file");
  if (changed) saveKnown(stateDir, doc);
  return doc;
}

/** 报告用的扁平视图。 */
export function knownSummary(doc) {
  const list = [];
  const push = (bucket, level) => {
    for (const key of Object.keys(bucket)) {
      const e = bucket[key];
      const at = key.indexOf(":");
      list.push({
        key, level, rootId: key.slice(0, at), rel: key.slice(at + 1),
        class: e.class, owner: e.owner || "", tier: e.tier || "",
        reason: e.reason || "", at: e.at || 0, lastSeen: e.lastSeen || 0, stale: Boolean(e.stale),
      });
    }
  };
  push(doc.judged || {}, "container");
  push(doc.files || {}, "file");
  list.sort((a, b) => b.at - a.at);
  return { total: list.length, stale: list.filter((x) => x.stale).length, items: list };
}

/** 把一个绝对路径映射到「根 id + 相对路径」；不属于任何根时返回 null。 */
export function locate(stateDir, target) {
  const rootsDoc = readJson(path.join(stateDir, "roots.json"), null);
  const roots = (rootsDoc && rootsDoc.roots) || [];
  const abs = path.resolve(target);
  const lower = abs.toLowerCase();
  let best = null;
  for (const r of roots) {
    const rp = path.resolve(r.path);
    if (lower === rp.toLowerCase()) continue;
    if (lower.startsWith(rp.toLowerCase() + path.sep)) {
      if (!best || rp.length > best.rp.length) best = { r, rp };
    }
  }
  if (!best) return null;
  const rel = path.relative(best.rp, abs).split(path.sep).join("/");
  let isDir = false;
  try { isDir = fs.statSync(abs).isDirectory(); } catch { isDir = !rel.includes("/"); }
  return { rootId: best.r.id, rootPath: best.rp, rel, level: isDir ? "container" : "file" };
}
