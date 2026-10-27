import fs from "node:fs";
import path from "node:path";
import { discover } from "./find-dsh.mjs";
import { snapshot } from "./walk.mjs";
import { classify } from "./classify.mjs";
import { baselinePath, compareBaseline, captureBaseline } from "./baseline.mjs";
import { renderHuman, renderAgent, renderJson, renderMarkdown } from "./report.mjs";
import { ensureDir, readJson, writeJsonAtomic, stamp, fmtBytes } from "./util.mjs";
import { VERSION, SCHEMA } from "./version.mjs";

const DEPTH = { workspace: 2, related: 3 };

function loadRootCache(stateDir) { return readJson(path.join(stateDir, "roots.json"), null); }

function rootsStillValid(cached) {
  if (!cached || !Array.isArray(cached.roots) || cached.roots.length === 0) return false;
  if (!cached.roots.some((r) => r.kind === "install")) return false;
  return cached.roots.every((r) => { try { return fs.existsSync(r.path); } catch { return false; } });
}

function isVolatile(rel, rules) {
  for (const p of rules.volatile || []) {
    if (p.endsWith("/")) {
      const seg = p.slice(0, -1);
      if (rel === seg || rel.startsWith(seg + "/") || rel.includes("/" + seg + "/")) return true;
    } else if (p.startsWith("*.")) {
      if (rel.endsWith(p.slice(1))) return true;
    }
  }
  return false;
}

function diffRoot(rootId, prevEntries, entries, rules) {
  const keep = (rel) => !isVolatile(rel, rules);
  const out = { added: [], gone: [], changed: [], counts: { added: 0, gone: 0, changed: 0, anyPrev: false } };
  if (!prevEntries) {
    out.counts.added = entries.filter(([r]) => keep(r)).length;
    return out;
  }
  out.counts.anyPrev = true;
  const prev = new Map();
  for (const [rel, size, mtime] of prevEntries) if (keep(rel)) prev.set(rel, size + ":" + mtime);
  for (const [rel, size, mtime] of entries) {
    if (!keep(rel)) continue;
    const old = prev.get(rel);
    if (old === undefined) {
      out.counts.added += 1;
      if (out.added.length < 300) out.added.push({ rootId, rel, size });
    } else if (old !== size + ":" + mtime) {
      out.counts.changed += 1;
      if (out.changed.length < 300) out.changed.push({ rootId, rel, size });
    }
    prev.delete(rel);
  }
  for (const rel of prev.keys()) {
    out.counts.gone += 1;
    if (out.gone.length < 300) out.gone.push({ rootId, rel });
  }
  return out;
}

function decodeWorkspace(encoded) {
  const body = encoded.replace(/^-+|-+$/g, "").replace(/~0020/g, " ");
  const guess = body.replace(/-/g, "\\");
  const withDrive = /^[A-Za-z]\\/.test(guess) ? guess.slice(0, 1) + ":" + guess.slice(1) : guess;
  for (const cand of [withDrive, guess]) {
    try { if (fs.existsSync(cand)) return cand; } catch { /* 忽略 */ }
  }
  return withDrive;
}

function wsKey(p) {
  return p.replace(/[\\/:]/g, "-").replace(/-+/g, "-").toLowerCase().replace(/^-+|-+$/g, "");
}

function matchWorkspace(encoded, knownPaths) {
  const key = encoded.toLowerCase().replace(/^-+|-+$/g, "");
  for (const p of knownPaths) if (wsKey(p) === key) return { path: p, exists: true };
  const decoded = decodeWorkspace(encoded);
  try { return { path: decoded, exists: fs.existsSync(decoded) }; } catch { return { path: decoded, exists: false }; }
}

