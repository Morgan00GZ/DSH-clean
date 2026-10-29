import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, writeJsonAtomic } from "./util.mjs";

const PS1 = path.join(path.dirname(fileURLToPath(import.meta.url)), "recycle.ps1");

/**
 * recycle.ps1 里有中文注释，必须带 UTF-8 BOM：本机 pwsh 实为 Windows PowerShell 5.1，
 * 没有 BOM 就按 ANSI/GBK 读，脚本行为会莫名其妙（实测：清单被当成空数组直接判 empty）。
 * 任何编辑器存盘都可能吃掉 BOM，所以每次调用前自愈一次。
 */
function ensureBom(file) {
  try {
    const buf = fs.readFileSync(file);
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return;
    fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), buf]));
  } catch { /* 写不了就让 spawn 报真错 */ }
}

/**
 * 把一批路径送进 Windows 回收站，并逐项校验是否真的进箱。
 * 必须在放宽沙箱（danger-full-access）下运行：沙箱里删「工作区外」的东西会被
 * 静默降级成永久删除，所以 recycle.ps1 的回收站自检会直接拒绝（一个都不删）。
 *
 * @param {{id:number|string, path:string}[]} entries
 * @returns {{ok:boolean, blocked:boolean, reason:string, items:any[], binDir?:string, raw?:string}}
 */
export function recyclePaths(entries, opts = {}) {
  const list = (entries || []).filter((e) => e && e.path);
  if (!list.length) return { ok: true, blocked: false, reason: "empty", items: [] };

  const workDir = opts.workDir || path.join(process.env.TEMP || process.env.TMP || ".", "dsh-clean");
  try { ensureDir(workDir); } catch { /* 让下面的 spawn 报真错 */ }
  const listFile = path.join(workDir, "recycle-list-" + Date.now() + ".json");
  writeJsonAtomic(listFile, list.map((e) => ({ id: e.id, path: e.path })));

  ensureBom(PS1);
  let res;
  try {
    res = spawnSync("powershell", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", PS1, "-ListFile", listFile,
    ], { encoding: "utf8", windowsHide: true, timeout: opts.timeoutMs || 600000, maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    return { ok: false, blocked: true, reason: "spawn-failed: " + (e && e.message ? e.message : String(e)), items: [] };
  }

  if (res.error) {
    const code = res.error.code || "";
    const blocked = code === "EPERM" || code === "EACCES";
    return {
      ok: false, blocked,
      reason: blocked
        ? "当前沙箱不允许启动 PowerShell（" + code + "），删除动作无法执行"
        : "启动 PowerShell 失败：" + res.error.message,
      items: [],
    };
  }

  const out = String(res.stdout || "");
  const line = out.split(/\r?\n/).reverse().find((l) => l.startsWith("DSH_CLEAN_RECYCLE_JSON:"));
  if (!line) {
    return {
      ok: false, blocked: false,
      reason: "没拿到脚本回执（exit " + res.status + "）" + (res.stderr ? "：" + String(res.stderr).trim().slice(0, 300) : ""),
      items: [], raw: out,
    };
  }
  let doc;
  try { doc = JSON.parse(line.slice("DSH_CLEAN_RECYCLE_JSON:".length)); }
  catch { return { ok: false, blocked: false, reason: "回执解析失败", items: [], raw: out }; }

  const reason = doc.reason || "";
  // 回执已经拿到，这次的临时清单就没用了（失败时留着好排查）
  if (doc && doc.ok) { try { fs.rmSync(listFile, { force: true }); } catch { } }
  if (reason === "bin-not-writable") {
    return {
      ok: false, blocked: true, reason: "回收站目录不可写（" + (doc.binDir || "?") + "），为免静默永久删除，一个都没删",
      items: [], binDir: doc.binDir || "",
    };
  }
  return { ok: Boolean(doc.ok), blocked: false, reason, items: doc.items || [], raw: out };
}
