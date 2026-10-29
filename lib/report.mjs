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

const PATCH_STATUS = {
  ok: "在位",
  restored: "已恢复成 pnpm 原件（升级或重装把补丁覆盖了）",
  changed: "内容又变了（与记录不一致）",
  missing: "文件不在了",
};

function patchBlock(patches, L) {
  if (!patches || !patches.total) return;
  L.push("  已知改动    " + patches.accepted + " 处（你自己改的，补丁在位，不算脏）");
  for (const p of (patches.items || []).filter((x) => x.status === "ok").slice(0, 4)) {
    L.push("    * " + clip(shortPath(p.path), 62) + (p.note ? "  " + p.note : ""));
  }
  if (patches.bad && patches.bad.length) {
    L.push("  补丁异常    " + patches.bad.length + " 处");
    for (const p of patches.bad.slice(0, 4)) L.push("    ! " + clip(shortPath(p.path), 62) + "  " + (PATCH_STATUS[p.status] || p.status));
  }
}

function baselineText(integrity) {
  if (!integrity || !integrity.baseline) return null;
  const b = integrity.baseline;
  const when = new Date(b.createdAt);
  const dz = (n) => (n < 10 ? "0" : "") + n;
  const at = (when.getMonth() + 1) + "-" + dz(when.getDate()) + " " + dz(when.getHours()) + ":" + dz(when.getMinutes());
  return "本机首次信任 · 建立于 " + at + " · " + Number(b.count || 0).toLocaleString("en-US") + " 个文件" + (b.dshVersion ? "（客户端 " + b.dshVersion + "）" : "");
}

function deltaText(n, isNew) {
  if (isNew) return "新增";
  if (!n) return "—";
  return (n > 0 ? "+" : "-") + fmtBytes(Math.abs(n));
}

