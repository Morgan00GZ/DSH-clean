import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const HOME = os.homedir();

export function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return (i === 0 ? String(v) : v.toFixed(1)) + units[i];
}

export function shortPath(p) {
  if (!p) return "";
  const h = HOME.toLowerCase();
  const lp = String(p).toLowerCase();
  if (lp === h) return "~";
  if (lp.startsWith(h + path.sep.toLowerCase())) return "~" + p.slice(HOME.length);
  return p;
}

export function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

export function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

export function writeJsonAtomic(p, obj) {
  ensureDir(path.dirname(p));
  const tmp = p + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  fs.renameSync(tmp, p);
}

export function textLen(s) {
  let w = 0;
  for (const ch of String(s)) {
    w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  }
  return w;
}

export function padEnd(s, n) {
  const str = String(s);
  return str + " ".repeat(Math.max(0, n - textLen(str)));
}

export function padStart(s, n) {
  const str = String(s);
  return " ".repeat(Math.max(0, n - textLen(str))) + str;
}

export function stamp(d = new Date()) {
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function iso(d = new Date()) { return d.toISOString(); }

export function safeRel(p) { return p.split(path.sep).join("/"); }
