import fs from "node:fs";
import path from "node:path";
import { discover } from "./find-dsh.mjs";
import { snapshot } from "./walk.mjs";
import { classify } from "./classify.mjs";
import { inferBaseline } from "./infer.mjs";
import { analyzePlugins, storeDirOf } from "./plugins.mjs";
import { evaluatePatches } from "./patches.mjs";
import { probeRelated, installedPlugins } from "./probe.mjs";
import { verifyAgainstBaseline, buildBaseline } from "./integrity.mjs";
import { updateRoster, orphanDataDirs } from "./roster.mjs";
import { loadKnown, touchKnown, knownSummary } from "./known.mjs";
import { lockCandidates, detectBusy } from "./lock.mjs";
import { renderHuman, renderAgent, renderJson, renderMarkdown } from "./report.mjs";
import { buildTree } from "./tree.mjs";
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
  const sessFiles = new Map();
  const sessBytes = new Map();
  for (const [rel, size, mtime] of entries) {
    if (!rel.startsWith("sessions/")) continue;
    const parts = rel.split("/");
    if (!parts[1]) continue;
    if (!byWs.has(parts[1])) byWs.set(parts[1], { encoded: parts[1], files: 0, bytes: 0, sessions: new Set(), oldest: mtime, newest: mtime });
    const s = byWs.get(parts[1]);
    s.files += 1;
    s.bytes += size;
    if (parts[2]) {
      s.sessions.add(parts[2]);
      const k = parts[1] + "/" + parts[2];
      sessFiles.set(k, (sessFiles.get(k) || 0) + 1);
      sessBytes.set(k, (sessBytes.get(k) || 0) + size);
    }
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

  // 会话清理策略：空的工作区容器、空会话目录、工作区已消失但还留着历史
  const emptyWorkSpaces = [];
  const orphanWorkspaces = [];
  for (const w of list) {
    if (w.sessions === 0) emptyWorkSpaces.push(w);
    else if (!w.exists) orphanWorkspaces.push(w);
  }
  const emptySessions = [];
  for (const d of dirs || []) {
    const parts = d.rel.split("/");
    if (parts.length !== 3 || parts[0] !== "sessions") continue;
    if (!sessFiles.get(parts[1] + "/" + parts[2])) emptySessions.push({ ws: parts[1], id: parts[2] });
  }

  return {
    files, bytes, count: list.reduce((a, s) => a + s.sessions, 0), workspaces: list, suspicious,
    emptyWorkSpaces, orphanWorkspaces, emptySessions,
  };
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
  const known = loadKnown(stateDir);
  if (!knowledge || !rules) throw new Error("内置知识库缺失：data/knowledge.base.json 或 data/rules.json");

  const roots = rootsDoc.roots;

  // 已知根之外还有没有 DSH 相关目录：找证据（内容特征 / 插件代码点名 / 名字与插件同名）
  const dataRootPath0 = (roots.find((r) => r.kind === "data") || {}).path || "";
  const probe = probeRelated({ roots, stateDir, dataRootPath: dataRootPath0 });
  const probed = [];
  for (const r of probe.extraRoots) {
    const key = path.resolve(r.path).toLowerCase();
    if (roots.some((x) => path.resolve(x.path).toLowerCase() === key)) continue;
    roots.push(r);
    probed.push(r);
  }

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

  // 上游校验：拿安装目录的 walk 结果对基线。平时只比 mtime+大小（零额外 IO），
  // 有基线就能回答「从我装上哪天起，有没有文件被换过」。
  const installRoot = roots.find((r) => r.kind === "install");
  const dshVersion = (rootsDoc.machine && rootsDoc.machine.dshVersion) || "";
  let integrity = { status: "no-install" };
  if (installRoot && snapshots[installRoot.id]) {
    const entries = snapshots[installRoot.id].entries;
    integrity = verifyAgainstBaseline({ stateDir, installDir: installRoot.path, entries, dshVersion });
    if (integrity.status === "no-baseline") {
      // 第一次：全量算一次哈希，之后都走闸门
      const doc = buildBaseline({ stateDir, installDir: installRoot.path, entries, dshVersion, source: "tofu" });
      integrity = {
        status: "baseline-created", added: [], modified: [], touched: [], removed: [], hashed: doc.count,
        baseline: { source: doc.source, createdAt: doc.createdAt, count: doc.count, dshVersion: doc.dshVersion },
      };
    }
  }

  const result = classify({ roots, snapshots, knowledge, rules, known });
  const dataRoot = roots.find((r) => r.kind === "data");
  const sessions = dataRoot && snapshots[dataRoot.id]
    ? sessionStats(snapshots[dataRoot.id].entries, snapshots[dataRoot.id].dirs,
        roots.filter((r) => r.kind === "workspace").map((r) => r.path).concat(dataRoot ? [dataRoot.path] : []))
    : { files: 0, bytes: 0, count: 0, workspaces: [], suspicious: [] };

  const dataRootPath = (roots.find((r) => r.kind === "data") || {}).path || "";
  const patches = evaluatePatches(stateDir, storeDirOf(dataRootPath));
  const purity = inferBaseline({ roots, snapshots, accepted: patches.ok, vendorLeftover: rules.vendorLeftover, integrity });
  const plugins = analyzePlugins({ roots, snapshots, knowledge, accepted: patches.ok });

  // 名册历史：插件卸了但数据目录还在的，算残留
  const installedMap = installedPlugins(dataRootPath);
  const roster = updateRoster(stateDir, installedMap);
  const dataRootEntry = roots.find((r) => r.kind === "data") || {};
  const orphans = orphanDataDirs({
    doc: roster.doc,
    containers: result.containers,
    dataRootId: dataRootEntry.id,
    hostInfra: new Set(Object.keys((knowledge.hostOwned || {}))),
  });
  for (const o of orphans) {
    const when = o.retiredAt ? new Date(o.retiredAt).toISOString().slice(0, 10) : "";
    result.residue.push({
      rootId: dataRootEntry.id, rel: o.dirName, size: o.bytes, tier: "A", rule: "plugin-data-orphan",
      reason: "插件 " + o.plugin + " 已卸载" + (when ? "（" + when + "）" : "") + "，数据目录还在",
    });
  }
  // 会话清理：空工作区容器（A 档，删了下次用到会自动重建）、空会话目录（A 档）、
  // 工作区路径已经不存在但还留着历史的（B 档，要人点头才清）
  if (dataRootEntry.id) {
    // 只收「工作区本身也不在了」的空容器；工作区还在的空容器属于正常占位，不进清单
    for (const w of sessions.emptyWorkSpaces || []) {
      if (w.exists) continue;
      result.residue.push({
        rootId: dataRootEntry.id, rel: "sessions/" + w.encoded, size: 0, tier: "A", rule: "empty-workspace",
        reason: "工作区路径已经不存在，容器里也没有任何会话",
      });
    }
    for (const s of sessions.emptySessions || []) {
      result.residue.push({
        rootId: dataRootEntry.id, rel: "sessions/" + s.ws + "/" + s.id, size: 0, tier: "A", rule: "empty-session",
        reason: "空会话目录（里面没有任何内容）",
      });
    }
    for (const w of sessions.orphanWorkspaces || []) {
      result.residue.push({
        rootId: dataRootEntry.id, rel: "sessions/" + w.encoded, size: w.bytes, tier: "B", rule: "orphan-workspace-session",
        reason: "工作区路径已经不存在，里面还留着 " + w.sessions + " 个会话",
      });
    }
  }

  // LOCKED：抓「此刻正在被写入」的候选（残留 / 未归类）。抽样两次元数据，正在变的不判，
  // 免得把正在下载的更新包、正在写的插件数据误报成残留，甚至误删。
  const rootsById = new Map(roots.map((r) => [r.id, path.resolve(r.path)]));
  const sizeByKey = new Map();
  for (const x of result.residue) sizeByKey.set(x.rootId + ":" + x.rel, x.size || 0);
  for (const u of result.unknown) sizeByKey.set(u.rootId + ":" + u.rel, u.bytes || 0);
  const cand = lockCandidates(result.residue, result.unknown, rootsById);
  const lock = await detectBusy(cand, { waitMs: opts.lockWaitMs || 900, rounds: 2 });
  const locked = [];
  if (lock.busy.length) {
    const busyKeys = new Set(lock.busy.map((b) => b.rootId + ":" + b.rel));
    for (const b of lock.busy) locked.push({ rootId: b.rootId, rel: b.rel, size: sizeByKey.get(b.rootId + ":" + b.rel) || 0 });
    result.residue = result.residue.filter((x) => !busyKeys.has(x.rootId + ":" + x.rel));
    result.unknown = result.unknown.filter((u) => !busyKeys.has(u.rootId + ":" + u.rel));
  }

  // 判例库顺手续命：还在的刷新 lastSeen，消失超过 90 天的标 stale
  const knownDoc = touchKnown(stateDir, known, {
    presentContainers: new Set(result.containers.map((c) => c.rootId + ":" + c.name)),
    rootsById,
  });
  const knownInfo = knownSummary(knownDoc);

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
    lockSeconds: lock.seconds,
    delta: totalDelta,
  };

  // 与上次扫描比：从 last-run.json 里那行摘要读回上一次的几个计数
  const prevRun = readJson(path.join(stateDir, "last-run.json"), null);
  const pickNum = (line, key) => {
    const m = String(line || "").match(new RegExp(key + "=([0-9]+)"));
    return m ? Number(m[1]) : null;
  };
  const diffOf = (nowVal, prevVal) => (nowVal == null || prevVal == null ? null : nowVal - prevVal);
  const changes = prevRun && prevRun.line ? {
    at: prevRun.at || 0,
    files: diffOf(totals.files, pickNum(prevRun.line, "files")),
    residue: diffOf(result.residue.length, pickNum(prevRun.line, "residue")),
    unknown: diffOf(result.unknown.length, pickNum(prevRun.line, "unknown")),
    sessions: diffOf(sessions.count, pickNum(prevRun.line, "sessions")),
    plugins: diffOf((plugins.packages || []).length, pickNum(prevRun.line, "plugins")),
    known: diffOf(knownInfo.count, pickNum(prevRun.line, "known")),
  } : null;

  // 树形展示：每个根建一棵，深度到「一个插件 / 一个会话」为止
  const trees = {};
  for (const r of roots) {
    const snap = snapshots[r.id];
    if (!snap) continue;
    const meta = new Map(result.containers.filter((c) => c.rootId === r.id).map((c) => [c.name, c]));
    try {
      // 数据目录才需要看到「插件 / 会话」这一层；其它根看两层就够，免得被 dll 和 Python 库淹没
      trees[r.id] = buildTree({ snapshot: snap, dataRootPath, containers: meta, maxDepth: r.kind === "data" ? 6 : 2 });
    } catch (e) {
      trees[r.id] = { nodes: [], more: 0, error: String((e && e.message) || e) };
    }
  }

  const ctx = {
    version: VERSION,
    machine: rootsDoc.machine,
    roots,
    stats,
    containers: result.containers,
    residue: result.residue.sort((a, b) => b.size - a.size),
    unknown: result.unknown,
    locked,
    known: knownInfo,
    warnings: (() => {
      const w = (rootsDoc.warnings || []).slice();
      if (plugins.unverifiable && plugins.unverifiable.length) {
        w.push("插件原件对照不了：" + (plugins.storeEmpty ? "pnpm 仓库已被清理" : "仓库里没有对应原件") + "（" + plugins.unverifiable.length + " 个文件）——这些不算脏，但也没法证明没被改过");
      }
      return w;
    })(),
    sessions,
    purity,
    integrity,
    plugins,
    patches: { total: patches.items.length, accepted: patches.accepted, bad: patches.bad, items: patches.items },
    probe: { found: probed.length, suspects: probe.suspects, installed: probe.installed, cacheHit: probe.cacheHit },
    roster: { retired: roster.retiredNow, orphans: orphans.length },
    changes,
    trees,
    reportPath: path.join(reportDir, "report.md"),
  };

  // 报告份数：超过保留数时提示收尾，但扫描本身不动手（scan 只写 state 与 reports）
  try {
    ctx.reportsCount = fs.readdirSync(path.join(stateDir, "reports")).filter((n) => /^\d{8}-\d{6}$/.test(n)).length;
  } catch { ctx.reportsCount = 0; }

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
