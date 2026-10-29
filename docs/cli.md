# 命令行契约

## 调用方式

~~~bat
dsh-clean.cmd <command> [options]
~~~

启动器负责三件事，然后转发给 `node dsh-clean.mjs`：

1. 解析自身所在目录（仓库根），`cd` 过去
2. 找 node（三级）：① 环境变量 `DSH_DESKTOP_NODE_EXECUTABLE`（在 DSH 内运行时由宿主提供）；② 安装目录的 Electron 主程序 + `ELECTRON_RUN_AS_NODE=1`（DSH 不自带独立 node.exe，这是官方等价路径，实测 node 24.21.0）；③ PATH 中的 `node`。全失败则打印指引并以 3 退出
3. 原样转发参数与退出码

## 子命令

| 命令 | 阶段 | 作用 | 是否写盘 |
|---|---|---|---|
| `install` | P0 | 把程序部署到固定位置，并把技能装进 DSH 的技能目录 | 写 LOCALAPPDATA、`~/.dsh/skills` |
| `uninstall` | P0 | 反向清除：程序、技能（默认保留状态与报告） | 同上 |
| `judge` | P2 | 把一处判定记进判例库（路径或清单编号），以后扫描不再重复问 | 写 known.json |
| `unjudge` | P2 | 撤销判例（带路径或编号，或 `--all`） | 同上 |
| `accept` | P1 | 把一处手工改动记成「用户认可」，之后不算脏 | 写 patches.json |
| `unaccept` | P1 | 撤销记录（带路径或 --all） | 同上 |
| `scan` | P0 | 发现全部相关目录、快照、归类、与上次和基线对比、写报告 | 只写 state 与 reports |
| `review` | P1 | 把待清理项列成带编号的中文清单，**不删任何东西**（等价于 `apply` 不带 `--yes`） | 只读 |
| `apply` | P1 | 按编号把文件送进 Windows 回收站；不加 `--yes` 时只列清单 | 移动文件（进回收站） |
| `verify` | P1 | 安装目录一致性校验：TOFU 基线 + 对照官方安装包（自动解包或手动`--upstream`目录） | 写 baseline |
| `prune` | P2 | 收尾：历史报告只留最近 N 份，安装目录里遗留的旧状态文件先补齐再收走 | 移动文件（进回收站） |
| `export-learning` | P3 | 导出脱敏后的判例片段，可直接提 PR（默认打印到屏幕，`--out=` 写文件） | 只在 `--out` 时写文件 |
| `scan` 自动检测 | P2 | 升级/出错遗留物：dsh-ops 受限 MSYS 缓存里 identity 与当前收据不匹配的死缓存，扫描即发现 | 只读 |

## 收尾（prune）

扫描每跑一次就多一份报告，状态也换过一次位置（旧的在 `%LOCALAPPDATA%\dsh-clean`）。`prune` 负责让工具自己不变垃圾：

~~~bat
dsh-clean.cmd prune --dry-run     :: 先看会收走什么，不动手
dsh-clean.cmd prune               :: 真收（进回收站）
dsh-clean.cmd prune --keep=20     :: 报告改留 20 份
dsh-clean.cmd prune --no-legacy   :: 只收报告，不碰旧状态
~~~

- 报告按目录名（`YYYYMMDD-HHMMSS`）排序，保留最近 N 份（默认 10），其余进回收站
- 旧状态文件（roots / patches / roster / probe-cache / last-run / sizes / known / node-path.txt / inventory）**先确认新状态目录里有，缺的先补过去**，然后才收走旧的那份——不会丢判例和补丁记录
- 旧 `reports` 目录：新位置历史已经够长时直接收走；不够长先把缺的报告补过来
- 顺带清两处自产垃圾：状态目录里旧版留下的空 `inventory` 目录、`tmp\recycle-list-*.json` 临时清单
- 回收站清单文件用完即删（回执拿到后），不再攒着
- `apply` 那套安全边界同样适用：只动回收站，回收站不可写就一个都不删，路径都在安装目录与状态目录之内
- `--agent` 输出一行：`PRUNE keep=10 reports=43/33 legacy=9 bytes=1234 blocked=0 ok=1`
- 退出码：`0` 收完或没东西可收 / `4` 没做成（回收站不可写或被沙箱拦住）

扫描不会自己动手收尾，只在报告里提示（`--agent` 行尾 `reports=N/prune`，人类报告多一行「收尾」）。

## accept

