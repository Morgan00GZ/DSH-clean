# DSH-clean

![version](https://img.shields.io/badge/version-0.3.0-blue) ![license](https://img.shields.io/badge/license-MIT-green) ![platform](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-lightgrey)

**审计并清理 Windows 上 DeepSeek Harness 桌面端的占用与残留。**

[English](README.md) | **简体中文**

DSH-clean 是一个零依赖的 Node 命令行工具，只回答关于一台机器的四个问题：

1. DeepSeek Harness 桌面端在本机占用了哪些文件夹，每个文件夹归谁？
2. 装过又卸掉的插件，留下了什么？
3. 客户端文件有没有和官方安装包不一致，改了哪些？
4. 哪些东西可以安全清理，怎么清？

它按需运行（无守护进程、无定时任务、无启动钩子），默认只读，所有删除一律进 Windows 回收站。

## 「干净」的定义

四条可测条件，不靠感觉：

| # | 条件 | 测法 |
|---|---|---|
| 1 | 相关文件夹可穷举 | 根目录登记表（`roots.json`），每一项都记录来源（注册表 / 默认位置 / 配置反解） |
| 2 | 每个目录都有归属 | 顶层目录映射到「宿主 / 插件 / 缓存 / 未归属」之一 |
| 3 | 安装目录与官方安装包一致 | 安装目录哈希基线（mtime + 大小闸门，首轮全量），另可 `verify --installer` / `verify --upstream` 对照另一份安装包；发行方保留原时间戳的文件予以解释，不算脏 |
| 4 | 无历史残留与无用文件 | 判据引擎给出残留，人工裁决后进回收站 |

条件 1–2 是前提：不满足它们，「干净」无从谈起。

## 特点

- **零依赖**：复用 DSH 自带的 Node 运行时（Electron 以 Node 模式运行），不装包、不构建。
- **只读优先**：默认 dry-run，只有你明确 apply 才动手；删除只进回收站。
- **按需**：无后台进程、无监视器、无钩子。
- **增量**：首轮全量建基线，之后按 (size, mtime) 差分，通常只处理几十个文件。
- **经验可携带**：内置知识库随仓库分发，陌生机器首跑就有一半判断力；本机裁决沉淀为判例库（`judge`），判过的不再重复问。
- **不误伤正在写的文件**：扫描末尾抽样两次元数据，正在变化的标 LOCKED，本轮跳过。
- **省 token**：给 agent 的输出压到一两行；不用 agent 时不产生任何 token。
- **残留检测**：卸载遗留物（已卸载插件留下的数据，用名册里的 retired 记录认领）、升级遗留物（例如 dsh-ops 的 bash-ipc 暂存缓存，identity 与当前包收据不匹配）、启动层死行（只报告，绝不改文件）。

## 环境要求

- Windows 10 或 Windows 11
- 本机装有 DeepSeek Harness 桌面端，**或** PATH 里有 `node`——二者满足其一即可
- 不需要 npm、不需要构建步骤、不需要管理员权限

## 安装

1. 从 [Releases](https://github.com/Morgan00GZ/DSH-clean/releases) 下载 `dsh-clean-0.3.0.zip`。
2. 解压到普通目录——不要放在 `C:\Windows`，也不要放在 DeepSeek Harness 安装目录里。
3. 双击 `install.cmd`。
4. 重启 DSH（或新开一个会话），输入 `/dsh-clean`。

开发者也可以直接用 clone：

~~~bat
git clone https://github.com/Morgan00GZ/DSH-clean.git
cd DSH-clean
install.cmd
~~~

### 安装产物

| 产物 | 位置 |
|---|---|
| 程序本体 | `%LOCALAPPDATA%\dsh-clean\app\` |
| DSH 技能 | `%USERPROFILE%\.dsh\skills\dsh-clean\` |
| 安装记录（卸载用） | `%LOCALAPPDATA%\dsh-clean\app\install.json` |
| 扫描状态与报告 | 当前工作区，默认 `Temp\dsh-clean\` |

程序会被复制出下载目录，所以下载目录之后可以删掉。

## 用法

在 DSH 里输入 `/dsh-clean`（或直接说「扫一下 DSH 有没有残留」）。助手会跑扫描、用中文或英文汇报，只执行你点头的动作。

不想开对话时，双击 `dsh-clean.cmd` 进交互式控制台；也可以直接调命令行：

| 命令 | 用途 |
|---|---|
| `scan` | 只读清点并出报告 |
| `review` / `apply` | 看待清理清单 / 把选中项送进回收站 |
| `judge` / `unjudge` | 记住或撤销一条判定，避免重复询问 |
| `verify` | 对照安装包校验客户端（`--installer` 或 `--upstream`） |
| `prune` | 收尾旧报告与旧状态 |
| `export-learning` | 把判例导出成脱敏、可提 PR 的片段 |
| `install` / `uninstall` | 部署或移除程序与技能 |

完整命令契约见 [docs/cli.md](docs/cli.md)。

人类可读输出（节选）：

~~~
DSH-clean v0.3.0 - 2026-11-02 12:00

环境
  DSH 桌面端   0.2.1-rc.3
  DSH 运行时   44.7.0
  总占用       3.7GB · 53,625 个文件 · 较上次 +34.4KB · 耗时 0.9s

DSH 相关文件夹（8）
  install            D:\Software\DeepSeek Harness               1.0GB  客户端安装目录 · launcher
  data               ~\.dsh                                     2.0GB  用户数据 · default

残留（A 档 1 · B 档 0 · 合计 183B）
   1  A          183B  时间戳备份
     C:\Users\User\.dsh\our-free-model\magpie\config\magpie\settings.json.bak
~~~

agent 输出（`--agent`，最多两行）：

~~~
PURITY v0.3.0 dsh=44.7.0 roots=10 files=50792 residue=1/0B unknown=0 sessions=11/32.4MB purity=0 integrity=ok plugins=182/0 patch=0/0 probe=+3/0 locked=0 known=0 leftover=0 next=review cfgbad=1
~~~

## 卸载

双击 `uninstall.cmd`。程序、技能、安装记录一起移除，不留孤儿技能。`Temp\dsh-clean\` 下的扫描状态与报告归你处置，工具不会去动。

## Node 三级回退

DSH 不自带独立 `node.exe`；DSH-clean 复用现有运行时，顺序如下：

| 优先级 | 来源 |
|---|---|
| 1 | `DSH_DESKTOP_NODE_EXECUTABLE`（在 DSH 会话里运行时自动存在） |
| 2 | PATH 中的 `node` |
| 3 | 常见安装路径下的 `DeepSeek Harness.exe`，以 `ELECTRON_RUN_AS_NODE=1` 启动 |

解析结果缓存在 `%LOCALAPPDATA%\dsh-clean\node-path.txt`，后续运行跳过搜索。

## 安全承诺

- 所有删除一律进 **Windows 回收站**，可还原。
- 不是本工具生成的文件只报告、不移除。
- 10 分钟内写过的文件一律不判残留。
- 被占用的条目记为 LOCKED 并跳过——不重试、不报错。
- 工具从不修改 DSH 配置文件（启动层死行只报告）。

## 已知限制

- **自定义安装路径且没有 Node**：如果 DSH 不在默认位置、PATH 里也没有 `node`，启动器会停在 `Cannot find a Node runtime`。解决：把 `node` 加进 PATH，或把 `DSH_DESKTOP_NODE_EXECUTABLE` 指向你的 `DeepSeek Harness.exe`。
- **执行策略与杀软**：`install.cmd` 用 `-ExecutionPolicy Bypass` 运行脚本以绕过执行策略限制；向用户目录写入文件仍可能触发杀软提示。
- **CLI 输出为中文**：控制台与 `report.md` 目前是中文；助手会用你的语言汇报，也可按需翻译，CLI 自身的英文输出尚未实现。
- **仅 Windows**：回收站与注册表发现都是 Windows 专有实现。引擎层已按可移植方式组织，但暂不支持其他平台。

## 文档

| 文件 | 内容 |
|---|---|
| [docs/design.md](docs/design.md) | 设计总览：形态决策、四层处理、增量与成本模型 |
| [docs/tiers.md](docs/tiers.md) | 分级定义、判据清单、硬边界与边界案例 |
| [docs/cli.md](docs/cli.md) | 命令契约、输出格式、退出码 |
| [docs/state.md](docs/state.md) | 状态文件与知识库 schema、经验回流 |
| [docs/roadmap.md](docs/roadmap.md) | P0–P4 阶段与验收标准 |

## 版本与发布

- 当前版本：**0.3.0**（`lib/version.mjs`），发布 tag：**0.3**。
- 每个版本把 `dsh-clean-0.3.0.zip` 与 `SHA256SUMS.txt` 挂在 GitHub Release 上；ZIP 由 `git archive` 按 tag 生成，内容与 tag 完全一致（测试与开发脚本通过 `.gitattributes` 排除）。
- 运行前可先校验下载物：

~~~powershell
Get-FileHash .\dsh-clean-0.3.0.zip -Algorithm SHA256
Get-Content .\SHA256SUMS.txt
~~~

- 本地打包：`powershell -NoProfile -ExecutionPolicy Bypass -File tools\release.ps1 -Tag 0.3`。
- 推送提交与 tag（Windows）：双击 `tools\push.cmd`，会先列出要推的内容并询问；`--dry-run` 只预览。首次运行若找不到 Node，会问一次 `DeepSeek Harness.exe` 的路径，并记到 `%LOCALAPPDATA%\dsh-clean\node-path.txt`。
- 给 tag `0.3` 挂 GitHub Release：双击 `tools\release-github.cmd`（需要 GitHub CLI：`winget install --id GitHub.cli`，然后 `gh auth login`）。它会传 `archives\dsh-clean-0.3.0.zip` 与 `SHA256SUMS.txt`，可重复执行。

（待补充：tag 是否统一改成 `v0.3.0` 形式；目前沿用 `0.1` 的短格式（`0.2`、`0.3`），与 `VERSION` 0.3.0 的对应关系是「去掉补丁位」。）

## 许可证

MIT © 2026 Morgan00GZ——见 [LICENSE](LICENSE)。
