/**
 * 推断基线：不要求用户先"记一次"，直接从文件系统事实推出「刚安装完」的样子。
 *
 * 两条证据：
 *  1) 安装批次时间：安装器把文件写在同一分钟内，安装目录的 mtime 有绝对主峰。
 *  2) 落地时间 ctime：文件被写入/替换时 NTFS 会更新 ctime，而 npm 包内的 mtime 是发布者打包时的时间、不可用。
 *     所以"包内被改过"看 ctime 是否偏离该包的安装批次。
 *
 * 对主峰不明显的包（升级过多次）不硬判，标为"多批次安装"。
 */
import path from "node:path";

const BUCKET_SEC = 60;
const DRIFT_SEC = 1800;
const HARD = /\.(bak|orig|rej)$|-\.bak$|\.bak-\d{4}/i;

function dominant(values) {
  if (!values.length) return null;
  const hist = new Map();
  for (const v of values) {
    const k = Math.floor(v / BUCKET_SEC) * BUCKET_SEC;
    hist.set(k, (hist.get(k) || 0) + 1);
  }
  let best = null;
  for (const [at, count] of hist) if (!best || count > best.count) best = { at, count };
  return { at: best.at, ratio: best.count / values.length, buckets: hist.size };
}

const PKG_A = /^profiles\/[^/]+\/node_modules\/((?:@[^/]+\/)?[^/]+)\//;
const PKG_B = /^profiles\/[^/]+\/node_modules\/\.pnpm\/([^/]+)\/node_modules\/((?:@[^/]+\/)?[^/]+)\//;

function packageOf(rel) {
  const b = rel.match(PKG_B);
  if (b) return b[2];
  const a = rel.match(PKG_A);
  if (a && a[1] !== ".pnpm") return a[1];
  return null;
}

export function inferBaseline({ roots, snapshots, accepted, vendorLeftover, integrity }) {
  const acc = accepted || new Set();
  const vendor = new Set((vendorLeftover || []).map((x) => String(x).toLowerCase()));
  const install = roots.find((r) => r.kind === "install");
  const data = roots.find((r) => r.kind === "data");
  const out = { available: false, install: null, packages: [], uncertain: 0, hardEvidence: [], configs: [], explained: [], driftCount: 0 };

  if (install && snapshots[install.id]) {
    const entries = snapshots[install.id].entries;
    const ep = dominant(entries.map((e) => e[2]));
    if (ep && ep.ratio >= 0.6) {
      out.available = true;
      const off = entries
        .filter((e) => Math.abs(e[2] - ep.at) > DRIFT_SEC)
        .map(([rel, size, mtime, ctime]) => ({ rel, size, mtime, ctime }));
      // 发行方随安装包一起放进去、又保留了原始时间戳的文件（7-Zip 的授权说明等）：
      // 它们不属于「被改过」，单列成「已解释」，不计入纯净度。
      const drift = off.filter((f) => !vendor.has(f.rel.slice(f.rel.lastIndexOf("/") + 1).toLowerCase()));
      out.explained = off.filter((f) => vendor.has(f.rel.slice(f.rel.lastIndexOf("/") + 1).toLowerCase()));
      out.install = { epoch: ep.at, ratio: ep.ratio, total: entries.length, drift };
    }
  }

  if (data && snapshots[data.id]) {
    const entries = snapshots[data.id].entries;
    const byPkg = new Map();
    for (const e of entries) {
      const pkg = packageOf(e[0]);
      if (!pkg) continue;
      if (!byPkg.has(pkg)) byPkg.set(pkg, []);
      byPkg.get(pkg).push(e);
    }
    // 逐包时间戳推断不可靠（pnpm 硬链接共享 ctime、npm 包内 mtime 由发布者决定），改走强证据
    for (const [rel, , , ] of entries) {
      if (!rel.includes("/node_modules/")) continue;
      const baseName = rel.slice(rel.lastIndexOf("/") + 1);
      if (!HARD.test(baseName)) continue;
      const abs = path.join(data.path, rel.split("/").join(path.sep)).toLowerCase();
      if (acc.has(abs)) continue;
      out.hardEvidence.push({ rel, kind: "backup-of-package-file" });
    }

    const CONFIG = /^profiles\/[^/]+\/(package\.json|cordis\.patch\.yml|cordis\.yml|pnpm-workspace\.yaml|pnpm-lock\.yaml)$/;
    for (const [rel, , mtime] of entries) if (CONFIG.test(rel)) out.configs.push({ rel, mtime });
    out.configs.sort((a, b) => b.mtime - a.mtime);
  }

  // 上游基线（有基线时）里对不上的文件同样算偏离：新增、内容变了、少了。
  const integrityDrift = integrity
    ? (integrity.added || []).length + (integrity.modified || []).length + (integrity.removed || []).length
    : 0;
  out.integrity = integrity || null;
  out.driftCount = (out.install ? out.install.drift.length : 0) + out.packages.reduce((a, p) => a + p.driftCount, 0) + out.hardEvidence.length + integrityDrift;
  return out;
}