function sessionStats(entries, dirs, knownPaths = []) {
  const byWs = new Map();
  let files = 0;
  let bytes = 0;
  const suspicious = [];
  for (const [rel, size, mtime] of entries) {
    if (!rel.startsWith("sessions/")) continue;
    const parts = rel.split("/");
    if (!parts[1]) continue;
    const ws = parts[1];
    if (!byWs.has(ws)) byWs.set(ws, { encoded: ws, files: 0, bytes: 0, sessions: new Set(), oldest: mtime, newest: mtime });
    const s = byWs.get(ws);
    s.files += 1;
    s.bytes += size;
    if (parts[2]) s.sessions.add(parts[2]);
    s.oldest = Math.min(s.oldest, mtime);
    s.newest = Math.max(s.newest, mtime);
    files += 1;
    bytes += size;
    if (/\.(tmp|part|partial)$/i.test(rel) || size === 0) {
      if (suspicious.length < 50) suspicious.push({ rel, size, mtime });
    }
  }
  for (const d of dirs || []) {
    if (!d.rel.startsWith("sessions/")) continue;
    const ws = d.rel.split("/")[1];
    if (!ws || byWs.has(ws)) continue;
    byWs.set(ws, { encoded: ws, files: 0, bytes: 0, sessions: new Set(), oldest: 0, newest: 0 });
  }
  const list = [...byWs.values()].map((s) => {
    const m = matchWorkspace(s.encoded, knownPaths);
    return {
    encoded: s.encoded,
    path: m.path,
    exists: m.exists,
    sessions: s.sessions.size,
    files: s.files,
    bytes: s.bytes,
    oldest: s.oldest,
    newest: s.newest,
  };
  }).sort((a, b) => b.bytes - a.bytes);
  return { files, bytes, count: list.reduce((a, s) => a + s.sessions, 0), workspaces: list, suspicious };
}

