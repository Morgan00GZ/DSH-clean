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
| `scan` | P0 | 发现全部相关目录、快照、归类、与上次和基线对比、写报告 | 只写 state 与 reports |
| `baseline` | P0 | 把当前状态记为「刚安装并配置完毕」的基准 | 写 baseline.json |
| `review` | P2 | 把待确认项整理成中文清单（默认写文件，可选窗口内编号问答），裁决写入判例库 | 写 known.json |
| `apply` | P2 | 按计划与裁决把文件移入回收站 | 移动文件 |
| `verify` | P1 | 安装目录一致性校验（基线哈希 + 上游 `latest.yml`） | 写 baseline |
| `export-learning` | P3 | 导出脱敏后的判例片段，可直接提 PR | 写 data |

P0 只有 `scan` 有实现；其余命令以 `--help` 文案占位，调用时提示「该命令将在 Pn 提供」。

## 部署（install / uninstall）

`install` 只写三个位置，全部可逆：

| 写什么 | 写去哪 | 卸载时 |
|---|---|---|
| 程序本体 | `%LOCALAPPDATA%\dsh-clean\app\` | 删除 |
| 技能 | `%USERPROFILE%\.dsh\skills\dsh-clean\SKILL.md`（或 `--project` 时工作区下） | 删除 |
| 安装记录 | `%LOCALAPPDATA%\dsh-clean\install.json` | 保留到卸载完成，用于精确回滚 |

`install` 是幂等的：重复运行即升级程序与技能，不会产生多份副本。
`uninstall` 按安装记录逐项删除，删除后校验技能目录已不在，避免留下「孤儿技能」——那正是本工具要检查的那类残留。

默认**不动**状态目录与历史报告（里面是你的判例库）；要一起清就加 `--purge`。

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
| `--state-dir <path>` | 全部 | 覆盖状态目录，默认 `%LOCALAPPDATA%\dsh-clean` |
| `--json` | 全部 | 输出单个 JSON 对象 |
| `--agent` | `scan` | 输出固定两行机读摘要 |
| `--quiet` | 全部 | 只输出摘要，不输出区块明细 |
| `--no-color` | 全部 | 关闭 ANSI 颜色（重定向时自动关闭） |
| `--full` | `scan` | 忽略 `roots.json`，重新做一次发现 |
| `--only <class>` | `scan` | 只显示某类，如 `--only residue,unknown` |
| `--dry-run` | `apply` | 默认开启；显式 `--no-dry-run` 才真正移动 |
| `--ids 1,3,5` | `apply` | 按计划编号执行 |
| `--tier A` | `apply` | 按档批量执行（仅 A 档允许） |
| `--plan <file>` | `apply` | 指定历史计划文件 |
| `--upstream` | `verify` | 联网读取 `latest.yml` 做安装包比对 |
| `--accept-patch <file>` | `verify` | 把当前哈希登记为「已批准补丁」 |
| `--install-dir <path>` | `scan` `baseline` | 手动指定 DSH 安装目录（注册表与默认位置都失败时用） |
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

**最多两行**。第一行是稳定契约：

~~~
PURITY v0.1.0 dsh=44.7.0 roots=7 files=41208 changed=12 keep=41002 cache=186 residue=3/1.2GB unknown=4 locked=0 next=review
~~~

- 字段名、顺序固定；**新增字段只能追加到行尾**
- 体积用紧凑写法（`1.2GB`），无空格
- `next=` 取值：`scan` / `review` / `apply` / `none`（全净）

第二行仅在需要人决策时出现，形如：

~~~
ACTION 4 unknown entries pending; run "review" or answer by id
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
