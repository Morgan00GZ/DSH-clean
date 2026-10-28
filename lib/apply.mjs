import fs from "node:fs";
import path from "node:path";
import { readJson, fmtBytes, shortPath, padStart } from "./util.mjs";
import { recyclePaths } from "./recycle.mjs";

/** 最近一次扫描的 plan.json（含编号清单）。 */
export function latestPlan(stateDir) {
  const reports = path.join(stateDir, "reports");
  let names = [];
  try { names = fs.readdirSync(reports).filter((n) => fs.statSync(path.join(reports, n)).isDirectory()).sort().reverse(); }
  catch { return null; }
  for (const n of names) {
    const p = path.join(reports, n, "plan.json");
    const doc = readJson(p, null);
    if (doc && Array.isArray(doc.items)) return { dir: path.join(reports, n), path: p, doc, stamp: n };
  }
  return null;
}

function rootOf(rootsDoc, rootId) {
  const r = (rootsDoc?.roots || []).find((x) => x.id === rootId);
  return r ? r.path : "";
}

/** 根目录 + 相对路径 → 绝对路径，并挡住「越界 / 打根目录本身 / 目录穿越」。 */
function safeTarget(rootPath, rel) {
  if (!rootPath) throw new Error("根目录不在缓存里，请先跑一次 scan");
  const root = path.resolve(rootPath);
  const abs = path.resolve(root, rel.split("/").join(path.sep));
  if (abs === root) throw new Error("拒绝：目标是根目录本身 " + root);
  const pfx = root.toLowerCase().endsWith(path.sep) ? root.toLowerCase() : root.toLowerCase() + path.sep;
  if (!abs.toLowerCase().startsWith(pfx)) throw new Error("拒绝：目标越出根目录（" + abs + "）");
  return abs;
}

function statOf(p) {
  try { const s = fs.statSync(p); return { exists: true, isDir: s.isDirectory(), bytes: s.isDirectory() ? -1 : s.size }; }
  catch { return { exists: false, isDir: false, bytes: 0 }; }
}

function dirBytesHint() { return ""; }

