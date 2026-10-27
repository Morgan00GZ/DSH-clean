import fs from "node:fs";
import path from "node:path";
import { discover } from "./find-dsh.mjs";
import { snapshot } from "./walk.mjs";
import { classify } from "./classify.mjs";
import { renderHuman, renderAgent, renderJson, renderMarkdown } from "./report.mjs";
import { ensureDir, readJson, writeJsonAtomic, stamp, fmtBytes } from "./util.mjs";
import { VERSION, SCHEMA } from "./version.mjs";

function loadRootCache(stateDir) {
  return readJson(path.join(stateDir, "roots.json"), null);
}

function rootsStillValid(cached) {
  if (!cached || !Array.isArray(cached.roots) || cached.roots.length === 0) return false;
  // 缺安装目录说明上次没发现到，缓存不可信
  if (!cached.roots.some((r) => r.kind === "install")) return false;
  return cached.roots.every((r) => {
    try { return fs.existsSync(r.path); } catch { return false; }
  });
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

function diffCounts(prevEntries, entries, rules) {
  const keep = (rel) => !isVolatile(rel, rules);
  if (!prevEntries) return { changed: null, added: entries.filter(([r]) => keep(r)).length, gone: 0 };
  const prev = new Map();
  for (const [rel, size, mtime] of prevEntries) if (keep(rel)) prev.set(rel, size + ":" + mtime);
  let changed = 0;
  let added = 0;
  for (const [rel, size, mtime] of entries) {
    if (!keep(rel)) continue;
    const old = prev.get(rel);
    if (old === undefined) added += 1;
    else if (old !== size + ":" + mtime) changed += 1;
    prev.delete(rel);
  }
  return { changed, added, gone: prev.size };
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
  const totals = { files: 0, bytes: 0, added: 0, changed: 0, gone: 0, anyPrev: false };

  for (const r of roots) {
    const depth = r.kind === "workspace" ? 2 : Infinity;
    const snap = await snapshot(r.path, { skipNames: rules.skipNames || [], maxDepth: depth, skipPrefixes: [stateDir] });
    const invPath = path.join(invDir, r.id.replace(/[^a-z0-9._-]+/gi, "_") + ".json");
    const prev = readJson(invPath, null);
    const d = diffCounts(prev?.entries, snap.entries, rules);
    if (d.changed !== null) totals.anyPrev = true;
    totals.files += snap.entries.length;
    totals.bytes += snap.bytes;
    totals.added += d.added;
    totals.changed += d.changed || 0;
    totals.gone += d.gone;
    writeJsonAtomic(invPath, { schema: SCHEMA, rootId: r.id, scannedAt: Date.now(), count: snap.entries.length, entries: snap.entries });
    snapshots[r.id] = snap;
  }

  // 清掉不再使用的 inventory（根 id 变化后留下的旧文件）
  try {
    const keep = new Set(roots.map((r) => r.id.replace(/[^a-z0-9._-]+/gi, "_") + ".json"));
    for (const f of fs.readdirSync(invDir)) if (!keep.has(f)) fs.rmSync(path.join(invDir, f), { force: true });
  } catch { /* 忽略 */ }

  const result = classify({ roots, snapshots, knowledge, rules, known });

  const residueBytes = result.residue.reduce((a, x) => a + (x.size || 0), 0);
  const keepFiles = totals.files - result.residue.length - result.cacheFiles;
  const stats = {
    files: totals.files,
    bytes: totals.bytes,
    keep: Math.max(0, keepFiles),
    cache: result.cacheFiles,
    residueBytes,
    changed: totals.anyPrev ? totals.changed : null,
    added: totals.added,
    gone: totals.gone,
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
    reportPath: path.join(reportDir, "report.md"),
  };

  const items = [];
  let id = 1;
  for (const x of ctx.residue) {
    items.push({ id: id++, class: "RESIDUE", tier: x.tier, rootId: x.rootId, path: x.rel, size: x.size, rule: x.rule, reason: x.reason });
  }
  for (const u of ctx.unknown) {
    items.push({ id: id++, class: "UNKNOWN", tier: u.tier || "B", rootId: u.rootId, path: u.rel, size: u.bytes, files: u.files, reason: u.reason });
  }

  writeJsonAtomic(path.join(reportDir, "plan.json"), { schema: SCHEMA, version: VERSION, generatedAt: Date.now(), items });
  writeJsonAtomic(path.join(reportDir, "run.json"), {
    schema: SCHEMA, version: VERSION, startedAt: started, finishedAt: Date.now(),
    args: opts.argv, roots: roots.map((r) => r.id), stats,
  });
  fs.writeFileSync(path.join(reportDir, "pending.md"), renderPending(ctx), "utf8");
  fs.writeFileSync(ctx.reportPath, renderMarkdown(ctx), "utf8");

  // 供下次 --agent 用的最短摘要
  writeJsonAtomic(path.join(stateDir, "last-run.json"), {
    schema: SCHEMA, at: Date.now(), version: VERSION,
    line: renderAgent(ctx).split("\n")[0],
    reportPath: ctx.reportPath,
  });

  return { ctx, code: ctx.residue.length ? 1 : ctx.unknown.length ? 2 : 0, items };
}

function renderPending(ctx) {
  const L = ["# 待确认清单", ""];
  if (!ctx.unknown.length) { L.push("无。"); return L.join("\n"); }
  L.push("下面这些文件夹无法自动归属。一句话说明它们是什么即可，之后会记进判例库，不再重复问。", "");
  ctx.unknown.forEach((u, i) => {
    L.push((i + 1) + ". " + u.rel);
    L.push("   文件 " + u.files + " 个，共 " + fmtBytes(u.bytes));
    L.push("   " + u.reason);
    L.push("");
  });
  return L.join("\n");
}
