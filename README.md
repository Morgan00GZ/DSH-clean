# DSH-clean

**DeepSeek Harness 桌面端的纯净度巡检与清理工具**

按需运行，不装插件、不常驻、不改客户端配置。只回答四个问题：

1. 这台机器上跟 DSH 有关的文件夹，一共有哪些、各自归谁？
2. 装过又卸掉的插件，留下了什么？
3. 客户端文件有没有被改过，改了哪些？
4. 还有哪些东西该清，并且能安全地清？

> **状态：P0 开发中（只读清点）。** 当前阶段只做发现与报告，不会删除任何文件。
> 清理（A/B 档 × 回收站）与上游校验在后续阶段开放，见 [docs/roadmap.md](docs/roadmap.md)。

---

## 「干净」的定义

DSH-clean 把「干净」拆成四条**可测**的条件，不靠感觉：

| # | 条件 | 测法 |
|---|---|---|
| 1 | 相关文件夹可穷举 | 根目录登记表 `roots.json`，每一项都带来源（注册表 / 默认位置 / 配置反解） |
| 2 | 每个目录都有归属 | 顶层目录必须映射到「宿主 / 插件 / 缓存 / 未归属」之一 |
| 3 | 安装目录与官方安装包一致 | 整文件哈希 + 已批准补丁白名单 + 上游 `latest.yml` 比对 |
| 4 | 无历史残留与无用文件 | 判据引擎给出 RESIDUE，人工裁决后进回收站 |

不满足 1–2 时，「干净」无从谈起 —— 所以它们排在清理之前。

## 特点

- **零依赖**：复用 DSH 自带的运行时（Electron 以 node 模式运行），不装任何包、不需要构建
- **只读优先**：默认 dry-run；删除只进 Windows 回收站（可还原）
- **按需**：无守护进程、无定时任务、无启动钩子
- **增量**：首轮全量建库，之后按 (size, mtime) 差分，通常只处理几十个文件
- **经验可携带**：内置知识库随仓库分发，陌生机器首跑就有一半判断力；本机裁决沉淀为判例库
- **省 token**：给 agent 的输出压成两行；不需要 agent 时不产生任何 token

## 快速开始

~~~bat
git clone https://github.com/Morgan00GZ/DSH-clean.git
cd DSH-clean
dsh-clean.cmd scan
~~~

P0 阶段只有 `scan`（只读）。完整命令契约见 [docs/cli.md](docs/cli.md)。

## 输出长什么样

人类模式：

~~~
DSH-clean v0.1.0 - 2026-10-27 21:58

install    D:\Software\DeepSeek Harness              44.7.0   已登记
data       C:\Users\User\.dsh                       2.9 GB   已登记
appdata    %APPDATA%\@deepseek-ai\dsh-desktop                   已登记
updater    %LOCALAPPDATA%\@deepseek-ai\dsh-desktop-updater      已登记
workspace  D:\DeepSeek Harness                                 已登记

本轮变化   changed 12 - new 3 - gone 1
归类       KEEP 41,002 - CACHE 186 - RESIDUE 3 (1.2 GB) - UNKNOWN 4 - LOCKED 0

残留（A 档 2 - B 档 1）
  1  B  data/dsh-config-manager/rollback-points/index.v2.backup.json   467.8 MB   已被取代
  2  A  data/profiles/desktop/cordis.patch.yml.bak-17929796            72 B       临时备份
  3  A  data/dsh-config-manager/exports/dsh-config-auto-20261021.zip   66 KB      可重建

未归类 4 项：运行 review 逐项裁决，一句话可定，之后进判例库

报告    %LOCALAPPDATA%\dsh-clean\reports\20261027-215812\report.md
下一步  review
~~~

agent 模式（`--agent`，固定单行）：

~~~
PURITY v0.1.0 dsh=44.7.0 roots=7 files=41208 changed=12 keep=41002 cache=186 residue=3/1.2GB unknown=4 locked=0 next=review
~~~

## 支持范围

- Windows 10 / 11
- DeepSeek Harness 桌面端（Electron 安装版与 portable 版）
- node 三级回退：宿主提供的 `DSH_DESKTOP_NODE_EXECUTABLE` → 安装目录 Electron 主程序 + `ELECTRON_RUN_AS_NODE=1`（DSH 不自带独立 node.exe）→ PATH 中的 `node`

非 Windows 平台不在首发范围：回收站、注册表发现都是 Windows 专有实现。引擎层已按可移植方式组织，后续可扩展。

## 文档

| 文件 | 内容 |
|---|---|
| [docs/design.md](docs/design.md) | 设计总览：形态决策、四层处理、增量与成本模型 |
| [docs/tiers.md](docs/tiers.md) | 分级定义、判据清单、硬边界与边界案例 |
| [docs/cli.md](docs/cli.md) | 命令契约、输出格式、退出码 |
| [docs/state.md](docs/state.md) | 状态文件与知识库 schema、经验回流 |
| [docs/roadmap.md](docs/roadmap.md) | P0–P4 阶段与验收标准 |

## 安全承诺

- 任何删除动作**只进 Windows 回收站**，可从回收站还原
- 不是本工具生成的文件，只报告、不处置
- 半成品保护：10 分钟内写过的文件一律不判残留、不动
- 被占用的条目记为 LOCKED 并跳过，不重试、不报错

## License

MIT
