import path from "node:path";
import { fmtBytes, shortPath, padEnd, padStart } from "./util.mjs";

function showRel(x) {
  const body = String(x.rel).split("/").join("\\");
  return x.rootId ? x.rootId + "\\" + body : body;
}

function pct(part, total) {
  if (!total) return "";
  return (part / total * 100).toFixed(0) + "%";
}

export function renderHuman(ctx) {
  const { version, machine, roots, stats, containers, residue, unknown, warnings, reportPath } = ctx;
  const L = [];
  const d = new Date();
  const p2 = (x) => String(x).padStart(2, "0");
  L.push(`DSH-clean v${version} - ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`);
  L.push("");

  if (warnings.length) {
    L.push("提示");
    for (const w of warnings) L.push("  ! " + w);
    L.push("");
  }

  L.push("环境");
  L.push("  DSH 桌面端   " + (machine.desktopVersion || "未知"));
  L.push("  DSH 运行时   " + (machine.dshVersion || "未知"));
  L.push("  根目录       " + roots.length + " 个");
  L.push("");

  L.push("根目录");
  const wId = Math.max(...roots.map((r) => r.id.length), 3);
  for (const r of roots) {
    L.push("  " + padEnd(r.id, wId) + "  " + padEnd(shortPath(r.path), 46) + "  " + r.source);
  }
  L.push("");

  L.push(`本轮  文件 ${stats.files.toLocaleString("en-US")} · 体积 ${fmtBytes(stats.bytes)} · 耗时 ${stats.seconds.toFixed(1)}s`);
  if (stats.changed !== null) {
    L.push(`变化  新增 ${stats.added} · 改动 ${stats.changed} · 消失 ${stats.gone}`);
  }
  L.push(
    `归类  KEEP ${stats.keep.toLocaleString("en-US")} · CACHE ${stats.cache.toLocaleString("en-US")} · RESIDUE ${residue.length} (${fmtBytes(stats.residueBytes)}) · UNKNOWN ${unknown.length}`
  );
  L.push("");

  const aCount = residue.filter((x) => x.tier === "A").length;
  const bCount = residue.filter((x) => x.tier === "B").length;
  L.push(`残留（A 档 ${aCount} · B 档 ${bCount}）`);
  if (residue.length === 0) {
    L.push("  无");
  } else {
    residue.slice(0, 20).forEach((x, i) => {
      const size = x.size ? fmtBytes(x.size) : "-";
      L.push(
        "  " + padStart(String(i + 1), 2) + "  " + x.tier + "  " + padEnd(showRel(x), 56) + "  " + padStart(size, 9) + "  " + x.reason
      );
    });
    if (residue.length > 20) L.push("  ... 另有 " + (residue.length - 20) + " 条，见报告");
  }
  L.push("");

  L.push(`未归类（${unknown.length}）—— 一句话就能定性，之后进判例库`);
  if (unknown.length === 0) {
    L.push("  无");
  } else {
    for (const u of unknown.slice(0, 10)) {
      L.push("  · " + shortPath(showRel(u)) + "  (" + u.files + " 个文件, " + fmtBytes(u.bytes) + ")");
    }
    if (unknown.length > 10) L.push("  ... 另有 " + (unknown.length - 10) + " 条，见 pending.md");
  }
  L.push("");

  L.push("报告    " + reportPath);
  if (residue.length || unknown.length) {
    L.push("下一步  P0 只读：以上仅为判定结果，清理能力在 P1 提供");
  } else {
    L.push("下一步  干净，无需操作");
  }
  return L.join("\n");
}

export function renderAgent(ctx) {
  const { version, machine, roots, stats, residue, unknown } = ctx;
  const parts = [
    "PURITY",
    "v" + version,
    "dsh=" + (machine.dshVersion || "?"),
    "roots=" + roots.length,
    "files=" + stats.files,
    "changed=" + (stats.changed === null ? stats.files : stats.changed),
    "keep=" + stats.keep,
    "cache=" + stats.cache,
    "residue=" + residue.length + "/" + fmtBytes(stats.residueBytes),
    "unknown=" + unknown.length,
    "locked=0",
    "next=" + (residue.length || unknown.length ? "review" : "none"),
  ];
  let out = parts.join(" ");
  if (unknown.length) out += "\nACTION " + unknown.length + " unknown entries pending; ask the user one by one";
  return out;
}

export function renderJson(ctx) {
  return JSON.stringify(
    {
      schema: 1,
      version: ctx.version,
      machine: ctx.machine,
      roots: ctx.roots.map((r) => ({ id: r.id, kind: r.kind, path: r.path, source: r.source })),
      stats: ctx.stats,
      residue: ctx.residue,
      unknown: ctx.unknown,
      warnings: ctx.warnings,
      reportPath: ctx.reportPath,
    },
    null,
    2
  );
}

export function renderMarkdown(ctx) {
  const { version, machine, roots, stats, containers, residue, unknown, warnings } = ctx;
  const L = [];
  L.push("# DSH-clean 报告");
  L.push("");
  L.push("- 版本：" + version);
  L.push("- 时间：" + new Date().toISOString());
  L.push("- DSH 桌面端：" + (machine.desktopVersion || "未知") + " / 运行时：" + (machine.dshVersion || "未知"));
  L.push("- 文件：" + stats.files + " / 体积：" + fmtBytes(stats.bytes) + " / 耗时：" + stats.seconds.toFixed(1) + "s");
  L.push("- 说明：本报告只做判定，不移动、不删除任何文件。");
  L.push("");
  if (warnings.length) {
    L.push("## 提示");
    for (const w of warnings) L.push("- " + w);
    L.push("");
  }
  L.push("## 根目录");
  L.push("");
  L.push("| id | 路径 | 来源 |");
  L.push("|---|---|---|");
  for (const r of roots) L.push("| " + r.id + " | " + r.path + " | " + r.source + " |");
  L.push("");
  L.push("## 顶层目录归属");
  L.push("");
  L.push("| 根 | 目录 | 归属 | 判定 | 文件数 | 体积 | 说明 |");
  L.push("|---|---|---|---|---|---|---|");
  for (const c of containers.sort((a, b) => b.bytes - a.bytes)) {
    L.push("| " + c.rootId + " | " + c.name + " | " + c.owner + " | " + c.class + " | " + c.files + " | " + fmtBytes(c.bytes) + " | " + c.reason + " |");
  }
  L.push("");
  L.push("## 残留（" + residue.length + "）");
  L.push("");
  if (!residue.length) L.push("无");
  else {
    L.push("| # | 档 | 路径 | 体积 | 判据 | 说明 |");
    L.push("|---|---|---|---|---|---|");
    residue.forEach((x, i) => L.push("| " + (i + 1) + " | " + x.tier + " | " + x.rel + " | " + fmtBytes(x.size) + " | " + x.rule + " | " + x.reason + " |"));
  }
  L.push("");
  L.push("## 未归类（" + unknown.length + "）");
  L.push("");
  if (!unknown.length) L.push("无");
  else {
    L.push("| 根 | 目录 | 文件数 | 体积 | 说明 |");
    L.push("|---|---|---|---|---|");
    for (const u of unknown) L.push("| " + u.rootId + " | " + u.rel + " | " + u.files + " | " + fmtBytes(u.bytes) + " | " + u.reason + " |");
  }
  L.push("");
  return L.join("\n");
}