export function runApply(opts) {
  const stateDir = opts.stateDir;
  const plan = opts.planPath
    ? (() => { const doc = readJson(opts.planPath, null); return doc ? { dir: path.dirname(opts.planPath), path: opts.planPath, doc, stamp: path.basename(path.dirname(opts.planPath)) } : null; })()
    : latestPlan(stateDir);
  if (!plan) return { lines: ["还没有可用的扫描结果。先跑一次：dsh-clean.cmd scan"], code: 3 };

  const rootsDoc = readJson(path.join(stateDir, "roots.json"), null);
  const items = plan.doc.items || [];
  if (!items.length) {
    return { lines: ["最近一次扫描没有发现待清理项（" + plan.stamp + "）。"], code: 0 };
  }

  // 解析成带绝对路径的行
  const rows = [];
  const broken = [];
  for (const it of items) {
    const rootPath = rootOf(rootsDoc, it.rootId);
    let abs = "";
    try { abs = safeTarget(rootPath, it.path); } catch (e) { broken.push({ it, why: e.message }); continue; }
    const st = statOf(abs);
    rows.push({
      id: it.id, tier: it.tier || "B", cls: it.class, rel: it.path, abs,
      bytes: st.exists && st.isDir ? (it.size || 0) : st.bytes || it.size || 0,
      reason: it.reason || "", exists: st.exists, isDir: st.isDir,
    });
  }

  // 选择
  const ids = new Set((opts.ids || "").split(",").map((s) => s.trim()).filter(Boolean).map(Number));
  let picked;
  if (ids.size) picked = rows.filter((r) => ids.has(r.id));
  else if (opts.tier) picked = rows.filter((r) => String(r.tier).toUpperCase() === String(opts.tier).toUpperCase());
  else if (opts.all) picked = rows.filter((r) => r.cls === "RESIDUE");
  else picked = null;

  const missingIds = ids.size ? [...ids].filter((id) => !rows.some((r) => r.id === id)) : [];
  const L = [];
  const totalBytes = rows.reduce((a, r) => a + (r.bytes || 0), 0);

  L.push("## 待清理清单（" + plan.stamp + "）");
  L.push("");
  for (const r of rows) {
    const size = r.isDir ? fmtBytes(r.bytes) + "（目录，按已知体积）" : fmtBytes(r.bytes);
    L.push(padStart(String(r.id), 3) + "  " + r.tier + "  " + padStart(size, 12) + (r.exists ? "" : "（已不存在）") + "  " + r.reason);
    L.push("     " + shortPath(r.abs));
  }
  L.push("");
  L.push("合计 " + rows.length + " 项 / " + fmtBytes(totalBytes));
  if (broken.length) {
    L.push("");
    L.push("跳过 " + broken.length + " 项（路径不合法）：");
    for (const b of broken) L.push("  #" + b.it.id + " " + b.why);
  }
  if (missingIds.length) {
    L.push("");
    L.push("清单里没有这些编号：" + missingIds.join(","));
  }

  if (!picked) {
    L.push("");
    L.push("这次只是列清单，没有删任何东西。要清哪几项，带上编号重跑：");
    L.push("  apply --ids=1,3 --yes        只清这几项");
    L.push("  apply --tier=A --yes         清掉全部 A 档（明确是残留、可还原）");
    return { lines: L, code: 0 };
  }

  if (!picked.length) {
    L.push("");
    L.push("按你的条件没选中任何项。");
    return { lines: L, code: 0 };
  }

  const selBytes = picked.reduce((a, r) => a + (r.bytes || 0), 0);
  L.push("");
  L.push("选中 " + picked.length + " 项 / " + fmtBytes(selBytes) + (opts.yes ? "，开始送进回收站：" : "（还没删）。"));

  if (!opts.yes) {
    for (const r of picked) L.push("  #" + r.id + "  " + shortPath(r.abs));
    L.push("");
    L.push("确认无误就加 --yes 重跑同一条命令。");
    return { lines: L, code: 0 };
  }

  const live = picked.filter((r) => r.exists);
  if (!live.length) {
    L.push("这些项都已经不在了，无需清理。");
    return { lines: L, code: 0 };
  }

  const res = recyclePaths(live.map((r) => ({ id: r.id, path: r.abs })), { workDir: path.join(stateDir, "tmp") });
  if (process.env.DSH_CLEAN_DEBUG) console.error("recycle-result: " + JSON.stringify(res).slice(0, 2000));
  if (res.blocked) {
    L.push("没删成：" + res.reason);
    L.push("");
    L.push("原因：DSH 的文件沙箱挡着。在对话里请让 agent 用放宽沙箱（danger-full-access）重跑；自己手动跑则双击 apply.cmd。");
    return { lines: L, code: 3 };
  }
  if (!res.items.length) {
    L.push("没拿到回执：" + res.reason);
    return { lines: L, code: 2 };
  }

  const byId = new Map(res.items.map((x) => [Number(x.id), x]));
  const okRows = [];
  const badRows = [];
  for (const r of live) {
    const s = byId.get(r.id) || { status: "NO-RESULT", bin: "-" };
    (s.status === "RECYCLED" ? okRows : badRows).push({ r, s });
  }
  // 留痕：清过什么、什么时候清的、进箱还是失败，一条一行
  try {
    fs.appendFileSync(path.join(stateDir, "apply-log.jsonl"), JSON.stringify({
      at: Date.now(),
      ok: badRows.length === 0,
      items: live.map((r) => {
        const s = byId.get(r.id) || { status: "NO-RESULT", bin: "-" };
        return { id: r.id, path: r.abs, bytes: r.bytes, status: s.status, bin: s.bin };
      }),
    }) + "\n", "utf8");
  } catch { /* 日志写不了不影响清理结果 */ }

  for (const { r, s } of okRows) L.push("  已进回收站  #" + r.id + "  " + shortPath(r.abs) + (s.bin && s.bin !== "-" ? "  → " + s.bin : ""));
  for (const { r, s } of badRows) L.push("  失败 [" + s.status + "]  #" + r.id + "  " + shortPath(r.abs));

  L.push("");
  L.push("结果：" + okRows.length + " 项进回收站，" + badRows.length + " 项失败。回收站里可以还原。");
  return { lines: L, code: badRows.length ? 2 : 0 };
}