export async function runScan(opts) {
  const started = Date.now();
  const stateDir = opts.stateDir;
  const invDir = path.join(stateDir, "inventory");
  const reportDir = path.join(stateDir, "reports", stamp());
  ensureDir(invDir);
  ensureDir(reportDir);

  let rootsDoc = loadRootCache(stateDir);
  if (opts.full || !rootsStillValid(rootsDoc)) {
    rootsDoc = discover({ installDir: opts.installDir });
    writeJsonAtomic(path.join(stateDir, "roots.json"), rootsDoc);
  }

  const knowledge = readJson(path.join(opts.appDir, "data", "knowledge.base.json"), null);
  const rules = readJson(path.join(opts.appDir, "data", "rules.json"), null);
  const known = readJson(path.join(stateDir, "known.json"), null);
  if (!knowledge || !rules) throw new Error("内置知识库缺失：data/knowledge.base.json 或 data/rules.json");

  const roots = rootsDoc.roots;
  const snapshots = {};
  const totals = { files: 0, bytes: 0 };
  const changes = { added: [], gone: [], changed: [], counts: { added: 0, gone: 0, changed: 0, anyPrev: false } };

  for (const r of roots) {
    const snap = await snapshot(r.path, {
      skipNames: rules.skipNames || [],
      maxDepth: DEPTH[r.kind] || Infinity,
      skipPrefixes: [stateDir],
    });
    const invPath = path.join(invDir, r.id.replace(/[^a-z0-9._-]+/gi, "_") + ".json");
    const prev = readJson(invPath, null);
    const d = diffRoot(r.id, prev?.entries, snap.entries, rules);
    changes.counts.added += d.counts.added;
    changes.counts.gone += d.counts.gone;
    changes.counts.changed += d.counts.changed;
    changes.counts.anyPrev = changes.counts.anyPrev || d.counts.anyPrev;
    changes.added.push(...d.added);
    changes.gone.push(...d.gone);
    changes.changed.push(...d.changed);

    r.files = snap.entries.length;
    r.bytes = snap.bytes;
    r.shallow = Boolean(DEPTH[r.kind]);
    totals.files += snap.entries.length;
    totals.bytes += snap.bytes;
    writeJsonAtomic(invPath, { schema: SCHEMA, rootId: r.id, scannedAt: Date.now(), count: snap.entries.length, entries: snap.entries });
    snapshots[r.id] = snap;
  }

  try {
    const keep = new Set(roots.map((r) => r.id.replace(/[^a-z0-9._-]+/gi, "_") + ".json"));
    for (const f of fs.readdirSync(invDir)) if (!keep.has(f)) fs.rmSync(path.join(invDir, f), { force: true });
  } catch { /* 忽略 */ }

  const result = classify({ roots, snapshots, knowledge, rules, known });
  const dataRoot = roots.find((r) => r.kind === "data");
  const sessions = dataRoot && snapshots[dataRoot.id]
    ? sessionStats(snapshots[dataRoot.id].entries, snapshots[dataRoot.id].dirs, roots.filter((r) => r.kind === "workspace").map((r) => r.path).concat(dataRoot ? [dataRoot.path] : []))
    : { files: 0, bytes: 0, count: 0, workspaces: [], suspicious: [] };

  const baseline = readJson(baselinePath(stateDir), null);
  const drift = compareBaseline({ baseline, roots, snapshots });

  const residueBytes = result.residue.reduce((a, x) => a + (x.size || 0), 0);
  const keepFiles = totals.files - result.residue.length - result.cacheFiles;
  const stats = {
    files: totals.files,
    bytes: totals.bytes,
    keep: Math.max(0, keepFiles),
    cache: result.cacheFiles,
    residueBytes,
    changed: changes.counts.anyPrev ? changes.counts.changed : null,
    added: changes.counts.added,
    gone: changes.counts.gone,
    seconds: (Date.now() - started) / 1000,
  };

  const ctx = {
    version: VERSION,
    machine: rootsDoc.machine,
    roots,
    stats,
    containers: result.containers,
    residue: result.residue.sort((a, b) => b.size - a.size),
    unknown: result.unknown,
    warnings: rootsDoc.warnings || [],
    changes,
    sessions,
    drift,
    reportPath: path.join(reportDir, "report.md"),
  };

  const items = [];
  let id = 1;
  for (const x of ctx.residue) items.push({ id: id++, class: "RESIDUE", tier: x.tier, rootId: x.rootId, path: x.rel, size: x.size, rule: x.rule, reason: x.reason });
  for (const u of ctx.unknown) items.push({ id: id++, class: "UNKNOWN", tier: u.tier || "B", rootId: u.rootId, path: u.rel, size: u.bytes, files: u.files, reason: u.reason });

  writeJsonAtomic(path.join(reportDir, "plan.json"), { schema: SCHEMA, version: VERSION, generatedAt: Date.now(), items });
  writeJsonAtomic(path.join(reportDir, "changes.json"), { schema: SCHEMA, generatedAt: Date.now(), counts: changes.counts, added: changes.added, gone: changes.gone, changed: changes.changed });
  writeJsonAtomic(path.join(reportDir, "run.json"), {
    schema: SCHEMA, version: VERSION, startedAt: started, finishedAt: Date.now(), args: opts.argv, roots: roots.map((r) => r.id), stats,
  });
  fs.writeFileSync(path.join(reportDir, "pending.md"), renderPending(ctx), "utf8");
  fs.writeFileSync(ctx.reportPath, renderMarkdown(ctx), "utf8");

  writeJsonAtomic(path.join(stateDir, "last-run.json"), {
    schema: SCHEMA, at: Date.now(), version: VERSION, line: renderAgent(ctx).split("\n")[0], reportPath: ctx.reportPath,
  });

  return { ctx, code: ctx.residue.length ? 1 : ctx.unknown.length ? 2 : 0, items };
}

export async function runBaseline(opts) {
  const stateDir = opts.stateDir;
  ensureDir(stateDir);
  const rules = readJson(path.join(opts.appDir, "data", "rules.json"), null) || {};
  let rootsDoc = loadRootCache(stateDir);
  if (!rootsDoc || !rootsStillValid(rootsDoc)) {
    rootsDoc = discover({ installDir: opts.installDir });
    writeJsonAtomic(path.join(stateDir, "roots.json"), rootsDoc);
  }
  return captureBaseline({ roots: rootsDoc.roots, rules, stateDir });
}

function renderPending(ctx) {
  const L = ["# 待确认清单", ""];
  if (!ctx.unknown.length) { L.push("无。"); return L.join("\n"); }
  L.push("下面这些文件夹无法自动归属。一句话说明它们是什么即可。", "");
  ctx.unknown.forEach((u, i) => {
    L.push((i + 1) + ". " + u.rootId + "\\" + u.rel.split("/").join("\\"));
    L.push("   文件 " + u.files + " 个，共 " + fmtBytes(u.bytes));
    L.push("   " + u.reason);
    L.push("");
  });
  return L.join("\n");
}
