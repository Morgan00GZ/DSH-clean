import fs from "node:fs";
import path from "node:path";

function bytesLabel(n) {
  if (!n) return "0B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return (i === 0 ? String(Math.round(v)) : v.toFixed(v >= 10 ? 0 : 1)) + units[i];
}

/** 读会话标题（只读每个会话索引文件的开头，不碰正文） */
export function sessionTitle(dataRootPath, id) {
  const p = path.join(dataRootPath, "storages", "session_projcache", "sessions", id + ".json");
  // 目录名可能是 session-<uuid>，索引文件名就是 <目录名>.json
  try {
    const fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.slice(0, n).toString("utf8");
    const m = head.match(/"title"\s*:\s*\{[^}]*?"val"\s*:\s*"((?:[^"\\]|\\.){0,120})"/);
    if (!m) return "";
    return m[1].replace(/\\"/g, '"').replace(/\\n/g, " ").trim();
  } catch { return ""; }
}

function indexSnapshot(snapshot) {
  const bytes = new Map();
  const files = new Map();
  const kids = new Map();
  const isDir = new Set();
  const dirNames = new Map();
  const add = (map, key, v) => map.set(key, (map.get(key) || 0) + v);
  const pushKid = (parent, child) => {
    if (!kids.has(parent)) kids.set(parent, new Set());
    kids.get(parent).add(child);
  };
  for (const d of snapshot.dirs || []) {
    const rel = d.rel;
    if (!rel) continue;
    isDir.add(rel);
    const at = rel.lastIndexOf("/");
    pushKid(at < 0 ? "" : rel.slice(0, at), rel);
  }
  for (const e of snapshot.entries || []) {
    const rel = e[0];
    const size = e[1] || 0;
    add(files, rel, 1);
    add(bytes, rel, size);
    const bits = rel.split("/");
    for (let i = 1; i < bits.length; i += 1) {
      const key = bits.slice(0, i).join("/");
      add(bytes, key, size);
      add(files, key, 1);
    }
    const at = rel.lastIndexOf("/");
    const parent = at < 0 ? "" : rel.slice(0, at);
    const leaf = at < 0 ? rel : rel.slice(at + 1);
    pushKid(parent, rel);
    if (!dirNames.has(parent)) dirNames.set(parent, new Set());
    dirNames.get(parent).add(leaf);
  }
  return { bytes, files, kids, isDir, dirNames };
}

const isSessionId = (n) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(n);

export function buildTree({ snapshot, dataRootPath, containers, maxDepth = 6, cap = 7 }) {
  const idx = indexSnapshot(snapshot || { entries: [], dirs: [] });
  const meta = containers instanceof Map ? containers : new Map(Object.entries(containers || {}));
  const nameOf = (rel) => rel.slice(rel.lastIndexOf("/") + 1);
  const hasPkg = (rel) => Boolean(idx.dirNames.get(rel) && idx.dirNames.get(rel).has("package.json"));
  const isSessionDir = (rel) => {
    const parts = rel.split("/");
    return parts.length === 3 && parts[0] === "sessions";
  };
  // DSH 插件包：profiles/<profile>/node_modules/[scope/]<包>；其余带 package.json 的是随客户端分发的 npm 包
  const unitOf = (rel) => {
    if (isSessionDir(rel)) return "session";
    if (!hasPkg(rel)) return "";
    // profiles/<名> 是 profile 本身（也有 package.json），要继续往下看 node_modules
    if (/^profiles\/[^/]+$/.test(rel)) return "";
    if (/^profiles\/[^/]+\/node_modules\//.test(rel)) return "plugin";
    if (rel.includes("/node_modules/")) return "package";
    return "";
  };

  const nodeOf = (rel0, depth) => {
    let rel = rel0;
    const isDirectory = idx.isDir.has(rel);
    const node = { name: nameOf(rel), rel, dir: isDirectory, bytes: idx.bytes.get(rel) || 0, files: idx.files.get(rel) || 0 };
    if (!isDirectory) return node;
    const unit = unitOf(rel);
    if (unit === "session") {
      node.unit = "session";
      const t = sessionTitle(dataRootPath, node.name);
      if (t) node.title = t;
      return node;
    }
    if (unit) { node.unit = unit; return node; }
    // 只在这两棵子树里往下走：插件（profiles/*/node_modules）与会话（sessions/*）。
    // 其余目录只列一层，免得被 python Lib、dll、日志目录淹没。
    const expandable = rel === "sessions" || rel.startsWith("sessions/") || rel === "profiles" || rel.startsWith("profiles/");
    if (!expandable || depth >= maxDepth) { node.cut = true; return node; }

    // 单子项目的链合并成一行：profiles\desktop\node_modules
    let label = node.name;
    let merges = 0;
    while (merges < 4) {
      const list = [...(idx.kids.get(rel) || [])];
      const dirKids = list.filter((k) => idx.isDir.has(k));
      const fileKids = list.filter((k) => !idx.isDir.has(k));
      if (list.length !== 1 || dirKids.length !== 1 || fileKids.length) break;
      const next = dirKids[0];
      if (unitOf(next)) break;
      // 目录联接（junction）指回上层时会造成路径无限增长，用长度兜底
      if (next.length > rel.length + 200) break;
      rel = next;
      label = label + "\\" + nameOf(next);
      merges += 1;
      if (depth + 1 + merges >= maxDepth) break;
    }
    if (rel !== rel0) {
      node.name = label;
      node.rel = rel;
      node.bytes = idx.bytes.get(rel) || 0;
      node.files = idx.files.get(rel) || 0;
    }

    const all = [...(idx.kids.get(rel) || [])];
    const kids = all
      .filter((k) => idx.isDir.has(k) || depth < 3 || (idx.bytes.get(k) || 0) >= 1048576)
      .sort((a, b) => (idx.bytes.get(b) || 0) - (idx.bytes.get(a) || 0));
    if (!kids.length) return node;
    const shown = kids.slice(0, cap);
    node.children = shown.map((k) => nodeOf(k, depth + 1));
    const hidden = all.length - shown.length;
    if (hidden > 0) node.more = hidden;
    return node;
  };

  const top = [...(idx.kids.get("") || [])].sort((a, b) => (idx.bytes.get(b) || 0) - (idx.bytes.get(a) || 0));
  const shown = top.slice(0, cap + 4);
  const nodes = shown.map((rel) => {
    const node = nodeOf(rel, 1);
    const m = meta.get(nameOf(rel));
    if (m) { node.owner = m.owner; node.cls = m.cls; node.reason = m.reason; }
    return node;
  });
  return { nodes, more: top.length - shown.length };
}

export function renderTree(nodes, { more = 0, annotate = null } = {}) {
  const lines = [];
  const walk = (list, prefix, tailMore) => {
    list.forEach((n, i) => {
      const last = i === list.length - 1 && !tailMore;
      const line = [];
      line.push(prefix + (last ? "└── " : "├── ") + n.name + (n.dir ? "\\" : "") + "  " + bytesLabel(n.bytes));
      const extra = annotate ? annotate(n) : "";
      if (extra) line.push(extra);
      lines.push(line.join("  "));
      const childPrefix = prefix + (last ? "    " : "│   ");
      if (n.children && n.children.length) walk(n.children, childPrefix, Boolean(n.more));
      if (n.more) lines.push(childPrefix + "└── … 还有 " + n.more + " 项");
    });
  };
  walk(nodes, "", Boolean(more));
  if (more) lines.push("└── … 还有 " + more + " 项");
  return lines;
}
