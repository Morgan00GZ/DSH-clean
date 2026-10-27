import { fmtBytes, shortPath, padEnd, padStart } from "./util.mjs";

const ROLE = {
  install: "客户端安装目录",
  data: "用户数据（配置 / 插件 / 会话）",
  appdata: "Electron 用户数据",
  cache: "更新缓存",
  workspace: "工作区",
  related: "疑似相关（探测）",
};

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

function showRel(x) {
  const body = String(x.rel).split("/").join("\\");
  return x.rootId ? x.rootId + "\\" + body : body;
}

function stampText(sec) {
  if (!sec || !Number.isFinite(sec)) return "-";
  const d = new Date(sec * 1000);
  const p = (x) => String(x).padStart(2, "0");
  return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}

function day(sec) {
  const s = stampText(sec);
  return s === "-" ? s : s.slice(0, 10);
}

function p2(x) { return String(x).padStart(2, "0"); }

export function renderHuman(ctx) {
  const { version, machine, roots, stats, containers, residue, unknown, warnings, reportPath, sessions, purity } = ctx;
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

  L.push("纯净度（对比安装时的状态）");
  if (!purity.available) {
    L.push("  无法推断安装时刻：文件时间分布过于分散，改用规则判定（见残留一栏）");
  } else {
    if (purity.install) {
      const i = purity.install;
      const share = i.total ? (i.drift.length / i.total * 100) : 0;
      L.push("  安装时刻   " + stampText(i.epoch) + " · " + i.total.toLocaleString("en-US") + " 个文件中 " + (i.ratio * 100).toFixed(1) + "% 落在同一分钟");
      if (!i.drift.length) L.push("  安装目录   与安装时一致");
      else if (share < 0.5) L.push("  安装目录   偏离 " + i.drift.length + " 处（" + share.toFixed(2) + "%，多为保留原时间戳的静态文件）");
      else {
        L.push("  安装目录   偏离 " + i.drift.length + " 处（" + share.toFixed(1) + "%）");
        for (const f of i.drift.slice(0, 5)) L.push("    ~ " + f.rel + "  " + stampText(f.mtime));
      }
    }
    if (purity.hardEvidence.length) {
      L.push("  插件包     " + purity.hardEvidence.length + " 处手工改动痕迹（包内留了备份文件）");
      for (const h of purity.hardEvidence.slice(0, 3)) L.push("    ~ " + clip(h.rel, 70));
    } else {
      L.push("  插件包     未发现手工改动痕迹");
    }
    if (purity.configs.length) L.push("  配置文件   最近改动 " + stampText(purity.configs[0].mtime) + "（配置会正常变化，不计为脏）");
  }
  L.push("");

  L.push("会话");
  L.push("  " + sessions.count + " 个会话 · " + sessions.workspaces.length + " 个工作区 · " + fmtBytes(sessions.bytes) + " · " + sessions.files + " 个文件");
  for (const w of sessions.workspaces.slice(0, 3)) {
    L.push("  " + padEnd(clip(shortPath(w.path), 44), 44) + padStart(String(w.sessions), 4) + " 个  " + padStart(fmtBytes(w.bytes), 8) + (w.exists ? "" : "  [工作区已不存在]"));
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
  const { version, machine, roots, stats, residue, unknown, sessions, purity } = ctx;
  const parts = [
    "PURITY", "v" + version, "dsh=" + (machine.dshVersion || "?"),
    "roots=" + roots.length,
    "files=" + stats.files,
    "residue=" + residue.length + "/" + fmtBytes(stats.residueBytes),
    "unknown=" + unknown.length,
    "sessions=" + sessions.count + "/" + fmtBytes(sessions.bytes),
    "purity=" + (purity.available ? (purity.driftCount || 0) : "unknown"),
    "next=" + (residue.length || unknown.length ? "review" : "none"),
  ];
  let out = parts.join(" ");
  const notes = [];
  if (unknown.length) notes.push("ACTION " + unknown.length + " unknown entries pending; ask one by one");
  if (purity.available && purity.driftCount > 0) notes.push("PURITY-DRIFT " + purity.driftCount + " files changed since install");
  if (notes.length) out += "\n" + notes.join(" | ");
  return out;
}

export function renderJson(ctx) {
  const { version, machine, roots, stats, residue, unknown, warnings, reportPath, sessions, purity } = ctx;
  return JSON.stringify({
    schema: 1, version, machine,
    roots: roots.map((r) => ({ id: r.id, kind: r.kind, path: r.path, source: r.source, bytes: r.bytes, files: r.files })),
    stats,
    sessions: { count: sessions.count, bytes: sessions.bytes, workspaces: sessions.workspaces, suspicious: sessions.suspicious.length },
    purity, residue, unknown, warnings, reportPath,
  }, null, 2);
}

export function renderMarkdown(ctx) {
  const { version, machine, roots, stats, containers, residue, unknown, warnings, sessions, purity } = ctx;
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

  L.push("## 纯净度（对比安装时的状态）");
  L.push("");
  L.push("原理：安装器把文件写在同一分钟内，所以安装目录的修改时间有一个绝对主峰。偏离主峰的文件就是安装之后新增或被改过的。");
  L.push("");
  if (!purity.available) {
    L.push("无法推断：文件时间分布过于分散。改用规则判定（见残留）。");
  } else {
    if (purity.install) {
      const i = purity.install;
      L.push("- 推断的安装时刻：" + new Date(i.epoch * 1000).toISOString() + "（" + i.total + " 个文件中 " + (i.ratio * 100).toFixed(1) + "% 落在同一分钟）");
      L.push("- 安装目录偏离：" + i.drift.length + " 处");
      for (const f of i.drift) L.push("  - " + f.rel + "（" + new Date(f.mtime * 1000).toISOString() + "）");
    }
    L.push("- 插件包手工改动痕迹：" + (purity.hardEvidence.length || "无"));
    if (purity.hardEvidence.length) {
      L.push("");
      for (const h of purity.hardEvidence.slice(0, 20)) L.push("  - " + h.rel);
      L.push("");
      L.push("（插件包内文件的 mtime 由发布者决定、pnpm 硬链接又共享 ctime，所以不做逐文件时间推断；这里只认「包内出现备份文件」这类硬证据。）");
    }
    L.push("");
    L.push("配置文件（正常变化，不计为脏）：");
    for (const c of purity.configs.slice(0, 10)) L.push("- " + c.rel + " · " + new Date(c.mtime * 1000).toISOString());
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
