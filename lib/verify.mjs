import fs from "node:fs";
import path from "node:path";
import { discover } from "./find-dsh.mjs";
import { snapshot } from "./walk.mjs";
import {
  loadBaseline, buildBaseline, verifyAgainstBaseline, extractInstaller, compareUpstream, findSevenZip,
} from "./integrity.mjs";
import { readJson, fmtBytes } from "./util.mjs";
import { VERSION } from "./version.mjs";

function loadRoots(stateDir, installDir) {
  const cached = readJson(path.join(stateDir, "roots.json"), null);
  const ok = cached && Array.isArray(cached.roots) && cached.roots.some((r) => r.kind === "install" && fs.existsSync(r.path));
  if (ok) return cached;
  const doc = discover({ installDir });
  return doc;
}

function humanDate(ms) {
  const d = new Date(ms);
  const z = (n) => (n < 10 ? "0" : "") + n;
  return d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate()) + " " + z(d.getHours()) + ":" + z(d.getMinutes());
}

function countOf(g) {
  return (g.added || []).length + (g.modified || []).length + (g.removed || []).length;
}

export async function runVerify({ stateDir, appDir, rebase, upstream, installer, agent }) {
  const L = [];
  const rootsDoc = loadRoots(stateDir, null);
  const installRoot = (rootsDoc.roots || []).find((r) => r.kind === "install");
  if (!installRoot || !fs.existsSync(installRoot.path)) {
    return { lines: ["找不到 DSH 安装目录，无法校验。请先跑一次 scan。"], code: 3, result: null };
  }
  const rules = readJson(path.join(appDir, "data", "rules.json"), null) || {};
  const dshVersion = (rootsDoc.machine && rootsDoc.machine.dshVersion) || "";
  const installDir = installRoot.path;

  const started = Date.now();
  const snap = await snapshot(installDir, { skipNames: rules.skipNames || [], skipPrefixes: [stateDir] });
  const entries = snap.entries;
  const walkMs = Date.now() - started;

  const result = { installDir, files: entries.length, bytes: snap.bytes || 0, walkMs };

  // ---- 基线 ----
  if (rebase) {
    const doc = buildBaseline({ stateDir, installDir, entries, dshVersion, source: "tofu" });
    result.baseline = { status: "rebuilt", count: doc.count, createdAt: doc.createdAt, dshVersion: doc.dshVersion, failed: doc.failed };
  } else {
    const g = verifyAgainstBaseline({ stateDir, installDir, entries, dshVersion });
    if (g.status === "no-baseline") {
      const doc = buildBaseline({ stateDir, installDir, entries, dshVersion, source: "tofu" });
      result.baseline = { status: "created", count: doc.count, createdAt: doc.createdAt, dshVersion: doc.dshVersion, failed: doc.failed };
    } else {
      result.baseline = { status: g.status, baseline: g.baseline, added: g.added, modified: g.modified, touched: g.touched, removed: g.removed, hashed: g.hashed, capped: g.capped };
    }
  }

  // ---- 上游对账（可选）----
  let upstreamDir = upstream || null;
  if (installer) {
    const ex = extractInstaller(path.resolve(installer), path.join(stateDir, "tmp"));
    if (!ex.ok) {
      result.upstream = { ok: false, reason: ex.reason, error: ex.error || "", sevenZip: findSevenZip() };
    } else {
      upstreamDir = ex.appRoot || ex.root;
      result.upstream = { ok: true, extractedFrom: path.resolve(installer), sevenZip: ex.sevenZip, root: ex.root, appRoot: ex.appRoot || null, rounds: ex.rounds };
    }
  }
  if (upstreamDir) {
    if (!fs.existsSync(upstreamDir)) {
      result.upstream = { ok: false, reason: "upstream-missing", upstream: upstreamDir };
    } else {
      const base = loadBaseline(stateDir);
      const cmp = compareUpstream({ upstreamDir, installDir, baseline: base, entries });
      result.upstream = { ...(result.upstream || { ok: true }), ok: true, upstream: upstreamDir, ...cmp };
    }
  }

  // ---- 输出 ----
  const b = result.baseline;
  if (agent) {
    const parts = ["INTEGRITY", "dsh=" + (dshVersion || "?")];
    if (b.status === "created" || b.status === "rebuilt") parts.push("baseline=" + b.status + "/" + b.count + "files");
    else parts.push("baseline=" + b.status + "/" + (b.baseline ? b.baseline.count + "files" : "?"));
    if (b.status === "drift" || b.status === "version-changed") parts.push("diff=" + countOf(b) + "(m" + b.modified.length + "/a" + b.added.length + "/r" + b.removed.length + ")");
    if (result.upstream) {
      if (result.upstream.ok && result.upstream.same) parts.push("upstream=same" + result.upstream.same.length + "/diff" + result.upstream.differ.length + "/onlyPkg" + result.upstream.onlyUpstream.length + "/onlyLocal" + result.upstream.onlyLocal.length);
      else parts.push("upstream=unavailable(" + (result.upstream.reason || "?") + ")");
    }
    L.push(parts.join(" "));
    if (b.status === "drift") L.push("DRIFT " + b.modified.slice(0, 5).map((f) => f.rel).join(" "));
    return { lines: L, code: countOf(b) ? 1 : 0, result };
  }

  L.push("DSH-clean 上游校验 v" + VERSION);
  L.push("安装目录  " + installDir);
  L.push("  文件      " + entries.length.toLocaleString("en-US") + " 个 / " + fmtBytes(snap.bytes || 0) + " · 列目录 " + (walkMs / 1000).toFixed(1) + "s");
  if (b.status === "created") {
    L.push("  基线      首次建立（本机首次信任，不是官方签名）：全量算了一次哈希");
    L.push("            " + b.count.toLocaleString("en-US") + " 个文件 · " + humanDate(b.createdAt) + (b.failed ? " · " + b.failed + " 个读不了" : ""));
    L.push("            以后每次只比时间与大小，只有对不上才去算哈希。");
  } else if (b.status === "rebuilt") {
    L.push("  基线      已重建：" + b.count.toLocaleString("en-US") + " 个文件 · " + humanDate(b.createdAt));
  } else {
    L.push("  基线      " + Number(b.baseline.count || 0).toLocaleString("en-US") + " 个文件 · 建立于 " + humanDate(b.baseline.createdAt) + (b.baseline.dshVersion ? " · 客户端 " + b.baseline.dshVersion : ""));
    const bad = countOf(b);
    if (!bad) {
      L.push("  状态      与基线一致" + (b.hashed ? "（确认了 " + b.hashed + " 个改动文件）" : "（没读盘，时间与大小都对得上）") + (b.status === "version-changed" ? "；但客户端版本变了，建议 verify --rebase" : ""));
    } else {
      L.push("  状态      不一致 " + bad + " 处（改 " + b.modified.length + " · 增 " + b.added.length + " · 少 " + b.removed.length + "）" + (b.capped ? " · 超过哈希预算，其余只标时间不符" : ""));
      for (const f of b.modified.slice(0, 8)) L.push("    ~ 改 " + f.rel);
      for (const f of b.added.slice(0, 8)) L.push("    + 增 " + f.rel);
      for (const f of b.removed.slice(0, 8)) L.push("    - 少 " + f.rel);
      if (bad > 24) L.push("    …… 完整清单见报告");
    }
  }

  if (result.upstream) {
    const u = result.upstream;
    L.push("");
    if (!u.ok) {
      const why = u.reason === "no-7zip" ? "本机没找到 7-Zip，无法自动解包。装一个 7-Zip，或手动解压安装包后用 --upstream=<解压目录>。" : (u.error || u.reason);
      L.push("上游对账  " + why);
    } else {
      L.push("上游对账  " + (u.extractedFrom ? "从安装包解出：" + u.extractedFrom : u.upstream));
      L.push("  包内文件  " + u.upstreamFiles + " 个 · 本机 " + u.localFiles + " 个");
      L.push("  一致      " + u.same.length);
      L.push("  不同      " + u.differ.length);
      for (const rel of u.differ.slice(0, 8)) L.push("    ~ " + rel);
      L.push("  只在包里  " + u.onlyUpstream.length + "（本机缺文件）");
      for (const rel of u.onlyUpstream.slice(0, 5)) L.push("    - " + rel);
      L.push("  只在本机  " + u.onlyLocal.length + "（包外的东西）");
      for (const rel of u.onlyLocal.slice(0, 5)) L.push("    + " + rel);
    }
  }

  return { lines: L, code: countOf(b) ? 1 : 0, result };
}
