#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runScan, runBaseline } from "./lib/scan.mjs";
import { renderHuman, renderAgent, renderJson } from "./lib/report.mjs";
import { install, uninstall, defaultStateDir } from "./lib/install.mjs";
import { VERSION } from "./lib/version.mjs";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));

const HELP = [
  "DSH-clean " + VERSION + " - DeepSeek Harness 桌面端纯净度巡检（P0 只读）",
  "",
  "用法：dsh-clean.cmd <命令> [选项]",
  "",
  "  scan        扫描并生成报告（不删任何东西）",
  "  baseline    把当前状态记为「刚安装并配置完毕」的基准",
  "  install     部署程序与技能到本机",
  "  uninstall   卸载程序与技能（状态默认保留）",
  "  version     显示版本",
  "  help        显示本帮助",
  "",
  "scan 选项：",
  "  --agent            输出两行机读摘要（给对话用）",
  "  --json             输出 JSON",
  "  --quiet            只输出摘要",
  "  --full             重新发现根目录",
  "  --state-dir=<路径> 覆盖状态目录",
  "  --install-dir=<路径> 手动指定 DSH 安装目录",
  "",
  "install 选项：",
  "  --project          技能装到当前工作区 .dsh\\skills",
  "",
  "uninstall 选项：",
  "  --purge            连状态与报告一起清掉",
].join("\n");

function parse(args) {
  const flags = new Set();
  const vals = {};
  for (const a of args) {
    if (!a.startsWith("--")) continue;
    let k = a.slice(2);
    let v = null;
    const eq = k.indexOf("=");
    if (eq >= 0) { v = k.slice(eq + 1); k = k.slice(0, eq); }
    if (k.startsWith("no-")) { flags.add(k.slice(3)); continue; }
    if (v === null) flags.add(k);
    else vals[k] = v;
  }
  return { has: (n) => flags.has(n), val: (n) => vals[n] };
}

const argv = process.argv.slice(2);
let cmd = "help";
let rest = argv;
if (argv[0] && !argv[0].startsWith("-")) { cmd = argv[0]; rest = argv.slice(1); }
const opt = parse(rest);

try {
  if (cmd === "version") {
    console.log(VERSION);
  } else if (cmd === "help" || cmd === "--help") {
    console.log(HELP);
  } else if (cmd === "install") {
    const { lines } = install({ srcDir: APP_DIR, project: opt.has("project") });
    console.log(lines.join("\n"));
  } else if (cmd === "uninstall") {
    const { lines, code } = uninstall({ purge: opt.has("purge") });
    console.log(lines.join("\n"));
    process.exitCode = code;
  } else if (cmd === "baseline") {
    const stateDir = opt.val("state-dir") || defaultStateDir();
    const { lines } = await runBaseline({ stateDir, appDir: APP_DIR, installDir: opt.val("install-dir") || null });
    console.log(lines.join("\n"));
  } else if (cmd === "scan") {
    const stateDir = opt.val("state-dir") || defaultStateDir();
    const { ctx, code } = await runScan({ stateDir, appDir: APP_DIR, full: opt.has("full"), installDir: opt.val("install-dir") || null, argv: rest });
    if (opt.has("json")) console.log(renderJson(ctx));
    else if (opt.has("agent")) console.log(renderAgent(ctx));
    else console.log(renderHuman(ctx));
    process.exitCode = code;
  } else {
    console.error("未知命令：" + cmd + "\n\n" + HELP);
    process.exitCode = 3;
  }
} catch (e) {
  console.error("运行失败：" + (e && e.message ? e.message : e));
  process.exitCode = 3;
}
