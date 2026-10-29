import fs from "node:fs";
import path from "node:path";
import { ensureDir, fmtBytes } from "./util.mjs";
import { recyclePaths } from "./recycle.mjs";

const REPORT_RE = /^\d{8}-\d{6}$/;
export const KEEP_DEFAULT = 10;

/** 旧布局（状态还放在安装目录里时）留下的状态文件名。 */
const LEGACY_FILES = [
  "roots.json", "patches.json", "roster.json", "probe-cache.json",
  "last-run.json", "sizes.json", "known.json", "node-path.txt",
];
const LEGACY_DIRS = ["inventory"];
/** 已经废掉、不需要补到新位置的文件：直接收走就行，别把垃圾搬运一遍。 */
const LEGACY_OBSOLETE = new Set(["node-path.txt"]);
const LEGACY_REPORTS = "reports";

function dirStats(dir) {
  let bytes = 0;
  let files = 0;
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        files++;
        try { bytes += fs.statSync(p).size; } catch { }
      }
    }
  };
  walk(dir);
  return { bytes, files };
}

export function collectReports(stateDir) {
  const dir = path.join(stateDir, "reports");
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!REPORT_RE.test(name)) continue;
    const abs = path.join(dir, name);
    let st = null;
    try { st = fs.statSync(abs); } catch { continue; }
    if (!st.isDirectory()) continue;
    const { bytes, files } = dirStats(abs);
    out.push({ name, abs, bytes, files });
  }
  out.sort((a, b) => (a.name < b.name ? 1 : -1));
  return out;
}

export function planReports(stateDir, keep = KEEP_DEFAULT) {
  const all = collectReports(stateDir);
  const k = Math.max(1, Number(keep) || KEEP_DEFAULT);
  return { all, kept: all.slice(0, k), drop: all.slice(k), keep: k };
}

/** 旧布局里的状态：本地没有的就先补过去，然后把旧的那份收走。 */
export function planLegacy(installRoot, stateDir, { migrate = true, keep = KEEP_DEFAULT, stateReportCount = 0 } = {}) {
  const retire = [];
  const migrated = [];
  if (path.resolve(installRoot) === path.resolve(stateDir)) return { retire, migrated };
  let hasRecord = false;
  try { hasRecord = fs.existsSync(path.join(installRoot, "install.json")); } catch { }
  if (!hasRecord) return { retire, migrated };

  for (const name of LEGACY_FILES) {
    const from = path.join(installRoot, name);
    if (!fs.existsSync(from)) continue;
    const to = path.join(stateDir, name);
    if (!LEGACY_OBSOLETE.has(name) && !fs.existsSync(to) && migrate) {
      try { ensureDir(stateDir); fs.copyFileSync(from, to); migrated.push(name); } catch { continue; }
    }
    retire.push({ name, abs: from, kind: "file", ...sizeOf(from) });
  }
  for (const name of LEGACY_DIRS) {
    const from = path.join(installRoot, name);
    if (!fs.existsSync(from)) continue;
    const to = path.join(stateDir, name);
    if (!fs.existsSync(to) && migrate) {
      try { ensureDir(to); fs.cpSync(from, to, { recursive: true }); migrated.push(name + "/"); } catch { continue; }
    }
    retire.push({ name, abs: from, kind: "dir", ...dirStats(from) });
  }
  // 旧报告：新位置的历史已经够长（>= 保留份数）就只收走，否则先补过来免得丢历史
  const fromReports = path.join(installRoot, LEGACY_REPORTS);
  if (fs.existsSync(fromReports) && stateReportCount < keep) {
    try {
      let names = [];
      try { names = fs.readdirSync(fromReports); } catch { names = []; }
      let copied = 0;
      for (const n of names) {
        if (!REPORT_RE.test(n)) continue;
        const to = path.join(stateDir, LEGACY_REPORTS, n);
        if (fs.existsSync(to)) continue;
        ensureDir(to);
        fs.cpSync(path.join(fromReports, n), to, { recursive: true });
        copied++;
      }
      if (copied) migrated.push(LEGACY_REPORTS + "/×" + copied);
    } catch { /* 补不过来就别收，留给人看 */ return { retire, migrated }; }
  }
  if (fs.existsSync(fromReports)) retire.push({ name: LEGACY_REPORTS, abs: fromReports, kind: "dir", ...dirStats(fromReports) });
  return { retire, migrated };
}

function sizeOf(p) {
  try { const st = fs.statSync(p); return { bytes: st.size, files: 1 }; } catch { return { bytes: 0, files: 0 }; }
}

