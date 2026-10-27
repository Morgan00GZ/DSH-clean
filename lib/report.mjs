import { fmtBytes, shortPath, padEnd, padStart } from "./util.mjs";

const ROLE = {
  install: "客户端安装目录",
  data: "用户数据（配置 / 插件 / 会话）",
  appdata: "Electron 用户数据",
  cache: "更新缓存",
  workspace: "工作区",
  related: "疑似相关（探测）",
};

function showRel(x) {
  const body = String(x.rel).split("/").join("\\");
  return x.rootId ? x.rootId + "\\" + body : body;
}

function day(sec) {
  if (!sec || !Number.isFinite(sec)) return "-";
  const d = new Date(sec * 1000);
  const p = (x) => String(x).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
}

function p2(x) { return String(x).padStart(2, "0"); }

function clip(s, n) {
  const str = String(s);
  if (str.length <= n) return str;
  const keep = n - 1;
  return str.slice(0, Math.ceil(keep * 0.55)) + "…" + str.slice(-Math.floor(keep * 0.45));
}

function shortId(id, n = 18) {
  const s = String(id);
  if (s.length <= n) return s;
  const keep = n - 1;
  return s.slice(0, Math.ceil(keep * 0.6)) + "…" + s.slice(-Math.floor(keep * 0.4));
}

export function renderHuman(ctx) {
  const { version, machine, roots, stats, containers, residue, unknown, warnings, reportPath, changes, sessions, drift } = ctx;
  const L = [];
  const d = new Date();
  L.push("DSH-clean v" + version + " - " + d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) + " " + p2(d.getHours()) + ":" + p2(d.getMinutes()));
  L.push("");

  if (warnings.length) {
    L.push("提示");
    for (const w of warnings) L.push("  ! " + w);
    L.push("");
  }

  L.push("环境");
  L.push("  DSH 桌面端   " + (machine.desktopVersion || "未知"));
  L.push("  DSH 运行时   " + (machine.dshVersion || "未知"));
  L.push("  总占用       " + fmtBytes(stats.bytes) + " · " + stats.files.toLocaleString("en-US") + " 个文件 · 耗时 " + stats.seconds.toFixed(1) + "s");
  L.push("");

  L.push("DSH 相关文件夹（" + roots.length + "）");
  for (const r of roots) {
    L.push("  " + padEnd(shortId(r.id), 19) + padEnd(clip(shortPath(r.path), 40), 40) + padStart(fmtBytes(r.bytes), 8) + "  " + (ROLE[r.kind] || r.kind) + " · " + r.source + (r.shallow ? " · 浅扫" : ""));
  }
  L.push("");

  const top = containers.slice().sort((a, b) => b.bytes - a.bytes).slice(0, 12);
  L.push("占用最大的顶层项");
  for (const c of top) {
    L.push("  " + padEnd(clip(c.rootId + "\\" + c.name, 36), 36) + padStart(fmtBytes(c.bytes), 8) + padStart(String(c.files), 7) + " 个文件  " + c.reason);
  }
  L.push("");

  L.push("本轮变动");
  if (!changes.counts.anyPrev) {
    L.push("  首次运行，暂无对比基准（下次开始报告差异）");
  } else {
    L.push("  新增 " + changes.counts.added + " · 改动 " + changes.counts.changed + " · 消失 " + changes.counts.gone);
    const sample = changes.added.slice(0, 5);
    for (const a of sample) L.push("  + " + padEnd(showRel(a), 60) + padStart(fmtBytes(a.size), 8));
    for (const c of changes.changed.slice(0, 3)) L.push("  ~ " + showRel(c));
    if (!sample.length && !changes.changed.length) L.push("  无实质变化");
  }
  L.push("");

  L.push("与基线比较");
  if (!drift.available) {
    L.push("  尚未建立基线。建议在「刚安装并配置完毕」时说一声，我跑一次 baseline 记录基准。");
  } else {
    L.push("  基线时间 " + day(drift.createdAt / 1000) + " · 差异 " + drift.driftCount + " 项");
    if (drift.install) {
      const i = drift.install;
      const verdict = i.ratio > 0.05 ? "整体变动，可能已升级" : (i.added.length + i.changed.length + i.gone.length === 0 ? "与基线一致" : "有局部变化");
      L.push("  安装目录  新增 " + i.added.length + " · 改动 " + i.changed.length + " · 消失 " + i.gone.length + "（" + verdict + "）");
      for (const rel of i.added.slice(0, 3)) L.push("    + " + rel);
      for (const rel of i.changed.slice(0, 3)) L.push("    ~ " + rel);
    }
    for (const c of drift.configs.slice(0, 5)) L.push("  配置  " + (c.state === "missing" ? "缺失 " : "已改 ") + c.rel);
    if (drift.dataTop) {
      for (const n of drift.dataTop.added.slice(0, 5)) L.push("  顶层新增  " + n);
      for (const n of drift.dataTop.gone.slice(0, 5)) L.push("  顶层消失  " + n);
    }
  }
  L.push("");

  L.push("会话");
  L.push("  " + sessions.count + " 个会话 · " + sessions.workspaces.length + " 个工作区 · " + fmtBytes(sessions.bytes) + " · " + sessions.files + " 个文件");
  for (const w of sessions.workspaces.slice(0, 3)) {
    L.push("  " + padEnd(shortPath(w.path), 46) + padStart(String(w.sessions), 4) + " 个  " + padStart(fmtBytes(w.bytes), 8) + (w.exists ? "" : "  [工作区已不存在]"));
  }
  if (sessions.suspicious.length) L.push("  可疑 " + sessions.suspicious.length + " 个（半成品 / 0 字节）");
  L.push("");

  const aCount = residue.filter((x) => x.tier === "A").length;
  const bCount = residue.filter((x) => x.tier === "B").length;
  L.push("残留（A 档 " + aCount + " · B 档 " + bCount + " · 合计 " + fmtBytes(stats.residueBytes) + "）");
  if (!residue.length) L.push("  无");
  else {
    residue.slice(0, 12).forEach((x, i) => {
      L.push("  " + padStart(String(i + 1), 2) + "  " + x.tier + "  " + padEnd(clip(showRel(x), 54), 54) + "  " + padStart(x.size ? fmtBytes(x.size) : "-", 9) + "  " + x.reason);
    });
    if (residue.length > 12) L.push("  ... 另有 " + (residue.length - 12) + " 条，见报告");
  }
  L.push("");

  L.push("未归类（" + unknown.length + "）");
  if (!unknown.length) L.push("  无");
  else for (const u of unknown.slice(0, 8)) L.push("  · " + showRel(u) + "  (" + u.files + " 个文件)");

  L.push("");
  L.push("报告    " + reportPath);
  L.push("下一步  " + (residue.length || unknown.length ? "P0 只读：以上为判定结果，清理在 P1 提供" : "干净，无需操作"));
  return L.join("\n");
}