~~~bat
dsh-clean.cmd accept "C:\\Users\\User\\.dsh\\profiles\\desktop\\node_modules\\@njjpro\\dsh-remote-workspace\\lib\\index.js" --note="用户自改"
~~~

仅记哈希，不读内容、不复制文件。同一个文件再次 accept 会覆盖旧记录（哈希按当前内容重算）。

之后每次 scan 会多算一次哈希，三种结局见 [state.md](state.md) 的 patches.json 一节。

已实现：`scan` / `review` / `apply` / `judge` / `unjudge` / `accept` / `unaccept` / `verify` / `install` / `uninstall` / `version`。`export-learning` 仍是占位，调用时提示「该命令将在 Pn 提供」。

## 部署（install / uninstall）

`install` 只写三个位置，全部可逆：

| 写什么 | 写去哪 | 卸载时 |
|---|---|---|
| 程序本体 | `%LOCALAPPDATA%\dsh-clean\app\` | 删除 |
| 技能 | `%USERPROFILE%\.dsh\skills\dsh-clean\SKILL.md`（或 `--project` 时工作区下） | 删除 |
| 安装记录 | `%LOCALAPPDATA%\dsh-clean\install.json` | 保留到卸载完成，用于精确回滚 |
| 状态与报告 | `<当前目录>\Temp\dsh-clean\`（可用 `--state-dir` 改） | `--purge` 时清掉 |

安装后写进 SKILL.md 的调用行是**直连运行时**：`ELECTRON_RUN_AS_NODE=1 "…\DeepSeek Harness.exe" "…\app\dsh-clean.mjs"`；没探测到运行时才退回 `.cmd`。原因：从 bash 里再套一层 `cmd` / `powershell` 调 `.cmd`，进程会静默不执行（exit 0、输出全空），白白烧掉一次模型调用。

`install` 是幂等的：重复运行即升级程序与技能，不会产生多份副本。
`uninstall` 按安装记录逐项删除，删除后校验技能目录已不在，避免留下「孤儿技能」——那正是本工具要检查的那类残留。

默认**不动**状态目录与历史报告（里面是你的判例库）；要一起清就加 `--purge`。

## 清理（review / apply）

三步，缺一不可：

~~~bat
dsh-clean.cmd review                                     :: ① 列清单（带编号，不删）
dsh-clean.cmd apply --ids=1,3 --yes                      :: ② 清这几项
dsh-clean.cmd apply --tier=A --yes                       :: ② 或者按档清
~~~

编号来自最近一次 `scan` 写下的 `plan.json`，所以 `review` 之前必须先扫过一次。

**删除一定走回收站**，而且会逐项核实。原因（2026-10-14 实测）：DSH 的文件沙箱会拒绝写工作区外路径，而回收站 `C:\$Recycle.Bin\<SID>` 就在工作区外；此时 Windows 会把「删到回收站」**静默降级成永久删除**，而且返回值骗人（`SHFileOperation` + `FOF_ALLOWUNDO` 仍返回 0，`fAnyOperationsAborted` 也是 false）。所以 `lib/recycle.ps1` 是三步：

1. 先自检回收站目录可写 —— 不可写就一个都不删（退出码 4）
2. 再删（`SHFileOperation`，`FO_DELETE` + `FOF_ALLOWUNDO`）
3. 删后去回收站比对新增的 `$R` 条目，逐项判定 `RECYCLED` / `PERMANENT-DELETE` / `FAILED-STILL-THERE`

`lib/recycle.ps1` 必须带 UTF-8 BOM（本机 pwsh 实为 Windows PowerShell 5.1，没有 BOM 会按 GBK 读，脚本行为会莫名其妙）；`lib/recycle.mjs` 每次调用前会自愈 BOM。

**必须放宽沙箱**：`apply --yes` 要从 Node 里启 PowerShell，沙箱内会拿到 `EPERM`，此时工具**什么都不删**并明确告诉你原因（退出码 3）。在对话里请让 agent 用 `sandbox_permissions=danger-full-access` 重跑；自己操作则双击 `apply.cmd`（会先列清单、再问编号）。

每次真清理都会往 `<state>\apply-log.jsonl` 追加一行台账（见 [state.md](state.md)），清了什么、进了哪个回收站条目都留着。

退出码：`0` 全部进箱或没有要清的；`2` 有项没进箱；`3` 沙箱挡着 / 找不到运行时；`4` 回收站不可写（未删任何东西）。

## 判例（judge / unjudge）

~~~bat
dsh-clean.cmd judge 3 --as=KEEP --note="这是插件自己的缓存"
dsh-clean.cmd judge "C:\Users\User\.dsh\state" --as=CACHE
dsh-clean.cmd unjudge 3
dsh-clean.cmd unjudge --all
~~~

`judge` 接受两种定位：**清单编号**（最近一次 `scan` / `review` 里的编号）或**绝对路径**（必须落在已记录的 DSH 目录里）。默认按磁盘实际类型决定粒度：目录记成整块（`judged`），文件记成单条（`files`）；要强制可加 `--container` / `--file`。

判定四选一：

| `--as` | 含义 |
|---|---|
| `KEEP` | 保留别动，以后别再问 |
| `CACHE` | 缓存目录，计入缓存统计、不进清理清单 |
| `RESIDUE` | 确认是残留，直接进清理清单（判据写 `judged`） |
| `UNKNOWN` | 暂时不下结论，留在待确认里 |

判例只记录人做过的决定，不做推断；路径消失的判例不删，90 天后标 `stale`（见 [state.md](state.md) 的 known.json 一节）。

## 校验（verify）

检查客户端安装目录有没有被动过。两步分开做，平时日常 `scan` 用基线的 mtime+大小闸门，对得上就零 IO；真要对账才跑 `verify`。

```
dsh-clean.cmd verify
dsh-clean.cmd verify --rebase          # 重建基线（首次或客户端升级后）
dsh-clean.cmd verify --upstream=<手动解压目录>
dsh-clean.cmd verify --installer=<官方安装包.exe>
```

三档结论：
- `与基线一致`：mtime+大小全对上，没读盘。purity 计为 0。
- `--upstream <目录>`：你把官方安装包手动解压（7-Zip 解 exe，再解里面的 `$PLUGINSDIR/app-64.7z`）后指向它比对。不 spawn 外部进程，永远可用。
- `--installer <exe>`：程序自己用 7-Zip 解包再比对。需要本机装了 7-Zip；且自动解包要在**宽松沙箱**下跑（受限沙箱 spawn 外部进程会被拦）。

输出会列出 一致 / 不同 / 只在包里 / 只在本机。只在本机的多是合法安装产物（`7zip-installer-*`、`Uninstall *.exe`），不算脏。基线细节见 [state.md](state.md) 的 baseline.json 一节。

退出码：`0` 一致；`1` 有基线不一致（改/增/少）；`3` 缺安装目录或读不了基线。

## 交互模型（三条通道）

| 通道 | 场景 | 长什么样 |
|---|---|---|
| **DSH 会话** | 日常 | 自然语言。agent 跑 `--agent` 读一行摘要，用中文提问，你一句话回复 |
| **黑窗口** | 没开 DSH | 只输出报告，**不提问**；需要确认的写进 `pending.md` |
| **编号问答** | 可选，P2 起 | 在窗口里敲 `3 7` 这样选，不用记命令、不用背参数 |

默认**不进入问答**：扫描完就退出，把待确认项留成文件。问答只在显式运行 `review` 时出现，且随时可以用 DSH 会话替代。因此即使完全不用命令行，也不会缺失任何功能。

## 选项

| 选项 | 适用 | 说明 |
|---|---|---|
| `--state-dir <path>` | 全部 | 覆盖状态目录，默认 `<当前目录>\Temp\dsh-clean`（见 state.md） |
| `--json` | 全部 | 输出单个 JSON 对象（很大，别整个读进对话） |
| `--section <名字>` | `scan` | 只输出报告的一段：`residue` / `locked` / `known` / `plugins` / `sessions` / `folders` / `purity` / `top` / `unknown` / `patches` |
| `--agent` | `scan` | 输出固定两行机读摘要 |
| `--quiet` | 全部 | 只输出摘要，不输出区块明细 |
| `--no-color` | 全部 | 关闭 ANSI 颜色（重定向时自动关闭） |
| `--full` | `scan` | 忽略 `roots.json`，重新做一次发现 |
| `--only <class>` | `scan` | 只显示某类，如 `--only residue,unknown` |
| `--yes` | `apply` | 确认执行。不加就是「只看不动」，一个字节都不删 |
| `--ids 1,3,5` | `apply` | 只处理这几个编号 |
| `--tier A` | `apply` | 按档处理（A = 明确残留，清错也能从回收站还原） |
| `--all` | `apply` | 处理清单里全部残留项（不含「未归类」） |
| `--plan <file>` | `apply` | 用指定的历史 `plan.json`，默认用最近一次扫描 |
| `--rebase` | `verify` | 忽略旧基线，重新全量算一次哈希重建基线 |
| `--upstream <目录>` | `verify` | 用一个手动解压出的安装包目录做比对（不 spawn 外部进程，最稳） |
| `--installer <exe>` | `verify` | 用 7-Zip 自动解包官方安装包再比对（需要已装 7-Zip；自动解包在受限沙箱下可能拉不起来） |
| `--agent` | `verify` | 输出一行机读摘要（`INTEGRITY dsh=… baseline=… upstream=…`） |
| `--install-dir <path>` | `scan` | 手动指定 DSH 安装目录（注册表与默认位置都失败时用） |
| `--project` | `install` | 装到当前工作区的 `.dsh/skills`，而不是用户级目录 |
| `--purge` | `uninstall` | 连状态目录与报告一起删（默认保留） |

## 输出契约

### 人类模式

固定区块顺序，便于肉眼扫读：

~~~
<标题行：版本 + 时间>
<根目录表：id / path / 版本 / 状态>
<变化行>
<归类行>
<残留明细：编号 / 档位 / 路径 / 体积 / 理由>
<未归类行>
<报告路径>
<下一步提示>
~~~

体积一律用二进制单位（`KB/MB/GB`，1024 进制），保留一位小数。

### agent 模式（`--agent`）

**只读第一行和最后一行**。第一行是稳定契约：

~~~
PURITY v0.1.0 dsh=44.7.0 roots=12 files=52017 residue=0/0B unknown=0 sessions=53/41.5MB purity=0 integrity=ok plugins=266/0 patch=1/0 probe=+3/0 locked=0 known=0 next=none
~~~

- 字段名、顺序固定；**新增字段只能追加到行尾**
- 体积用紧凑写法（`1.2GB`），无空格
- `next=` 取值：`review` / `none`（全净）
- `locked=N`：本轮因「正在写入」而跳过的项数（见 state.md 的 LOCKED 一节），这些项不进清理清单
- `known=N`：判例库条数（`judge` 记下的裁决）
- `reports=N/prune`：历史报告份数；超过保留数（默认 10）时带 `/prune` 提示跑 `prune`

第二行仅在需要人决策时出现，形如：

~~~
ACTION 4 unknown entries pending; run "review" or answer by id
~~~

**最后一行永远是报告路径**，agent 在回复末尾原样贴给用户，别让他自己去翻目录：

~~~
REPORT C:\Users\User\AppData\Local\dsh-clean\reports\20261028-130518\report.md
~~~

### JSON 模式（`--json`）

单个对象，结构见 [state.md](state.md) 的 `plan.json` 与 `inventory.json` 定义。字段名与 `--agent` 保持一致。

## 退出码

| 码 | 含义 |
|---|---|
| 0 | 干净：无 RESIDUE、无 UNKNOWN |
| 1 | 存在 RESIDUE（有待清项） |
| 2 | 存在 UNKNOWN（有待裁决项） |
| 3 | 运行错误：发现失败、权限不足、状态文件损坏且无法重建 |

退出码可供计划任务或外部脚本判定，但本工具**不提供自动运行机制**。

## 稳定性约定

- `--agent` 第一行、退出码、`plan.json` 字段名属于对外契约
- 破坏性变更升主版本，并在 CHANGELOG 标注 `BREAKING`
- 子命令只增不减；弃用命令保留一整个小版本并打印迁移提示

## 示例

~~~bat
:: 首次（陌生机器）：发现 + 全量快照
dsh-clean.cmd scan

:: 日常：增量，只报变化
dsh-clean.cmd scan --quiet

:: 给 agent 读
dsh-clean.cmd scan --agent

:: 裁决未归类项
dsh-clean.cmd review

:: 只清 A 档，先看计划不执行
dsh-clean.cmd apply --tier A --dry-run
~~~

回显示例：

~~~
> dsh-clean.cmd scan --agent
PURITY v0.1.0 dsh=44.7.0 roots=7 files=41208 changed=12 keep=41002 cache=186 residue=3/1.2GB unknown=4 locked=0 next=review
~~~

## 退出码与 CI 用法

`scan --quiet` 可直接接在批处理里：

~~~bat
dsh-clean.cmd scan --quiet --no-color
if errorlevel 3 goto :fail
if errorlevel 2 echo 有待裁决项
if errorlevel 1 echo 有残留待清
~~~
