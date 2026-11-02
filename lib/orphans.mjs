
import nodeFs from "node:fs";
import path from "node:path";

/**
 * 卸载遗留物检测。
 *
 * 插件卸掉之后，它自己在 ~/.dsh 下建的数据目录 / 文件不会跟着走，于是成了没人认领的残骸：
 *   ~/.dsh/remote-web-ui-registry/        ← @linxin666/dsh-remote-web-ui 建的
 *   ~/.dsh/mobile-gateway-devices.json    ← dsh-plugin-mobile-gateway 建的
 *
 * 名册（roster.json）记着每个插件最后一次出现的状态，所以能回答「这个目录的主人还在不在」。
 * 难点不在查，而在名字对不上：目录名常常是插件名的子集（去掉 scope、去掉 dsh- 前缀、加后缀）。
 *
 * 匹配规则（宁少报、不多报）：
 *   1) 只认名字像 DSH 插件的已卸载包（含 dsh- / @scope/dsh-），传递依赖（express、qs…）一律不参与；
 *   2) 名字切成词后，插件名的主干词要**连续**出现在目录/文件名里，且至少两个词
 *      （dsh-plugin-mobile-gateway → [mobile, gateway] ⊂ mobile-gateway-devices.json）；
 *   3) 单词插件名（没有连字符的）走「去符号后包含」这条路，要求至少 8 个字符；
 *   4) 只要当前还有已装插件能对上这个名字，就不报（说明是活跃数据，不是残骸）。
 *
 * 另外顺手体检 profile 的 cordis.patch.yml：启动层里引用了一个已经不在的包，启动时会打
 * WARN patch: entry ... not found。这类死行只报告，绝不自动改（属于客户端文件）。
 */

const fs = nodeFs;

const GENERIC_PREFIX = new Set(["dsh", "plugin", "plugins", "client"]);

/** 名字像不像一个 npm 包（用来把模型 id、配置键从「死行」里筛掉）。 */
export function packageLike(name) {
  const n = String(name || "");
  if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(n)) return false;
  if (n.startsWith("@")) return true;
  return /(^|[-_])dsh([-_]|$)|harness/.test(n);
}

/**
 * 客户端自带的内置包（在 app.asar 的 node_modules 里，不在 profile 里）。
 * cordis.patch.yml 里很多行指向这些内置组件，不认它们会把死行全报成假阳性。
 *
 * 实测（ELECTRON_RUN_AS_NODE 下）：node:fs 是「asar 感知」的，能直接 readdir 进 app.asar；
 * original-fs 只能把 .asar 当普通文件读——两者分工正好相反，这里要用 node:fs。
 * 普通 node 环境读不进 asar，就返回空集合（这些行会退化成「不认识」，见 staleConfigRows 的注释）。
 */
export function builtinPackages(installPath) {
  const out = [];
  if (!installPath) return out;
  const bases = [
    ["resources", "app.asar", "dsh", "node_modules"],
    ["resources", "app.asar", "node_modules"],
    ["resources", "app", "dsh", "node_modules"],
  ];
  for (const segs of bases) {
    const base = path.join(installPath, ...segs);
    let names = [];
    try { names = nodeFs.readdirSync(base); } catch { continue; }
    for (const n of names) {
      if (n.startsWith(".")) continue;
      if (n.startsWith("@")) {
        try { for (const sub of nodeFs.readdirSync(path.join(base, n))) out.push(n + "/" + sub); } catch { /* 跳过 */ }
      } else out.push(n);
    }
  }
  return out;
}
const EXT_WORDS = new Set(["json", "bak", "log", "yaml", "yml", "db", "sqlite", "sqlite3", "tmp", "lock", "txt", "cache", "dat", "old"]);

/** 名字像不像一个 DSH 插件（末段以 dsh 开头；dshmarket 这种没连字符的也算）。 */
export function pluginNameLike(name) {
  const last = String(name || "").toLowerCase().split("/").pop();
  return last.startsWith("dsh") && last.length > 3;
}

/** 去掉扩展名（含 devices.json.cloudflare.json 这种夹在中间的）。 */
export function stripExt(name) {
  const parts = String(name || "").split(".");
  if (parts.length < 2) return String(name || "");
  while (parts.length > 1 && EXT_WORDS.has(parts[parts.length - 1].toLowerCase())) parts.pop();
  const kept = parts.filter((p, i) => i === 0 || !EXT_WORDS.has(p.toLowerCase()));
  return kept.join(".");
}