export function renderAgent(ctx) {
  const { version, machine, roots, stats, residue, unknown, sessions, drift } = ctx;
  const parts = [
    "PURITY", "v" + version, "dsh=" + (machine.dshVersion || "?"),
    "roots=" + roots.length,
    "files=" + stats.files,
    "changed=" + (stats.changed === null ? stats.files : stats.changed),
    "keep=" + stats.keep,
    "cache=" + stats.cache,
    "residue=" + residue.length + "/" + fmtBytes(stats.residueBytes),
    "unknown=" + unknown.length,
    "sessions=" + sessions.count + "/" + fmtBytes(sessions.bytes),
    "drift=" + (drift.available ? drift.driftCount : "none"),
    "next=" + (residue.length || unknown.length ? "review" : "none"),
  ];
  let out = parts.join(" ");
  const notes = [];
  if (unknown.length) notes.push("ACTION " + unknown.length + " unknown entries pending; ask one by one");
  if (drift.available && drift.driftCount > 0) notes.push("DRIFT " + drift.driftCount + " differences from baseline");
  if (notes.length) out += "\n" + notes.join(" | ");
  return out;
}

export function renderJson(ctx) {
  const { version, machine, roots, stats, residue, unknown, warnings, reportPath, changes, sessions, drift } = ctx;
  return JSON.stringify({
    schema: 1, version, machine,
    roots: roots.map((r) => ({ id: r.id, kind: r.kind, path: r.path, source: r.source, bytes: r.bytes })),
    stats, changes: { counts: changes.counts, added: changes.added, gone: changes.gone, changed: changes.changed },
    sessions: { count: sessions.count, bytes: sessions.bytes, workspaces: sessions.workspaces, suspicious: sessions.suspicious.length },
    drift, residue, unknown, warnings, reportPath,
  }, null, 2);
}