export function renderHuman(ctx) {
  const { version, machine, roots, stats, containers, residue, unknown, warnings, reportPath, sessions, purity, plugins, patches, probe, locked, known, changes } = ctx;
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
  L.push("  总占用       " + fmtBytes(stats.bytes) + " · " + stats.files.toLocaleString("en-US") + " 个文件 · 较上次 " + deltaText(stats.delta, false) + " · 耗时 " + stats.seconds.toFixed(1) + "s");
  if (changes) {
    const signed = (n) => (n > 0 ? "+" + n : String(n));
    const bits = [];
    if (changes.files) bits.push("文件 " + signed(changes.files));
    if (changes.residue) bits.push("残留 " + signed(changes.residue));
    if (changes.unknown) bits.push("未归类 " + signed(changes.unknown));
    if (changes.sessions) bits.push("会话 " + signed(changes.sessions));
    if (changes.known) bits.push("判例 " + signed(changes.known));
    if (bits.length) L.push("较上次扫描：" + bits.join(" · "));
    else L.push("较上次扫描：没有变化");
  }
  L.push("");

  L.push("DSH 相关文件夹（" + roots.length + "）");
  for (const r of roots) {
    L.push("  " + padEnd(shortId(r.id), 19) + padEnd(clip(shortPath(r.path), 40), 40) + padStart(fmtBytes(r.bytes), 8) + "  " + (ROLE[r.kind] || r.kind) + " · " + r.source + (r.shallow ? " · 浅扫" : ""));
  }
  L.push("");

  const top = containers.slice().sort((a, b) => b.bytes - a.bytes).slice(0, 12);
  L.push("占用最大的顶层项");
  for (const c of top) {
    L.push("  " + padEnd(clip(c.rootId + "\\" + c.name, 34), 34) + padStart(fmtBytes(c.bytes), 8) + padStart(deltaText(c.delta, c.isNew), 9) + padStart(String(c.files), 7) + " 个  " + c.reason);
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
      if (purity.explained && purity.explained.length) {
        L.push("  已解释     " + purity.explained.length + " 处发行方自带的说明文件（保留原时间戳，不算脏）：" +
          purity.explained.slice(0, 3).map((f) => f.rel.split("/").pop()).join("、") +
          (purity.explained.length > 3 ? " 等" : ""));
      }
    }
    const bt = baselineText(purity.integrity);
    if (bt) {
      const g = purity.integrity;
      L.push("  基线       " + bt);
      const bad = (g.added || []).length + (g.modified || []).length + (g.removed || []).length;
      if (!bad) L.push("  逐文件     与基线一致" + (g.status === "version-changed" ? "（客户端版本变了，建议 verify --rebase）" : "") + " · 这次没读盘算哈希");
      else {
        L.push("  逐文件     与基线不一致 " + bad + " 处（改 " + g.modified.length + " · 增 " + g.added.length + " · 少 " + g.removed.length + "）");
        for (const f of g.modified.slice(0, 4)) L.push("    ~ " + clip(f.rel, 60) + "  内容变了");
        for (const f of g.added.slice(0, 4)) L.push("    + " + clip(f.rel, 60) + "  多出来的");
        for (const f of g.removed.slice(0, 4)) L.push("    - " + clip(f.rel, 60) + "  不见了");
      }
    }
    L.push("  插件包     见下方「插件包（pnpm 仓库校验）」一节");
    if (purity.configs.length) L.push("  配置文件   最近改动 " + stampText(purity.configs[0].mtime) + "（配置会正常变化，不计为脏）");
  }
  patchBlock(patches, L);
  L.push("");

  L.push("插件包（pnpm 仓库校验）");
  if (plugins.storeUsable) {
    L.push("  已核对      " + plugins.packages + " 个包 · " + plugins.files.toLocaleString("en-US") + " 个文件 · 硬链接完好 " + plugins.linked.toLocaleString("en-US"));
  } else {
    L.push("  已核对      " + plugins.packages + " 个包 · " + plugins.files + " 个文件（未找到 pnpm 仓库，跳过原件校验）");
  }
  if (plugins.modified.length) {
    L.push("  被改过      " + plugins.modified.length + " 个文件");
    for (const m of plugins.modified.slice(0, 5)) {
      L.push("    ~ " + clip(m.pkg + "\\" + m.rel.split("/node_modules/").pop(), 64) + (m.isOriginal ? "（内容仍是原件）" : "（内容与原件不同）"));
    }
  } else L.push("  被改过      无");
  if (plugins.unverifiable && plugins.unverifiable.length) {
    L.push("  无法校验    " + plugins.unverifiable.length + " 个文件（" + (plugins.storeEmpty ? "pnpm 仓库已被清理" : plugins.storeMismatch ? "仓库与安装不同源，几乎一条都对不上" : "仓库里没有对应原件") + "，对照不了，不算脏）");
  }
  if (plugins.added.length) {
    L.push("  多余/副本   " + plugins.added.length + " 个");
    for (const a of plugins.added.slice(0, 4)) L.push("    + " + clip(a.pkg + "\\" + a.rel.split("/node_modules/").pop(), 64) + "  " + a.reason);
  }
  const lk = plugins.lock;
  if (lk.declared || lk.installed) {
    L.push("  名册对账    声明 " + lk.declared + " · 实际 " + lk.installed + " · 孤儿 " + lk.orphans.length + " · 缺失 " + lk.missing.length + " · 版本不符 " + lk.mismatched.length);
    for (const o of lk.orphans.slice(0, 3)) L.push("    ! 孤儿包 " + o);
    for (const m of lk.mismatched.slice(0, 3)) L.push("    ! 版本不符 " + m.name + "（声明 " + m.declared + " / 实际 " + m.installed + "）");
  }
  L.push("");

  const dataRootId = (roots.find((r) => r.kind === "data") || {}).id;
  const HOST_INFRA = new Set([
    "sessions", "logs", "storages", "cache", "profiles", "dsh-runtimes", "dsh-ops", "models",
    "memory", "tool-management", "integrations", "attachments", "guardian", "remote",
    "remote-web-ui-registry", "telemetry", "channel-pack", "cloudflared-bin", "subagent-gc-backup",
    "redteam", "skills",
  ]);
  const pluginDirs = containers
    .filter((c) => c.rootId === dataRootId && !HOST_INFRA.has(c.name))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 8);
  if (pluginDirs.length) {
    L.push("插件数据目录（占多少 / 这次多了多少）");
    for (const c of pluginDirs) {
      L.push("  " + padEnd(clip(c.name, 26), 26) + padStart(fmtBytes(c.bytes), 8) + padStart(deltaText(c.delta, c.isNew), 9) + "  " + (c.lastWrite ? "最近写入 " + day(c.lastWrite) : ""));
    }
    L.push("");
  }

  L.push("会话");
  L.push("  " + sessions.count + " 个会话 · " + sessions.workspaces.length + " 个工作区 · " + fmtBytes(sessions.bytes) + " · " + sessions.files + " 个文件");
  for (const w of sessions.workspaces.slice(0, 3)) {
    L.push("  " + padEnd(clip(shortPath(w.path), 44), 44) + padStart(String(w.sessions), 4) + " 个  " + padStart(fmtBytes(w.bytes), 8) + (w.exists ? "" : "  [工作区已不存在]"));
  }
  if (sessions.suspicious.length) L.push("  可疑 " + sessions.suspicious.length + " 个（半成品 / 0 字节）");
  const emptyWs = (sessions.emptyWorkSpaces || []).filter((w) => !w.exists).length;
  const liveEmptyWs = (sessions.emptyWorkSpaces || []).filter((w) => w.exists).length;
  const emptySess = (sessions.emptySessions || []).length;
  const orphanWs = (sessions.orphanWorkspaces || []).length;
  if (emptyWs || emptySess || orphanWs || liveEmptyWs) {
    const bits = [];
    if (emptyWs) bits.push("空工作区（工作区已不存在）" + emptyWs + " 个");
    if (liveEmptyWs) bits.push("工作区还在的空容器 " + liveEmptyWs + " 个（不列入清理）");
    if (emptySess) bits.push("空会话 " + emptySess + " 个");
    if (orphanWs) bits.push("工作区已消失但留着历史 " + orphanWs + " 个");
    L.push("  可收尾的：" + bits.join(" · ") + "（跑 review 看清单）");
  }
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

  if (locked && locked.length) {
    L.push("正在使用（这次不判，下次再看）");
    for (const x of locked.slice(0, 8)) L.push("  ~ " + padEnd(clip(x.rootId + ":" + x.rel, 54), 54) + "  " + padStart(x.size ? fmtBytes(x.size) : "-", 9));
    if (locked.length > 8) L.push("  ... 另有 " + (locked.length - 8) + " 条");
    L.push("");
  }

  if (probe && probe.suspects && probe.suspects.length) {
    L.push("疑似相关（有线索，没纳入扫描 — 要我算进来就说一声）");
    for (const s of probe.suspects.slice(0, 8)) L.push("  ? " + padEnd(clip(shortPath(s.path), 42), 42) + "  " + s.evidence.join("；"));
    L.push("");
  }

  L.push("未归类（" + unknown.length + "）");
  if (!unknown.length) L.push("  无");
  else for (const u of unknown.slice(0, 8)) L.push("  · " + showRel(u) + "  (" + u.files + " 个文件)");
  L.push("");

  if (known && known.total) {
    L.push("判例库（" + known.total + " 条" + (known.stale ? " · 已失效 " + known.stale : "") + "）");
    for (const k of known.items.slice(0, 8)) {
      L.push("  " + padEnd(clip(k.class, 8), 8) + k.rootId + ":" + k.rel + (k.reason ? "  " + clip(k.reason, 40) : ""));
    }
    if (known.total > 8) L.push("  ... 另有 " + (known.total - 8) + " 条");
    L.push("");
  }
  L.push("报告    " + reportPath);
  const heavy = ctx.reportsCount && ctx.reportsCount > REPORT_KEEP;
  L.push("下一步  " + (residue.length || unknown.length ? "要清理就跑 review / apply；要记住判定就跑 judge" : "干净，无需操作"));
  if (heavy) L.push("收尾    " + "历史报告已有 " + ctx.reportsCount + " 份，跑 prune 只留最近 " + REPORT_KEEP + " 份");
  return L.join("\n");
}