/** 两串词从头开始相同的个数。 */
function commonPrefix(a, b) {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

function tokens(s) {
  return String(s || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}
function collapse(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** 插件名的主干词：去 scope、去 dsh-/plugin- 这类通用前缀。 */
export function coreTokens(pkgName) {
  const last = String(pkgName || "").split("/").pop();
  const t = tokens(last);
  while (t.length > 1 && GENERIC_PREFIX.has(t[0])) t.shift();
  return t;
}

function containsSeq(hay, needle) {
  if (!needle.length || needle.length > hay.length) return false;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

/** 目录/文件名与插件名的匹配分；0 = 不匹配。分越高越可信。 */
export function matchName(entryName, pkgName) {
  if (!pluginNameLike(pkgName)) return 0;
  const e = tokens(stripExt(entryName));
  const c = coreTokens(pkgName);
  const cc = collapse(String(pkgName).split("/").pop());
  if (c.length >= 2 && containsSeq(e, c)) return c.length * 100 + cc.length;
  if (cc.length >= 8 && collapse(stripExt(entryName)).includes(cc)) return cc.length;
  return 0;
}

/** 名册里状态是 retired 的插件（只要像插件的）。 */
export function retiredPlugins(doc) {
  const out = [];
  for (const [name, e] of Object.entries((doc && doc.known) || {})) {
    if (!e || e.status !== "retired") continue;
    if (!pluginNameLike(name)) continue;
    out.push({ name, retiredAt: e.retiredAt || 0, version: e.version || "" });
  }
  return out;
}

/**
 * entries: 数据根的一级条目 [{name, isDir, bytes, files}]
 * hostInfra: knowledge.hostOwned 的键（宿主自己的目录，永远不碰）
 * installedNames: 当前已装的包名
 */
export function findOrphans({ retired, entries, hostInfra, installedNames }) {
  const out = [];
  const installed = [...(installedNames || [])];
  for (const en of entries || []) {
    const name = en && en.name;
    if (!name) continue;
    if (hostInfra && hostInfra.has(name)) continue;
    let best = null;
    for (const r of retired || []) {
      const score = matchName(name, r.name);
      if (!score) continue;
      if (!best || score > best.score) best = { ...r, score };
    }
    if (!best) continue;
    // 仍在用的插件：① 名字直接对得上；② 同族（主干词前两个相同，比如装的是 fork）都算在用
    const bestCore = coreTokens(best.name);
    const inUse = installed.some((n) => {
      if (!pluginNameLike(n)) return false;
      if (matchName(name, n) > 0) return true;
      return commonPrefix(coreTokens(n), bestCore) >= 2;
    });
    if (inUse) continue;
    out.push({
      plugin: best.name,
      entry: name,
      isDir: Boolean(en.isDir),
      bytes: en.bytes || 0,
      files: en.files || 0,
      retiredAt: best.retiredAt || 0,
      version: best.version || "",
    });
  }
  return out;
}

/** 包的根名：@scope/name/sub → @scope/name；dsh-ops/mode-minimal → dsh-ops。 */
export function pkgRoot(name) {
  const s = String(name || "");
  if (s.startsWith("@")) return s.split("/").slice(0, 2).join("/");
  return s.split("/")[0];
}

/**
 * profile 的 cordis.patch.yml 里，名字已经不在已装列表中的行（死行）。
 * installed: Set/Map，提供 has()。
 */
export function staleConfigRows({ profilesDir, installed }) {
  const out = [];
  let profs = [];
  try {
    profs = fs.readdirSync(profilesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return out;
  }
  const has = (n) => Boolean(installed && (installed.has(n) || installed.has(pkgRoot(n))));
  for (const prof of profs) {
    let text = "";
    try {
      text = fs.readFileSync(path.join(profilesDir, prof, "cordis.patch.yml"), "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    let pending = null;
    for (let i = 0; i < lines.length; i++) {
      const idm = lines[i].match(/^\s*-\s*id:\s*["']?([^"'\s#]+)["']?\s*$/);
      if (idm) {
        pending = { id: idm[1], line: i + 1 };
        continue;
      }
      const nm = lines[i].match(/^\s*name:\s*["']?([^"'\s#]+)["']?\s*$/);
      if (!nm || !pending) continue;
      const mod = nm[1];
      if (packageLike(mod) && !has(mod)) {
        out.push({
          profile: prof,
          file: "profiles/" + prof + "/cordis.patch.yml",
          id: pending.id,
          name: mod,
          line: pending.line,
          nameLine: i + 1,
        });
      }
      pending = null;
    }
  }
  return out;
}
