import fs from "node:fs";
import path from "node:path";

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { return []; }
}

/** 从 profile 的 package.json 与 node_modules 里收集已安装插件名（去 scope 的短名与全名都收）。 */
export function loadPlugins(dataRoot) {
  const full = new Set();
  const short = new Set();
  const profilesDir = path.join(dataRoot, "profiles");
  for (const profile of listDirs(profilesDir)) {
    const pkgPath = path.join(profilesDir, profile, "package.json");
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      for (const name of Object.keys(deps)) addName(name);
    } catch { /* 没有 package.json 就跳过 */ }
    const nm = path.join(profilesDir, profile, "node_modules");
    for (const name of listDirs(nm)) {
      if (name.startsWith("@")) {
        for (const sub of listDirs(path.join(nm, name))) addName(name + "/" + sub);
      } else addName(name);
    }
  }
  function addName(name) {
    full.add(name);
    short.add(name.startsWith("@") ? name.split("/")[1] : name);
  }
  return { full, short };
}

function sumByPrefix(entries, prefix) {
  let bytes = 0;
  let files = 0;
  let lastWrite = 0;
  const p = prefix + "/";
  for (const [rel, size, mtime] of entries) {
    if (rel === prefix || rel.startsWith(p)) {
      bytes += size;
      files += 1;
      if (mtime > lastWrite) lastWrite = mtime;
    }
  }
  return { bytes, files, lastWrite };
}