export const REPORT_KEEP = 10;

export function renderAgent(ctx) {
  const { version, machine, roots, stats, residue, unknown, sessions, purity, plugins, patches, probe, reportPath, locked, known } = ctx;
  const parts = [
    "PURITY", "v" + version, "dsh=" + (machine.dshVersion || "?"),
    "roots=" + roots.length,
    "files=" + stats.files,
    "residue=" + residue.length + "/" + fmtBytes(stats.residueBytes),
    "unknown=" + unknown.length,
    "sessions=" + sessions.count + "/" + fmtBytes(sessions.bytes),
    "purity=" + (purity.available ? (purity.driftCount || 0) : "unknown"),
    "integrity=" + (purity.integrity && purity.integrity.baseline ? ((purity.integrity.added || []).length + (purity.integrity.modified || []).length + (purity.integrity.removed || []).length || "ok") : "none"),
    "plugins=" + plugins.packages + "/" + plugins.driftCount,
    "patch=" + (patches ? patches.accepted : 0) + "/" + (patches && patches.bad ? patches.bad.length : 0),
    "probe=+" + (probe ? probe.found : 0) + "/" + (probe ? probe.suspects.length : 0),
    "locked=" + (locked ? locked.length : 0),
    "known=" + (known ? known.total : 0),
    "next=" + (residue.length || unknown.length ? "review" : "none"),
  ];
  if (ctx.reportsCount && ctx.reportsCount > REPORT_KEEP) parts.push("reports=" + ctx.reportsCount + "/prune");
  let out = parts.join(" ");
  const notes = [];
  if (unknown.length) notes.push("ACTION " + unknown.length + " unknown entries pending; ask one by one");
  if (purity.available && purity.driftCount > 0) notes.push("PURITY-DRIFT " + purity.driftCount + " files changed since install");
  if (purity.integrity && purity.integrity.status === "baseline-created") notes.push("BASELINE-CREATED " + purity.integrity.baseline.count + " files hashed once (tofu)");
  if (purity.integrity && purity.integrity.status === "drift") notes.push("INTEGRITY-DRIFT " + ((purity.integrity.added || []).length + (purity.integrity.modified || []).length + (purity.integrity.removed || []).length) + " files differ from baseline");
  if (patches && patches.bad && patches.bad.length) notes.push("PATCH-LOST " + patches.bad.length + " accepted change(s) no longer match; see report");
  if (notes.length) out += "\n" + notes.join(" | ");
  out += "\nREPORT " + reportPath;
  return out;
}

