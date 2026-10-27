import nodeFs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/**
 * Electron 会把 .asar 当归档处理：lstat 返回 size=0、mtime=现在，open 直接 ENOENT。
 * 纯净度工具必须看到真实文件系统，所以优先用 original-fs（Electron 自带，绕过 asar 层）。
 */
function pickFs() {
  try {
    const require = createRequire(import.meta.url);
    const ofs = require("original-fs");
    if (ofs && typeof ofs.lstatSync === "function") return ofs;
  } catch { /* 普通 node 环境没有 original-fs */ }
  return nodeFs;
}

const FS = pickFs();

/**
 * 遍历一个根目录，只取元数据（相对路径 / 大小 / 修改时间），不读文件内容。
 * entries: [rel, sizeBytes, mtimeSec]
 */
export async function snapshot(rootPath, { skipNames = [], maxDepth = Infinity, skipPrefixes = [] } = {}) {
  const entries = [];
  const dirs = [];
  const links = [];
  let bytes = 0;
  const prefixes = skipPrefixes.filter(Boolean).map((p) => p.toLowerCase());
  const root = path.resolve(rootPath);

  function visit(abs, rel, depth) {
    let dirents;
    try {
      dirents = FS.readdirSync(abs, { withFileTypes: true });
    } catch {
      dirs.push({ rel, count: -1 });
      return;
    }
    let count = 0;
    const subdirs = [];

    for (const de of dirents) {
      if (skipNames.includes(de.name)) continue;
      const childRel = rel ? rel + "/" + de.name : de.name;
      const childAbs = path.join(abs, de.name);
      if (prefixes.some((p) => childAbs.toLowerCase().startsWith(p))) continue;
      count += 1;

      if (de.isSymbolicLink()) { links.push(childRel); continue; }
      if (de.isDirectory()) {
        if (depth + 1 < maxDepth) subdirs.push([childAbs, childRel]);
        continue;
      }
      if (!de.isFile()) continue;
      try {
        const st = FS.lstatSync(childAbs);
        entries.push([childRel, st.size, Math.floor(st.mtimeMs / 1000), Math.floor(st.ctimeMs / 1000), st.nlink]);
        bytes += st.size;
      } catch { /* 读不到就跳过，不中断整轮 */ }
    }

    dirs.push({ rel, count });
    for (const [childAbs, childRel] of subdirs) visit(childAbs, childRel, depth + 1);
  }

  visit(root, "", 0);
  return { rootPath, entries, dirs, links, bytes };
}
