import fs from "node:fs";
import path from "node:path";
import { discover } from "./find-dsh.mjs";
import { snapshot } from "./walk.mjs";
import { classify } from "./classify.mjs";
import { inferBaseline } from "./infer.mjs";
import { analyzePlugins, storeDirOf } from "./plugins.mjs";
import { evaluatePatches } from "./patches.mjs";
import { renderHuman, renderAgent, renderJson, renderMarkdown } from "./report.mjs";
import { ensureDir, readJson, writeJsonAtomic, stamp, fmtBytes } from "./util.mjs";
import { VERSION, SCHEMA } from "./version.mjs";

const DEPTH = { workspace: 3, related: 3 };

function loadRootCache(stateDir) { return readJson(path.join(stateDir, "roots.json"), null); }

function rootsStillValid(cached) {
  if (!cached || !Array.isArray(cached.roots) || cached.roots.length === 0) return false;
  if (!cached.roots.some((r) => r.kind === "install")) return false;
  return cached.roots.every((r) => { try { return fs.existsSync(r.path); } catch { return false; } });
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
    if (!byWs.has(parts[1])) byWs.set(parts[1], { encoded: parts[1], files: 0, bytes: 0, sessions: new Set(), oldest: mtime, newest: mtime });
    const s = byWs.get(parts[1]);
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
    return { encoded: s.encoded, path: m.path, exists: m.exists, sessions: s.sessions.size, files: s.files, bytes: s.bytes, oldest: s.oldest, newest: s.newest };
  }).sort((a, b) => b.bytes - a.bytes);
  return { files, bytes, count: list.reduce((a, s) => a + s.sessions, 0), workspaces: list, suspicious };
}

export async function runScan(opts) {
  const started = Date.now();
  const stateDir = opts.stateDir;
  const reportDir = path.join(stateDir, "reports", stamp());
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

  for (const r of roots) {
    const snap = await snapshot(r.path, {
      skipNames: rules.skipNames || [],
      maxDepth: DEPTH[r.kind] || Infinity,
      skipPrefixes: [stateDir],
    });
    r.files = snap.entries.length;
    r.bytes = snap.bytes;
    r.shallow = Boolean(DEPTH[r.kind]);
    totals.files += snap.entries.length;
    totals.bytes += snap.bytes;
    snapshots[r.id] = snap;
  }

  const result = classify({ roots, snapshots, knowledge, rules, known });
  const dataRoot = roots.find((r) => r.kind === "data");
  const sessions = dataRoot && snapshots[dataRoot.id]
    ? sessionStats(snapshots[dataRoot.id].entries, snapshots[dataRoot.id].dirs,
        roots.filter((r) => r.kind === "workspace").map((r) => r.path).concat(dataRoot ? [dataRoot.path] : []))
    : { files: 0, bytes: 0, count: 0, workspaces: [], suspicious: [] };

  const dataRootPath = (roots.find((r) => r.kind === "data") || {}).path || "";
  const patches = evaluatePatches(stateDir, storeDirOf(dataRootPath));
  const purity = inferBaseline({ roots, snapshots, accepted: patches.ok });
  const plugins = analyzePlugins({ roots, snapshots, knowledge, accepted: patches.ok });

  // 目录体积历史：回答"这块占了多少、这次多了多少"
  const sizesPath = path.join(stateDir, "sizes.json");
  const prevSizes = readJson(sizesPath, null)?.dirs || {};
  const sizes = {};
  let totalDelta = 0;
  for (const c of result.containers) {
    const key = c.rootId + ":" + c.name;
    const prev = prevSizes[key];
    c.delta = prev ? c.bytes - prev.bytes : 0;
    c.isNew = !prev;
    totalDelta += c.delta;
    sizes[key] = { bytes: c.bytes, files: c.files, at: Date.now() };
  }
  writeJsonAtomic(sizesPath, { schema: SCHEMA, updatedAt: Date.now(), dirs: sizes });

  const residueBytes = result.residue.reduce((a, x) => a + (x.size || 0), 0);
  const stats = {
    files: totals.files,
    bytes: totals.bytes,
    keep: Math.max(0, totals.files - result.residue.length - result.cacheFiles),
    cache: result.cacheFiles,
    residueBytes,
    seconds: (Date.now() - started) / 1000,
    delta: totalDelta,
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
    sessions,
    purity,
    plugins,
    patches: { total: patches.items.length, accepted: patches.accepted, bad: patches.bad, items: patches.items },
    reportPath: path.join(reportDir, "report.md"),
  };

  const items = [];
  let id = 1;
  for (const x of ctx.residue) items.push({ id: id++, class: "RESIDUE", tier: x.tier, rootId: x.rootId, path: x.rel, size: x.size, rule: x.rule, reason: x.reason });
  for (const u of ctx.unknown) items.push({ id: id++, class: "UNKNOWN", tier: u.tier || "B", rootId: u.rootId, path: u.rel, size: u.bytes, files: u.files, reason: u.reason });

  writeJsonAtomic(path.join(reportDir, "plan.json"), { schema: SCHEMA, version: VERSION, generatedAt: Date.now(), items });
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