export function renderJson(ctx) {
  const { version, machine, roots, stats, residue, unknown, warnings, reportPath, sessions, purity, plugins, patches, probe, roster, locked, known, changes } = ctx;
  return JSON.stringify({
    schema: 1, version, machine,
    roots: roots.map((r) => ({ id: r.id, kind: r.kind, path: r.path, source: r.source, bytes: r.bytes, files: r.files })),
    stats,
    sessions: { count: sessions.count, bytes: sessions.bytes, workspaces: sessions.workspaces, suspicious: sessions.suspicious.length, emptyWorkSpaces: (sessions.emptyWorkSpaces || []).length, emptySessions: (sessions.emptySessions || []).length, orphanWorkspaces: (sessions.orphanWorkspaces || []).length },
    purity, plugins, patches, probe, roster, locked, known, changes, residue, unknown, warnings, reportPath,
  }, null, 2);
}

export function renderMarkdown(ctx) {
  const { version, machine, roots, stats, containers, residue, unknown, warnings, sessions, purity, plugins, patches, probe, locked, known, changes } = ctx;
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

  L.push("## 本次变动");
  L.push("");
  if (!changes) {
    L.push("这次是第一次扫描，没有上一次可以比。");
  } else {
    const signed = (n) => (n > 0 ? "+" + n : String(n));
    const bits = [];
    if (changes.files) bits.push("文件 " + signed(changes.files));
    if (changes.residue) bits.push("残留 " + signed(changes.residue) + " 项");
    if (changes.unknown) bits.push("未归类 " + signed(changes.unknown) + " 项");
    if (changes.sessions) bits.push("会话 " + signed(changes.sessions) + " 个");
    if (changes.plugins) bits.push("插件 " + signed(changes.plugins) + " 个");
    if (changes.known) bits.push("判例 " + signed(changes.known) + " 条");
    L.push(bits.length ? "- 与上次扫描相比：" + bits.join(" · ") : "- 与上次扫描相比：没有变化");
  }
  L.push("");

  L.push("## DSH 相关文件夹");
  L.push("");
  L.push("| id | 路径 | 作用 | 来源 | 体积 | 文件数 |");
  L.push("|---|---|---|---|---|---|");
  for (const r of roots) L.push("| " + r.id + " | " + r.path + " | " + (ROLE[r.kind] || r.kind) + " | " + r.source + " | " + fmtBytes(r.bytes) + " | " + r.files + " |");
  L.push("");

  if (probe && probe.suspects && probe.suspects.length) {
    L.push("## 疑似相关（有线索，没纳入扫描）");
    L.push("");
    L.push("这些目录有 DSH 的线索但不足以确认归属，所以没有纳入体积统计。要算进来就说一声。");
    L.push("");
    L.push("| 路径 | 线索 |");
    L.push("|---|---|");
    for (const s of probe.suspects) L.push("| " + s.path + " | " + s.evidence.join("；") + " |");
    L.push("");
  }

  L.push("## 顶层目录");
  L.push("");
  L.push("| 根 | 目录 | 归属 | 判定 | 文件数 | 体积 | 本次增减 | 说明 |");
  L.push("|---|---|---|---|---|---|---|---|");
  for (const c of containers.slice().sort((a, b) => b.bytes - a.bytes)) {
    L.push("| " + c.rootId + " | " + c.name + " | " + c.owner + " | " + c.class + " | " + c.files + " | " + fmtBytes(c.bytes) + " | " + deltaText(c.delta, c.isNew) + " | " + c.reason + " |");
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
    if (purity.explained && purity.explained.length) {
      L.push("- 已解释：" + purity.explained.length + " 处发行方自带的说明文件（7-Zip 授权声明等，随安装包一起落地并保留原始时间戳，不算脏）：");
      for (const f of purity.explained.slice(0, 10)) L.push("  - " + f.rel);
    }
    const bt = baselineText(purity.integrity);
    if (bt) {
      const g = purity.integrity;
      L.push("- 逐文件基线：" + bt);
      const bad = (g.added || []).length + (g.modified || []).length + (g.removed || []).length;
      if (!bad) L.push("- 逐文件核对：与基线一致" + (g.status === "version-changed" ? "（客户端版本已变，建议 verify --rebase 重建基线）" : "") + "；这次没有读盘算哈希。");
      else {
        L.push("- 逐文件核对：不一致 " + bad + " 处（改 " + g.modified.length + " · 增 " + g.added.length + " · 少 " + g.removed.length + "）");
        for (const f of g.modified) L.push("  - 改 " + f.rel);
        for (const f of g.added) L.push("  - 增 " + f.rel);
        for (const f of g.removed) L.push("  - 少 " + f.rel);
      }
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

  if (patches && patches.total) {
    L.push("## 已知改动（你自己改的，不算脏）");
    L.push("");
    L.push("这些是你认可的手工改动。每次扫描只多算一次哈希：对得上就是在位；变回 pnpm 原件说明升级或重装把它覆盖了，补丁丢了。");
    L.push("");
    L.push("| 文件 | 备注 | 状态 | 大小 | 记录时间 |");
    L.push("|---|---|---|---|---|");
    for (const p of patches.items) {
      L.push("| " + p.path + " | " + (p.note || "—") + " | " + (PATCH_STATUS[p.status] || p.status) + " | " + fmtBytes(p.size) + " | " + new Date(p.acceptedAt).toISOString().slice(0, 10) + " |");
    }
    L.push("");
  }

  L.push("## 插件包（pnpm 仓库校验）");
  L.push("");
  L.push("pnpm 不复制文件，而是给包内文件链到仓库里的原件。链接断开（nlink=1）说明文件被动过；再对这份文件算哈希去仓库里查，就能区分「内容仍是原件」和「内容真的变了」。");
  L.push("");
  L.push("- 包数：" + plugins.packages + " / 文件：" + plugins.files + (plugins.storeUsable ? " / 硬链接完好：" + plugins.linked : "（未找到 pnpm 仓库，跳过原件校验）"));
  L.push("- 被改过：" + plugins.modified.length);
  for (const m of plugins.modified) L.push("  - " + m.pkg + " → " + m.rel + (m.isOriginal ? "（内容仍是原件）" : "（内容与原件不同）"));
  if (plugins.unverifiable && plugins.unverifiable.length) {
    L.push("- 无法校验：" + plugins.unverifiable.length + " 个文件（" + (plugins.storeEmpty ? "pnpm 仓库已被清理" : "仓库里没有对应原件") + "，这些不算脏，但也没法证明没被改过）");
  }
  L.push("- 多余/副本：" + plugins.added.length);
  for (const a of plugins.added) L.push("  - " + a.pkg + " → " + a.rel + "（" + a.reason + "）");
  const lk2 = plugins.lock;
  L.push("- 名册对账：声明 " + lk2.declared + " / 实际 " + lk2.installed + " / 孤儿 " + lk2.orphans.length + " / 缺失 " + lk2.missing.length + " / 版本不符 " + lk2.mismatched.length);
  for (const o of lk2.orphans) L.push("  - 孤儿包：" + o);
  for (const m of lk2.missing) L.push("  - 缺失：" + m);
  for (const m of lk2.mismatched) L.push("  - 版本不符：" + m.name + "（声明 " + m.declared + " / 实际 " + m.installed + "）");
  L.push("");

  L.push("## 会话");
  L.push("");
  L.push("| 工作区 | 会话数 | 文件数 | 体积 | 最早 | 最新 | 状态 |");
  L.push("|---|---|---|---|---|---|---|");
  for (const w of sessions.workspaces) {
    L.push("| " + w.path + " | " + w.sessions + " | " + w.files + " | " + fmtBytes(w.bytes) + " | " + day(w.oldest) + " | " + day(w.newest) + " | " + (w.exists ? "正常" : "工作区已不存在") + " |");
  }
  L.push("");
  {
    const emptyWs = (sessions.emptyWorkSpaces || []).filter((w) => !w.exists).length;
    const liveEmptyWs = (sessions.emptyWorkSpaces || []).filter((w) => w.exists).length;
    const emptySess = (sessions.emptySessions || []).length;
    const orphanWs = (sessions.orphanWorkspaces || []).length;
    if (emptyWs || emptySess || orphanWs || liveEmptyWs) {
      const bits = [];
      if (emptyWs) bits.push("空工作区（工作区已不存在）" + emptyWs + " 个");
      if (liveEmptyWs) bits.push("工作区还在的空容器 " + liveEmptyWs + " 个（不列入清理）");
      if (emptySess) bits.push("空会话 " + emptySess + " 个");
      if (orphanWs) bits.push("工作区已消失但留着历史 " + orphanWs + " 个");
      L.push("可收尾的：" + bits.join(" · ") + "（跑 `review` 看清单）");
      L.push("");
    }
  }
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

  if (locked && locked.length) {
    L.push("## 正在使用（本次跳过）");
    L.push("");
    L.push("这些项在抽样间隔里体积或修改时间还在变，说明此刻有人在写（下载中 / 正在写入），所以这次不判定、也不进清理清单。");
    L.push("");
    L.push("| # | 根 | 路径 | 体积 |");
    L.push("|---|---|---|---|");
    locked.forEach((x, i) => L.push("| " + (i + 1) + " | " + x.rootId + " | " + x.rel + " | " + fmtBytes(x.size) + " |"));
    L.push("");
  }

  L.push("## 未归类（" + unknown.length + "）");
  L.push("");
  if (!unknown.length) L.push("无");
  else {
    L.push("| 根 | 目录 | 文件数 | 体积 | 说明 |");
    L.push("|---|---|---|---|---|");
    for (const u of unknown) L.push("| " + u.rootId + " | " + u.rel + " | " + u.files + " | " + fmtBytes(u.bytes) + " | " + u.reason + " |");
  }
  L.push("");

  L.push("## 判例库（" + (known ? known.total : 0) + "）");
  L.push("");
  if (!known || !known.total) L.push("无。判过之后这里会记下来，以后扫描不用再问。");
  else {
    L.push("| 级别 | 路径 | 判定 | 备注 | 最后见到 | 状态 |");
    L.push("|---|---|---|---|---|---|");
    for (const k of known.items) {
      L.push("| " + (k.level === "container" ? "目录" : "文件") + " | " + k.rootId + ":" + k.rel + " | " + k.class + " | " + (k.reason || "—") + " | " + (k.lastSeen ? new Date(k.lastSeen).toISOString().slice(0, 10) : "—") + " | " + (k.stale ? "已失效" : "在位") + " |");
    }
  }
  L.push("");
  return L.join("\n");
}

/** 报告的段名 → 标题前缀。--section=<名字> 只打印这一段，省得把整份报告读进对话。 */
const SECTIONS = {
  warnings: "## 提示",
  folders: "## DSH 相关文件夹",
  suspects: "## 疑似相关",
  top: "## 顶层目录",
  purity: "## 纯净度",
  changes: "## 本次变动",
  patches: "## 已知改动",
  plugins: "## 插件包",
  sessions: "## 会话",
  residue: "## 残留",
  locked: "## 正在使用",
  unknown: "## 未归类",
  known: "## 判例库",
};

export function sectionNames() { return Object.keys(SECTIONS); }

export function renderSection(ctx, key) {
  const head = SECTIONS[key];
  if (!head) {
    const avail = Object.keys(SECTIONS).join(" / ");
    return "没有「" + key + "」这一段。可用：" + avail;
  }
  const lines = renderMarkdown(ctx).split("\n");
  const start = lines.findIndex((l) => l.startsWith(head));
  if (start < 0) return "_这次报告里没有这一段（说明这一项是空的）_";
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end < 0) end = lines.length;
  return lines.slice(start, end).join("\n").trimEnd();
}