const RULES = [
  { id: "bak-timestamp", test: (base) => /\.bak(-\d{8,})?$/i.test(base) || /\.bak-\d{4}-\d{2}-\d{2}/i.test(base), tier: "A", why: "时间戳备份" },
  { id: "dshw-legacy", test: (base) => /^\.dshw-/.test(base), tier: "A", why: "旧版命名遗留" },
  {
    id: "tmp-partial",
    test: (base) => (/\.(tmp|partial)$/i.test(base) || (/\.part$/i.test(base) && !/\.\d{3}\.part$/i.test(base))),
    tier: "A",
    why: "半成品临时文件",
    minAgeMin: 10,
  },
  { id: "superseded", test: (base, size, rules) => /\.backup\.json$/i.test(base) && size > rules.bigArtifactBytes, tier: "B", why: "被取代的大体积快照" },
  { id: "stale-log", test: (_b, _s, _r, rel, ageSec, rules) => /(^|\/)(logs?)\//.test(rel) && ageSec > rules.staleLogDays * 86400, tier: "A", why: "停滞日志" },
];

export function classify({ roots, snapshots, knowledge, rules, known }) {
  const now = Math.floor(Date.now() / 1000);
  const plugins = loadPlugins(roots.find((r) => r.kind === "data")?.path || "");
  const containers = [];
  const residue = [];
  const unknown = [];
  const residueKeys = new Set();
  let cacheFiles = 0;
  let cacheBytes = 0;

  for (const r of roots) {
    const snap = snapshots[r.id];
    if (!snap) continue;

    // ---- 顶层容器 ----
    const topNames = new Set();
    for (const [rel] of snap.entries) topNames.add(rel.split("/")[0]);
    for (const d of snap.dirs) if (d.rel) topNames.add(d.rel.split("/")[0]);

    for (const name of topNames) {
      const { bytes, files, lastWrite } = sumByPrefix(snap.entries, name);
      const key = r.id + ":" + name;
      const judged = known?.judged?.[key];
      let cls = "KEEP";
      let owner = "unknown";
      let reason = "";
      let tier = "";

      if (judged) {
        cls = judged.class || "KEEP"; owner = judged.owner || "judged"; reason = judged.reason || "判例库";
        tier = judged.tier || "";
      } else if (knowledge.hostOwned && knowledge.hostOwned[name]) {
        owner = "host"; reason = knowledge.hostOwned[name];
      } else if (plugins.short.has(name) || plugins.full.has(name)) {
        owner = "plugin:" + name; reason = "名册中存在该插件";
      } else if (r.kind === "data") {
        cls = "UNKNOWN"; owner = "unknown"; tier = "B";
        reason = "底层目录无法归属：既不是宿主已知目录，也不在已装插件名册里";
      } else {
        owner = "root"; reason = "根目录自身内容";
      }

      containers.push({ rootId: r.id, name, rel: name, bytes, files, lastWrite, class: cls, owner, reason, tier, key });
      if (cls === "UNKNOWN") unknown.push({ rootId: r.id, rel: name, bytes, files, reason, tier });
      else if (cls === "RESIDUE") {
        residue.push({ rootId: r.id, rel: name, size: bytes, tier: tier || "A", rule: "judged", reason: reason || "判例库：你判定为残留" });
        residueKeys.add(key);
      }
    }

    // ---- 文件级判据 ----
    const containerClass = new Map(containers.filter((c) => c.rootId === r.id).map((c) => [c.name, c.class]));
    if (r.kind === "data" || r.kind === "appdata" || r.kind === "cache") {
      for (const [rel, size, mtime] of snap.entries) {
        const base = rel.slice(rel.lastIndexOf("/") + 1);
        const ageSec = now - mtime;
        // 判例库优先：你裁决过的文件不再由规则重复判（正在写的由 scan 的 LOCKED 抽样挡在前面）
        const fkey = r.id + ":" + rel;
        const judgedFile = known && known.files ? known.files[fkey] : null;
        if (judgedFile) {
          const jc = String(judgedFile.class || "").toUpperCase();
          if (jc === "KEEP") continue;
          if (jc === "CACHE") { cacheFiles += 1; continue; }
          if (jc === "RESIDUE") {
            if (!residueKeys.has(fkey)) {
              residue.push({ rootId: r.id, rel, size, tier: judgedFile.tier || "A", rule: "judged", reason: judgedFile.reason || "判例库：你判定为残留" });
              residueKeys.add(fkey);
            }
            continue;
          }
        }
        for (const rule of RULES) {
          const minAge = (rule.minAgeMin || 0) * 60;
          if (ageSec < minAge) continue;
          if (!rule.test(base, size, rules, rel, ageSec, rules)) continue;
          residue.push({ rootId: r.id, rel, size, tier: rule.tier, rule: rule.id, reason: rule.why });
          residueKeys.add(r.id + ":" + rel);
          break;
        }
      }

      // 空目录：只报归属不明容器下的（已知宿主/插件目录里的空目录属正常占位）
      for (const d of snap.dirs) {
        if (!d.rel || d.count !== 0) continue;
        const top = d.rel.split("/")[0];
        if (containerClass.get(top) !== "UNKNOWN") continue;
        residue.push({ rootId: r.id, rel: d.rel, size: 0, tier: "A", rule: "empty-dir", reason: "空目录" });
        residueKeys.add(r.id + ":" + d.rel);
      }

      // 更新缓存：已下载的安装包 / 半截下载
      if (r.kind === "cache") {
        for (const [rel, size] of snap.entries) {
          const baseName = rel.slice(rel.lastIndexOf("/") + 1);
          if (residueKeys.has(r.id + ":" + rel)) continue;
          if (/\.(exe|msi|7z)$/i.test(baseName) && size > 52428800) {
            residue.push({ rootId: r.id, rel, size, tier: "B", rule: "updater-package", reason: "已下载的更新包，更新完成后可清" });
            residueKeys.add(r.id + ":" + rel);
          } else if (/\.(partial|delta)$/i.test(baseName)) {
            residue.push({ rootId: r.id, rel, size, tier: "A", rule: "tmp-partial", reason: "未完成的下载" });
            residueKeys.add(r.id + ":" + rel);
          }
        }
      }

      // 缓存与孤儿包
      for (const [rel, size] of snap.entries) {
        if (/^cache\//.test(rel)) { cacheFiles += 1; cacheBytes += size; }
      }
      const orphans = new Map();
      const re = /^profiles\/[^/]+\/node_modules\/((?:@[^/]+\/)?[^/]+)\//;
      for (const [rel] of snap.entries) {
        const m = rel.match(re);
        if (!m) continue;
        const pkg = m[1];
        if (!/^(@[^/]+\/)?dsh[-.]/.test(pkg)) continue;
        if (plugins.full.has(pkg) || plugins.short.has(pkg.split("/").pop())) continue;
        if (!orphans.has(pkg)) orphans.set(pkg, rel.split("/").slice(0, 4).join("/"));
      }
      for (const [pkg, rel] of orphans) {
        residue.push({ rootId: r.id, rel, size: 0, tier: "B", rule: "orphan-package", reason: "node_modules 里有该包，但名册未声明：" + pkg });
        residueKeys.add(r.id + ":" + rel);
      }
    }
  }

  return { containers, residue, unknown, residueKeys, cacheFiles, cacheBytes, plugins };
}