export function renderMarkdown(ctx) {
  const { version, machine, roots, stats, containers, residue, unknown, warnings, changes, sessions, drift } = ctx;
  const L = [];
  L.push("# DSH-clean 报告");
  L.push("");
  L.push("- 版本：" + version);
  L.push("- 时间：" + new Date().toISOString());
  L.push("- DSH 桌面端：" + (machine.desktopVersion || "未知") + " / 运行时：" + (machine.dshVersion || "未知"));
  L.push("- 文件：" + stats.files + " / 体积：" + fmtBytes(stats.bytes) + " / 耗时：" + stats.seconds.toFixed(1) + "s");
  L.push("- 说明：只做判定，不移动、不删除任何文件。");
  L.push("");
  if (warnings.length) { L.push("## 提示"); for (const w of warnings) L.push("- " + w); L.push(""); }

  L.push("## DSH 相关文件夹");
  L.push("");
  L.push("| id | 路径 | 作用 | 来源 | 体积 | 文件数 |");
  L.push("|---|---|---|---|---|---|");
  for (const r of roots) L.push("| " + r.id + " | " + r.path + " | " + (ROLE[r.kind] || r.kind) + " | " + r.source + " | " + fmtBytes(r.bytes) + " | " + r.files + " |");
  L.push("");

  L.push("## 顶层目录");
  L.push("");
  L.push("| 根 | 目录 | 归属 | 判定 | 文件数 | 体积 | 说明 |");
  L.push("|---|---|---|---|---|---|---|");
  for (const c of containers.slice().sort((a, b) => b.bytes - a.bytes)) {
    L.push("| " + c.rootId + " | " + c.name + " | " + c.owner + " | " + c.class + " | " + c.files + " | " + fmtBytes(c.bytes) + " | " + c.reason + " |");
  }
  L.push("");

  L.push("## 本轮变动（与上次扫描比较）");
  L.push("");
  if (!changes.counts.anyPrev) L.push("首次运行，无对比基准。");
  else {
    L.push("- 新增 " + changes.counts.added + " · 改动 " + changes.counts.changed + " · 消失 " + changes.counts.gone);
    L.push("");
    if (changes.added.length) { L.push("### 新增"); for (const a of changes.added.slice(0, 50)) L.push("- " + showRel(a) + "  " + fmtBytes(a.size)); }
    if (changes.changed.length) { L.push(""); L.push("### 改动"); for (const c of changes.changed.slice(0, 50)) L.push("- " + showRel(c)); }
    if (changes.gone.length) { L.push(""); L.push("### 消失"); for (const g of changes.gone.slice(0, 50)) L.push("- " + showRel(g)); }
  }
  L.push("");

  L.push("## 与基线比较");
  L.push("");
  if (!drift.available) L.push("尚未建立基线（运行 `dsh-clean baseline` 记录「刚安装并配置完毕」的状态）。");
  else {
    L.push("- 基线时间：" + new Date(drift.createdAt).toISOString());
    if (drift.install) {
      const i = drift.install;
      L.push("- 安装目录：新增 " + i.added.length + " / 改动 " + i.changed.length + " / 消失 " + i.gone.length + "（占基线文件 " + (i.ratio * 100).toFixed(2) + "%）");
      for (const rel of i.added.slice(0, 20)) L.push("  - 新增 " + rel);
      for (const rel of i.changed.slice(0, 20)) L.push("  - 改动 " + rel);
      for (const rel of i.gone.slice(0, 20)) L.push("  - 消失 " + rel);
    }
    for (const c of drift.configs) L.push("- 配置 " + c.state + "：" + c.rel);
    if (drift.dataTop) {
      for (const n of drift.dataTop.added) L.push("- 顶层新增：" + n);
      for (const n of drift.dataTop.gone) L.push("- 顶层消失：" + n);
    }
  }
  L.push("");

  L.push("## 会话");
  L.push("");
  L.push("| 工作区 | 会话数 | 文件数 | 体积 | 最早 | 最新 | 状态 |");
  L.push("|---|---|---|---|---|---|---|");
  for (const w of sessions.workspaces) {
    L.push("| " + w.path + " | " + w.sessions + " | " + w.files + " | " + fmtBytes(w.bytes) + " | " + day(w.oldest) + " | " + day(w.newest) + " | " + (w.exists ? "正常" : "工作区已不存在") + " |");
  }
  L.push("");
  if (sessions.suspicious.length) {
    L.push("可疑文件（半成品 / 0 字节）：");
    for (const s of sessions.suspicious.slice(0, 20)) L.push("- " + s.rel + "  " + fmtBytes(s.size));
    L.push("");
  }

  L.push("## 残留（" + residue.length + "）");
  L.push("");
  if (!residue.length) L.push("无");
  else {
    L.push("| # | 档 | 路径 | 体积 | 判据 | 说明 |");
    L.push("|---|---|---|---|---|---|");
    residue.forEach((x, i) => L.push("| " + (i + 1) + " | " + x.tier + " | " + showRel(x) + " | " + fmtBytes(x.size) + " | " + x.rule + " | " + x.reason + " |"));
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
