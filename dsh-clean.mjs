#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runScan } from "./lib/scan.mjs";
import { renderHuman, renderAgent, renderJson, renderSection } from "./lib/report.mjs";
import { install, uninstall, defaultStateDir, appRoot } from "./lib/install.mjs";
import { acceptPatch, forgetPatch } from "./lib/patches.mjs";
import { runApply, latestPlan } from "./lib/apply.mjs";
import { recordJudgment, forgetJudgment, locate } from "./lib/known.mjs";
import { runVerify } from "./lib/verify.mjs";
import { runPrune, KEEP_DEFAULT } from "./lib/prune.mjs";
import { VERSION } from "./lib/version.mjs";

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));

const HELP = [
  "DSH-clean " + VERSION + " - DeepSeek Harness 桌面端纯净度巡检（P0 只读）",
  "",
  "用法：dsh-clean.cmd <命令> [选项]",
  "",
  "  scan        扫描并生成报告（不删任何东西）",
  "  verify      校验安装目录有没有被改动（对照本机基线 / 官方安装包）",
  "  review      列待清理清单，带编号（不删任何东西）",
  "  apply       按编号把东西送进回收站（要 --yes 才真删）",
  "  judge       把一处判定记进判例库，以后扫描不再重复问（要带路径或清单编号）",
  "  unjudge     撤销判例（带路径或编号，或 --all）",
  "  accept      把一处改动记成「你自己改的」，以后不算脏（要带文件路径）",
  "  unaccept    撤销记录（带路径，或 --all）",
  "  prune       收尾：旧报告只留最近几份、安装目录里的旧状态文件一并收走（都进回收站）",
  "  install     部署程序与技能到本机",
  "  uninstall   卸载程序与技能（状态默认保留）",
  "  version     显示版本",
  "  help        显示本帮助",
  "",
  "scan 选项：",
  "  --agent            输出两行机读摘要（给对话用）",
  "  --json             输出 JSON（很大，别整个读进对话）",
  "  --section=<名字>   只输出报告的一段：residue / plugins / sessions / folders / purity / top",
  "  --quiet            只输出摘要",
  "  --full             重新发现根目录",
  "  --state-dir=<路径> 覆盖状态目录",
  "  --install-dir=<路径> 手动指定 DSH 安装目录",
  "",
  "verify 选项：",
  "  --rebase           重建基线（客户端更新过之后用这个）",
  "  --upstream=<目录>  和「解包后的官方安装包」逐文件对账",
  "  --installer=<exe>  自动用 7-Zip 解包安装包再对账（本机要有 7-Zip）",
  "  --agent            输出一行机读摘要",
  "  --state-dir=<路径> 覆盖状态目录",
  "",
  "apply 选项：",
  "  --ids=1,3          只处理这几个编号",
  "  --tier=A           按档位处理（A=明确残留、可还原；B=多半没用但建议先看）",
  "  --all              处理清单里全部残留项",
  "  --yes              确认执行（不加只列清单）",
  "  --plan=<路径>      指定 plan.json（默认用最近一次扫描）",
  "  注意：真删除要在放宽沙箱（danger-full-access）下跑，否则一个都不删。",
  "",
  "install 选项：",
  "  --project          技能装到当前工作区 .dsh\\skills",
  "",
  "judge 选项：",
  "  --as=KEEP|CACHE|RESIDUE|UNKNOWN  怎么判（KEEP=保留别动、CACHE=缓存、RESIDUE=残留可清）",
  "  --note=\"一句话\"     记下为什么这么判（会显示在报告里）",
  "  --owner=host|plugin:名字  归属（可不填）",
  "  --container|--file  强制按目录 / 按文件记（默认看磁盘上是文件还是目录）",
  "  --state-dir=<路径>  覆盖状态目录",
  "  例子：dsh-clean.cmd judge 3 --as=KEEP --note=\"这是某插件自己的缓存\"",
  "",
  "accept 选项：",
  "  --note=\"为什么改\"   一句话备注，扫描报告里会显示",
  "  --state-dir=<路径>  覆盖状态目录",
  "",
  "prune 选项：",
  "  --keep=<份数>      报告保留几份（默认 " + KEEP_DEFAULT + "）",
  "  --dry-run          只列会收走什么，不动手",
  "  --no-legacy        只收报告，不碰安装目录里的旧状态",
  "  --state-dir=<路径> 覆盖状态目录",
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
    const { lines } = install({ srcDir: APP_DIR, project: opt.has("project"), stateDir: opt.val("state-dir") || null });
    console.log(lines.join("\n"));
  } else if (cmd === "uninstall") {
    const { lines, code } = uninstall({ purge: opt.has("purge") });
    console.log(lines.join("\n"));
    process.exitCode = code;
  } else if (cmd === "accept") {
    const target = rest.find((a) => !a.startsWith("--"));
    if (!target) {
      console.error("用法：dsh-clean.cmd accept <文件路径> --note=\"为什么改\"");
      process.exitCode = 3;
    } else {
      const stateDir = opt.val("state-dir") || defaultStateDir();
      const item = acceptPatch(stateDir, path.resolve(target), opt.val("note") || "");
      console.log("已记录：" + item.path);
      console.log("  sha512  " + item.sha512.slice(0, 16) + "…");
      console.log("  备注    " + (item.note || "（无）"));
      console.log("以后这处改动不再算脏；哪天插件升级把它覆盖回原件，扫描会报「补丁丢了」。");
    }
  } else if (cmd === "unaccept") {
    const stateDir = opt.val("state-dir") || defaultStateDir();
    const target = opt.has("all") ? null : rest.find((a) => !a.startsWith("--"));
    if (!target && !opt.has("all")) {
      console.error("用法：dsh-clean.cmd unaccept <文件路径> | --all");
      process.exitCode = 3;
    } else {
      const n = forgetPatch(stateDir, target ? path.resolve(target) : null);
      console.log(n ? "已撤销 " + n + " 条记录" : "没有匹配的记录");
    }
  } else if (cmd === "apply" || cmd === "review") {
    const stateDir = opt.val("state-dir") || defaultStateDir();
    const { lines, code } = runApply({
      stateDir,
      ids: opt.val("ids") || "",
      tier: opt.val("tier") || "",
      all: opt.has("all"),
      yes: opt.has("yes") && cmd !== "review",
      planPath: opt.val("plan") || null,
    });
    console.log(lines.join("\n"));
    process.exitCode = code;
  } else if (cmd === "judge" || cmd === "unjudge") {
    const stateDir = opt.val("state-dir") || defaultStateDir();
    const target = rest.find((a) => !a.startsWith("--"));
    if (cmd === "unjudge" && opt.has("all")) {
      const n = forgetJudgment(stateDir, null);
      console.log(n ? "已撤销全部 " + n + " 条判例" : "判例库本来就是空的");
    } else if (!target) {
      console.error("用法：dsh-clean.cmd judge <路径或清单编号> --as=KEEP|CACHE|RESIDUE [--note=\"为什么\"]");
      process.exitCode = 3;
    } else {
      let item = null;
      if (/^[0-9]+$/.test(target)) {
        const plan = latestPlan(stateDir);
        const it = plan ? (plan.doc.items || []).find((x) => Number(x.id) === Number(target)) : null;
        if (!it) {
          console.error("最近一次清单里没有编号 " + target + "。先跑 scan / review 看看编号。");
          process.exitCode = 3;
        } else {
          item = { rootId: it.rootId, rel: it.path, level: it.class === "UNKNOWN" ? "container" : "file" };
        }
      } else {
        const loc = locate(stateDir, target);
        if (!loc) {
          console.error("这个路径不在已记录的 DSH 目录里：" + path.resolve(target) + "\n先跑一次 scan，或确认路径没写错。");
          process.exitCode = 3;
        } else item = { rootId: loc.rootId, rel: loc.rel, level: loc.level };
      }
      if (item) {
        if (opt.has("container")) item.level = "container";
        if (opt.has("file")) item.level = "file";
        if (cmd === "unjudge") {
          const n = forgetJudgment(stateDir, item);
          console.log(n ? "已撤销 " + n + " 条判例" : "没有匹配的判例");
        } else {
          const cls = String(opt.val("as") || "").toUpperCase();
          if (!cls) {
            console.error("要带 --as=KEEP|CACHE|RESIDUE|UNKNOWN（KEEP=保留别动、CACHE=缓存、RESIDUE=残留可清）");
            process.exitCode = 3;
          } else {
            const info = recordJudgment(stateDir, {
              rootId: item.rootId, rel: item.rel, level: item.level,
              class: cls, owner: opt.val("owner") || "", tier: opt.val("tier") || "", reason: opt.val("note") || "",
            });
            console.log("已记入判例库：" + info.key + " → " + cls + "（" + (item.level === "container" ? "整个目录" : "单个文件") + "）");
            console.log("以后扫描会按这个判定走，不再重复问。撤销：dsh-clean.cmd unjudge " + item.rootId + ":" + item.rel);
          }
        }
      }
    }
  } else if (cmd === "verify") {
    const stateDir = opt.val("state-dir") || defaultStateDir();
    const { lines, code } = await runVerify({
      stateDir,
      appDir: APP_DIR,
      rebase: opt.has("rebase"),
      upstream: opt.val("upstream") || null,
      installer: opt.val("installer") || null,
      agent: opt.has("agent"),
    });
    console.log(lines.join("\n"));
    process.exitCode = code;
  } else if (cmd === "prune") {
    const stateDir = opt.val("state-dir") || defaultStateDir();
    const out = runPrune({
      installRoot: appRoot(),
      stateDir,
      keep: opt.val("keep") || KEEP_DEFAULT,
      dryRun: opt.has("dry-run"),
      legacy: !opt.has("no-legacy"),
      agent: opt.has("agent"),
    });
    if (opt.has("agent")) {
      console.log("PRUNE keep=" + out.keep + " reports=" + out.totalReports + "/" + out.droppedReports +
        " legacy=" + out.retiredLegacy + " bytes=" + out.bytes + " blocked=" + (out.blocked ? 1 : 0) + " ok=" + (out.ok ? 1 : 0));
    } else {
      console.log(out.lines.join("\n"));
    }
    process.exitCode = out.ok ? 0 : 4;
  } else if (cmd === "scan") {
    const stateDir = opt.val("state-dir") || defaultStateDir();
    const { ctx, code } = await runScan({ stateDir, appDir: APP_DIR, full: opt.has("full"), installDir: opt.val("install-dir") || null, argv: rest });
    const section = opt.val("section");
    if (opt.has("json")) console.log(renderJson(ctx));
    else if (section) console.log(renderSection(ctx, section));
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
