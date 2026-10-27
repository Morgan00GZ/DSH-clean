import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readJson, writeJsonAtomic, ensureDir, shortPath } from "./util.mjs";
import { snapshot } from "./walk.mjs";
import { VERSION, SCHEMA } from "./version.mjs";

const CONFIG_NAMES = ["package.json", "cordis.patch.yml", "cordis.yml", "pnpm-workspace.yaml", "pnpm-lock.yaml"];

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { return []; }
}

function hashFile(p) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 16);
  } catch { return ""; }
}

export function baselinePath(stateDir) { return path.join(stateDir, "baseline.json"); }

export async function captureBaseline({ roots, rules, stateDir }) {
  ensureDir(stateDir);
  const install = roots.find((r) => r.kind === "install");
  const data = roots.find((r) => r.kind === "data");
  const doc = {
    schema: SCHEMA,
    version: VERSION,
    createdAt: Date.now(),
    note: "这是你声明为「刚安装并配置完毕」时的状态快照，之后的扫描都与它比较。",
    installRoot: install ? install.path : "",
    installFiles: {},
    configs: {},
    dataTop: [],
  };

  if (install) {
    const snap = await snapshot(install.path, { skipNames: rules.skipNames || [] });
    for (const [rel, size, mtime] of snap.entries) doc.installFiles[rel] = size + ":" + mtime;
  }

  if (data) {
    doc.dataTop = listDirs(data.path);
    for (const profile of listDirs(path.join(data.path, "profiles"))) {
      for (const name of CONFIG_NAMES) {
        const p = path.join(data.path, "profiles", profile, name);
        if (!fs.existsSync(p)) continue;
        doc.configs["profiles/" + profile + "/" + name] = hashFile(p);
      }
    }
  }

  writeJsonAtomic(baselinePath(stateDir), doc);
  return {
    doc,
    lines: [
      "已记录基线（当前状态 = 刚安装并配置完毕）",
      "  安装目录  " + (install ? shortPath(install.path) : "未找到"),
      "  安装文件  " + Object.keys(doc.installFiles).length + " 个",
      "  配置文件  " + Object.keys(doc.configs).length + " 个",
      "  顶层目录  " + doc.dataTop.length + " 个",
      "",
      "之后每次 scan 都会与这份基线比较；客户端或插件被动过一眼就能看出来。",
    ],
  };
}

export function compareBaseline({ baseline, roots, snapshots }) {
  if (!baseline) return { available: false };
  const install = roots.find((r) => r.kind === "install");
  const data = roots.find((r) => r.kind === "data");
  const out = { available: true, createdAt: baseline.createdAt, install: null, configs: [], dataTop: null };

  if (install && snapshots[install.id] && baseline.installFiles) {
    const now = new Map();
    for (const [rel, size, mtime] of snapshots[install.id].entries) now.set(rel, size + ":" + mtime);
    const added = [];
    const changed = [];
    for (const [rel, sig] of now) {
      const old = baseline.installFiles[rel];
      if (old === undefined) added.push(rel);
      else if (old !== sig) changed.push(rel);
    }
    const gone = Object.keys(baseline.installFiles).filter((rel) => !now.has(rel));
    const total = Object.keys(baseline.installFiles).length || 1;
    out.install = { added, changed, gone, total, ratio: (added.length + changed.length + gone.length) / total };
  }

  if (data && baseline.configs) {
    for (const [rel, hash] of Object.entries(baseline.configs)) {
      const p = path.join(data.path, rel);
      const now = hashFile(p);
      const state = !fs.existsSync(p) ? "missing" : now === hash ? "same" : "changed";
      if (state !== "same") out.configs.push({ rel, state });
    }
  }

  if (data && baseline.dataTop) {
    const now = listDirs(data.path);
    const before = new Set(baseline.dataTop);
    const after = new Set(now);
    out.dataTop = {
      added: now.filter((n) => !before.has(n)),
      gone: baseline.dataTop.filter((n) => !after.has(n)),
    };
  }

  out.driftCount =
    (out.install ? out.install.added.length + out.install.changed.length + out.install.gone.length : 0) +
    out.configs.length +
    (out.dataTop ? out.dataTop.added.length + out.dataTop.gone.length : 0);
  return out;
}