export function runPrune({ installRoot, stateDir, keep = KEEP_DEFAULT, dryRun = false, legacy = true, agent = false }) {
  const notes = [];
  let migrated = [];
  if (legacy) {
    const lg = planLegacy(installRoot, stateDir, { migrate: !dryRun, keep: Number(keep) || KEEP_DEFAULT, stateReportCount: collectReports(stateDir).length });
    migrated = lg.migrated || [];
    if (lg.retire.length) {
      notes.push({ group: "legacy", items: lg.retire });
    }
  }
  // 状态目录里自己留下的废壳（旧版本的 inventory 快照目录，现在每次报告自带 run.json / plan.json）
  for (const name of ["inventory"]) {
    const abs = path.join(stateDir, name);
    if (!fs.existsSync(abs)) continue;
    const st = fs.statSync(abs);
    const empty = st.isDirectory() && (() => { try { return fs.readdirSync(abs).length === 0; } catch { return false; } })();
    notes.push({ group: "state", items: [{ name, abs, kind: st.isDirectory() ? "dir" : "file", ...(st.isDirectory() ? dirStats(abs) : sizeOf(abs)), empty }] });
  }

  // 回收站列表文件是每次清理的临时产物，不该攒着
  try {
    const tmpDir = path.join(stateDir, "tmp");
    const names = fs.readdirSync(tmpDir).filter((n) => /^recycle-list-.*\.json$/i.test(n));
    if (names.length) {
      notes.push({ group: "tmp", items: names.map((n) => ({ name: n, abs: path.join(tmpDir, n), kind: "file", ...sizeOf(path.join(tmpDir, n)) })) });
    }
  } catch { }

  const rp = planReports(stateDir, keep);
  if (rp.drop.length) notes.push({ group: "reports", items: rp.drop.map((r) => ({ name: r.name, abs: r.abs, kind: "dir", bytes: r.bytes, files: r.files })) });

  const entries = [];
  for (const g of notes) for (const it of g.items) entries.push({ id: entries.length + 1, path: it.abs, group: g.group, name: it.name, bytes: it.bytes });

  const sumBytes = entries.reduce((a, e) => a + (e.bytes || 0), 0);
  const sumReports = (notes.find((g) => g.group === "reports") || { items: [] }).items.length;
  const sumLegacy = (notes.find((g) => g.group === "legacy") || { items: [] }).items.length;

  const base = {
    ok: true, blocked: false, dryRun,
    keep: rp.keep, keptReports: rp.kept.length, totalReports: rp.all.length,
    droppedReports: sumReports, retiredLegacy: sumLegacy,
    bytes: sumBytes, migrated,
  };

  if (!entries.length) return { ...base, items: [], lines: ["状态与报告已经收拾干净，没有要收尾的东西。"] };
  if (dryRun) {
    return {
      ...base, items: entries,
      lines: [
        "要看清楚会收走什么（还没有真的收）：",
        ...entries.map((e) => "  [" + (e.group === "reports" ? "报告" : e.group === "state" ? "旧目录" : e.group === "tmp" ? "临时" : "旧状态") + "] " + e.name + "  " + fmtBytes(e.bytes || 0)),
        "合计 " + entries.length + " 项 / " + fmtBytes(sumBytes) + "。去掉 --dry-run 就真的收进回收站。",
      ],
    };
  }

  const res = recyclePaths(entries.map((e) => ({ id: e.id, path: e.path })), { workDir: path.join(stateDir, "tmp") });
  if (res.blocked) {
    return {
      ...base, ok: false, blocked: true, items: [],
      lines: ["收尾没做成：" + (res.reason || "当前环境不允许动回收站") + "，一个都没删。", "在放宽沙箱（danger-full-access）下再跑一次。"],
    };
  }
  const done = [];
  const failed = [];
  for (const it of (res.items || [])) {
    const src = entries.find((e) => e.id === Number(it.id));
    if (!src) continue;
    const rec = { ...src, status: it.status, bin: it.bin || "" };
    if (it.status === "RECYCLED") done.push(rec);
    else failed.push(rec);
  }
  const lines = [];
  if (done.length) {
    lines.push("已收进回收站 " + done.length + " 项（" + fmtBytes(done.reduce((a, b) => a + (b.bytes || 0), 0)) + "）");
    if (sumReports) lines.push("  报告：留最近 " + base.keptReports + " 份，收走 " + done.filter((d) => d.group === "reports").length + " 份");
    if (sumLegacy) lines.push("  旧状态：" + done.filter((d) => d.group === "legacy").length + " 个文件/目录（状态与报告已经在新位置，旧的那份只是重复）");
    const stN = done.filter((d) => d.group === "state").length;
    if (stN) lines.push("  状态目录里的废壳：" + stN + " 个（旧 inventory 快照目录，已不用）");
    const tmpN = done.filter((d) => d.group === "tmp").length;
    if (tmpN) lines.push("  清理时生成的临时清单：" + tmpN + " 个");
    if (migrated.length) lines.push("  先补到新位置再收走的：" + migrated.join(" "));
  }
  if (failed.length) {
    lines.push("没进回收站 " + failed.length + " 项：");
    for (const f of failed) lines.push("  " + f.name + "  " + f.status);
  }
  if (base.totalReports && !sumReports) lines.push("报告共 " + base.totalReports + " 份，没超过保留数（" + rp.keep + "）。");
  lines.push("回收站里都还在，随时能还原。");
  return { ...base, ok: failed.length === 0, items: done, failed, lines };
}
