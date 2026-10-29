import fs from "node:fs";
import path from "node:path";

/**
 * 把本机判例库导出成「可以提 PR」的脱敏片段。
 * 只导出名字模式与判定，不带绝对路径、不带用户名、不带文件内容。
 */
function scrub(text) {
  return String(text || "")
    .replace(/[A-Za-z]:\\[^\s，。；、）】]*/g, "<路径>")
    .replace(/~/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function lastNameOf(key) {
  const body = String(key || "").split(":").slice(1).join(":") || String(key || "");
  const leaf = body.split("/").filter(Boolean).pop() || "";
  return leaf.trim();
}

export function buildLearning({ stateDir, min = 1 }) {
  const file = path.join(stateDir, "known.json");
  let doc = { judged: {}, files: {} };
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return { schema: 1, exportedAt: Date.now(), patterns: [], note: "判例库还是空的（没有任何 judge 记录）" };
  }
  const bucket = new Map();
  const add = (key, v) => {
    const name = lastNameOf(key);
    if (!name) return;
    const cur = bucket.get(name) || { name, count: 0, cls: "", owner: "", reason: "" };
    cur.count += 1;
    if (!cur.cls) cur.cls = v.class || "KEEP";
    if (!cur.owner) cur.owner = v.owner || "";
    if (!cur.reason && v.reason) cur.reason = scrub(v.reason);
    bucket.set(name, cur);
  };
  for (const [k, v] of Object.entries(doc.judged || {})) add(k, v);
  for (const [k, v] of Object.entries(doc.files || {})) add(k, v);

  const patterns = [...bucket.values()]
    .filter((p) => p.count >= min)
    .map((p) => ({ name: p.name, class: p.cls, owner: p.owner, reason: p.reason, seen: p.count }))
    .sort((a, b) => b.seen - a.seen || a.name.localeCompare(b.name));

  return { schema: 1, exportedAt: Date.now(), patterns };
}
