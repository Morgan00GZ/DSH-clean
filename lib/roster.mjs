import fs from "node:fs";
import path from "node:path";
import { readJson, writeJsonAtomic } from "./util.mjs";

/**
 * 插件名册的历史。
 *
 * 只跟"现在装了哪些"对账有个盲点：插件卸掉之后，它在 ~/.dsh 下建的数据目录就没人认领了，
 * 报告里会被当成"宿主数据"混过去（宿主基础设施、或名字不在名册里的一律归 host）。
 *
 * 这里把每次扫描看到的插件名单记进 state/roster.json，于是能回答：
 *   这个数据目录的主人，是不是已经不在了？
 */
const SCHEMA = 1;

function rosterPath(stateDir) { return path.join(stateDir, "roster.json"); }

export function loadRoster(stateDir) {
  const doc = readJson(rosterPath(stateDir), null);
  if (!doc || doc.schema !== SCHEMA || typeof doc.known !== "object") return { schema: SCHEMA, known: {} };
  return doc;
}

export function saveRoster(stateDir, doc) {
  writeJsonAtomic(rosterPath(stateDir), doc);
}

/** installed: Map<name, version>。返回本次"刚消失"的插件名。 */
export function updateRoster(stateDir, installed) {
  const doc = loadRoster(stateDir);
  const now = Date.now();
  const retiredNow = [];
  for (const [name, version] of installed) {
    const e = doc.known[name] || (doc.known[name] = {});
    if (!e.firstSeen) e.firstSeen = now;
    if (e.status === "retired") { e.revivedAt = now; delete e.retiredAt; }
    e.status = "installed";
    e.lastSeen = now;
    if (version) e.version = version;
  }
  for (const [name, e] of Object.entries(doc.known)) {
    if (e.status === "installed" && !installed.has(name)) {
      e.status = "retired";
      e.retiredAt = now;
      retiredNow.push(name);
    }
  }
  doc.updatedAt = now;
  saveRoster(stateDir, doc);
  return { doc, retiredNow };
}

function norm(s) {
  return String(s).toLowerCase().replace(/^@[^/]+\//, "").replace(/[^a-z0-9]/g, "");
}

/**
 * 在 data 根的一级目录里，找出"主人已经卸载"的那些。
 * containers 来自 classify（每个一级目录一项）。
 */
export function orphanDataDirs({ doc, containers, dataRootId, hostInfra }) {
  const retired = new Map();
  for (const [name, e] of Object.entries(doc.known)) {
    if (e.status !== "retired") continue;
    retired.set(norm(name), { name, retiredAt: e.retiredAt || 0 });
  }
  const out = [];
  if (!retired.size) return out;
  for (const c of containers) {
    if (c.rootId !== dataRootId) continue;
    if (hostInfra.has(c.name)) continue;
    const hit = retired.get(norm(c.name));
    if (!hit) continue;
    out.push({ plugin: hit.name, dirName: c.name, bytes: c.bytes || 0, files: c.files || 0, retiredAt: hit.retiredAt, lastWrite: c.lastWrite || 0 });
  }
  return out;
}
