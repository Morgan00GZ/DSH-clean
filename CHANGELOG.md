# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 发布工具 - 推送与挂 Release

- 新增 `tools/push.cmd` + `tools/push-github.mjs`：先列出领先提交数与待推 tag，确认后 `git push -u origin <branch>` + `git push origin --tags`；`--dry-run` 只预览，`--yes` 免询问
- 新增 `tools/release-github.cmd` + `tools/release-github.mjs`：只发布 tag `0.3`；校验本地/远程 tag、ZIP 与校验和、`gh` 可用与登录状态，Release 说明自动取自 `CHANGELOG.md` 的 `[0.3.0]` 段；已存在则覆盖上传资产（幂等）
- 新增 tools/launch-tool.ps1：找 Node 的顺序为 环境变量 → PATH 里的 node → %LOCALAPPDATA%\dsh-clean\node-path.txt 缓存 → 标准安装目录 → 注册表；都没有时问一次 DeepSeek Harness.exe 路径并写入缓存（lib/launch.ps1 也读该缓存，修掉自定义安装路径下找不到 Node 的问题）
- 两个工具都用 `--dry-run` / `--yes` 控制，`DSH_CLEAN_GIT` / `DSH_CLEAN_GH` 可覆盖可执行文件路径；`tools/` 仍被 `.gitattributes` 排除在发行 ZIP 外

## [0.3.0] - 2026-11-02

### 修复 - 非中文用户的汇报语言

- `skill/SKILL.md` 不再写死「用中文汇报」：改为按用户消息的语言汇报（说英文就回英文），并明确「工具自身输出是中文，向非中文用户按需翻译，不要整段照抄」
- 清理前的询问同样改为跟随用户语言（中文「要清哪几项」/ English "which items to clean"）
- 技能 `description` 补一句英文，方便英文语境的触发
- 顺手修正文案：回归测试用例数 13 → 15（实际 15 个）
- README 两版「已知限制」新增一条：CLI 控制台与 `report.md` 仍为中文，助手按用户语言汇报；CLI 自身英文输出尚未实现

### 发布与分发 - 0.3

- 版本号 `0.2.0` → `0.3.0`；发布 tag `0.3`
- `tools/release.ps1` 的 `-Tag` 改为必填参数，不再硬编码默认版本

## [0.2.0] - 2026-11-02

### 发布与分发 - 0.2

- 文档拆成英文 `README.md` + 中文 `README.zh-CN.md`（GitHub 惯例，英文为默认入口，两版逐节对应）
- 新增 `tools/release.ps1`：按 tag 用 `git archive` 生成 `dsh-clean-<版本>.zip` 与 `SHA256SUMS.txt`；测试与开发脚本由 `.gitattributes` 的 `export-ignore` 排除在 ZIP 之外
- 版本号 `0.1.0` → `0.2.0`；发布 tag `0.2`
- README 快速开始改为「Releases 下载 ZIP → 解压 → 双击 install.cmd」，clone 降为开发者选项

### 修复 - 报告可读性与升级丢补丁的处置

- `PATCH-LOST` 不再只说「见报告」：报告「已知改动」段给出两条出路（重新打补丁后 `accept` 重登记 / `unaccept` 去掉记录），简报里也有同样的一行处置建议
- 「名册对账」措辞改清楚：`pnpm-lock 声明 N 个（含间接依赖与其他平台的可选包） / node_modules 实际 M 个`，并补一句「声明数通常大于实际数，只有孤儿/缺失/版本不符非零才是问题」，消除 229 vs 182 的误读
- 两个文案抽成纯函数 `patchLostAdvice` / `lockReconcileText`，新增 2 个回归用例（共 15 个）
- 文档同步：`docs/tiers.md` 判据清单补 `uninstalled-plugin-data` / `stale-config-row` / `upgrade-leftover` 并说明 `host-link` / `dangling-link` 属插件包体检；`docs/state.md` 补齐两条新判据与 `orphan` / `cfgbad` 字段

### P2 - 卸载遗留判据与回归测试

- 插件卸载后留在 `~/.dsh` 下的数据目录/文件不再静默混进「未归类」：新增 `lib/orphans.mjs`，拿名册（`roster.json`）里 `status=retired` 的记录当「已卸载插件」，按名字子集/同族前缀认领数据目录与顶层文件，命中报 `uninstalled-plugin-data`（tier B），带体积与「属于哪个已卸载插件」
- 启动层死行单独成判据：解析 `cordis.patch.yml` 的 `- id:`/`name:` 对，包名像插件（`dsh`/`harness`/scoped）且既不在 profile 也不在客户端内置包里 → `stale-config-row`（tier B）。**只报告不改文件**，且永不进清理清单（`plan.json` 用 `NO_APPLY_RULES` 排除，`apply` 不会去动 yml）
- 内置包识别：读 `resources/app.asar/dsh/node_modules`（实测 `ELECTRON_RUN_AS_NODE` 下 `node:fs` 是 asar 感知的，`original-fs` 反而读不进去）。不认内置包时，cordis 里上百行指向 `@deepseek-ai/*` 组件会被全报成死行（实测假阳性 17 → 0）
- `--agent` 行仅在命中时追加 `orphan=N` / `cfgbad=N`；报告新增「卸载遗留物」小节与 `UNINSTALL-LEFTOVER` / `STALE-PATCH-ROW` 提示
- 新增回归骨架：`tests\run.cmd` → `tests/run.mjs` 跑 `tests/cases/*.mjs`（孤儿匹配正反例、死行、升级遗留物、机读行渲染），13 个用例全绿


### P4 - 只读报告插件（已撤销）

- 试做过 `dsh-clean-report` 插件（注册只读工具 `dsh_clean_report`，读取最近一次扫描报告），因工具在客户端里始终注册不上，已整体移除：仓库不再有 `plugin/`，交互恢复为纯文字（命令 + 报告文件）

### P1 - 符号链接体检

- 扫描新增「符号链接」判据：`node_modules` 里指向安装目录（`app.asar`）或 profile 之外的链接 → 报为风险项（`HOST-LINK`，会让 pnpm install 崩），并把悬空链接算作残留
- 修复方式写在报告里（删链接即可，运行时不依赖）；`--agent` 行在有风险时追加 `HOST-LINK N ...` 提示，干净时不占 token
- 判据双向验证：合成 junction 指向含 `app.asar` 的路径 → 报 1 条；profile 内部的普通 junction → 不报
### P2 / P3 - 升级遗留物检测

- 扫描自动发现「升级/出错遗留物」：dsh-ops 受限模式 MSYS 缓存中，identity 与当前安装收据不匹配的死缓存（旧版本升级后不再被选中），以及暂存中断（缓存目录名与内部标记不一致）
- 检出项进入残留清单（tier=B，rule=upgrade-leftover），报告新增「升级遗留物」段，`--agent` 行尾加 `leftover=N`
- 判据实现于 `lib/leftover.mjs`，单测与真机验证均通过（当前在用缓存不被误报）

## [0.1.0] - 2026-10-29

首个可用版本：清点、清理、上游校验、判例库、收尾，全部落地。

### P0 - 只读清点（本机已跑通）

- `install` / `uninstall`：程序部署到 `%LOCALAPPDATA%`，技能装进 `~/.dsh/skills`，可精确回滚
- 技能 `dsh-clean`：在对话里一句话触发扫描，交互全程留在对话内
- 全机相关目录发现：安装 / 数据 / AppData / 更新缓存 / 工作区 / 名字与特征匹配的疑似目录
- 每次运行输出「相关文件夹清单」与「纯净度对比」
- 纯净度改为**推断**：从安装目录的 mtime 主峰推出安装时刻，不需要用户先记基线
- 插件基线：pnpm 硬链接 + 仓库原件哈希校验 + 锁文件名册对账（孤儿 / 缺失 / 版本不符）
- 插件数据目录：体积、本次增减、最近写入时间
- 会话统计：会话数、体积、最早/最新、可疑半成品
- 根目录发现：注册表卸载项、默认安装位置、portable 版、用户数据、AppData、updater 缓存、工作区
- 全量元数据快照（path / size / mtime），不哈希全盘
- 判据引擎 + 内置知识库 + unknown 队列
- 人类报告 `report.md` 与机读摘要 `--agent`
- 实测：93k 文件 / 7 个根 / 1.0 秒；二次运行 `changed=0`
- Electron 的 asar 虚拟 stat 已用 `original-fs` 绕过
- 不做：任何删除动作

### P0.1 - 省 token 与免放宽沙箱

- 状态与报告默认改到 `<工作区>\Temp\dsh-clean\`，日常扫描不再写 `%LOCALAPPDATA%`，也就不需要放宽沙箱
- 新 `--section <名字>`：只打印报告的一段（residue / plugins / sessions / folders / purity / top / unknown / patches），追问细节时从几千 token 降到一两百
- 技能里的调用行改成直连运行时（`ELECTRON_RUN_AS_NODE=1 "…DeepSeek Harness.exe" "…dsh-clean.mjs"`）：套一层 `cmd` 调 `.cmd` 会静默不执行、输出全空，白烧一次模型调用
- 技能里明确：报告要用 Markdown 链接给出，且路径含空格时必须写成 `[文字](<路径>)` —— 少了尖括号，客户端只认到空格前那截，点了打不开；`present` 可用时优先给文件卡
- 迁移：`install` 时把旧状态目录的 roots / patches / roster / probe-cache / last-run 与 reports / inventory 只补不覆盖地搬到新目录
### P1 - 已知改动（用户自己打的补丁）

- accept <文件> --note="为什么改"：把一处手工改动记成「用户认可」，之后不再算脏；只存 sha512，不存文件内容
- 每次扫描只多算一次哈希：对得上 = 补丁在位；变回 pnpm 原件 = 升级或重装覆盖了补丁（报 PATCH-LOST）；变成第三种 = 又被改过，照常报
- unaccept <文件> | --all：撤销记录
- 报告新增「已知改动」段（人类 / Markdown / JSON，--agent 首行加 patch=在位/异常）
- 已认可的路径同时从「插件包被改过」「多余副本」「备份文件硬证据」三处排除

### P1 - 名册历史与探测（卸掉的插件留下的东西）

- `state/roster.json`：记下每个插件的首次/末次出现与状态。插件从 `node_modules` 消失即标 retired；数据目录还在就报**残留**（规则 `plugin-data-orphan`），不再是「宿主数据」
- 已知根之外的目录探测：三类硬证据才能纳入扫描 —— 目录里有 `cordis.yml` / `.dsh` / `app.asar`、已装插件代码里点名了这个目录、目录名与已装插件同名
- 只有弱线索的目录进报告「疑似相关」段，不纳入体积统计；别家的同名目录（如 `~\.workbuddy`）不会被拉进来
- 插件代码只按「已装插件版本签名」扫一次，结果缓存在 `state/probe-cache.json`；插件没变就不再读文件（实测二次扫描 6.3 秒 → 1.1 秒）
- `--agent` 首行加 `probe=+新找到/疑似`，末行加 `REPORT <report.md 路径>`
- 本机实测：从 9 个根到 12 个根，新纳入 `~\.mnemon`、`~\.agent-helm`、`~\.android`

### P1 - 清理通道（review / apply，全部进回收站）

- `review`：把最近一次扫描的待清理项按体积排成带编号的清单，**不删任何东西**，几百 token 就能看完
- `apply --ids=1,3 --yes` / `--tier=A` / `--all`：按编号送进 Windows 回收站；不加 `--yes` 只列清单
- 删除全程走 `lib/recycle.ps1`：先自检回收站可写（不可写就一个都不删）→ 删 → 比对回收站新增的 `$R` 条目逐项核实，拒绝「静默降级成永久删除」
- 沙箱里启不了 PowerShell（`EPERM`）时明确报「一个都没删」并提示放宽沙箱，绝不假装成功
- 目标路径二次校验：越界、目录穿越、指向根目录本身的一律拒绝执行
- 每次真清理往 `apply-log.jsonl` 记一行台账（路径 / 体积 / 回收站条目名）
- `apply.cmd`：双击即用，先列清单再问编号，回车即取消
- 三个 `.cmd` 启动器加 `chcp 65001`，控制台里的中文不再乱码

### P1 - 上游校验（对照安装包）

- 安装目录存一份「本机首次信任」哈希基线（baseline.json）；之后每次只比 mtime+大小，对不上才真去算哈希——平时零额外 IO
- 发行方保留原时间戳的文件（7zip-installer-*）归为「已解释」，不再算脏；纯度由此归零
- 新增 verify 子命令：默认用 mtime+大小闸门，--rebase 重建基线，--agent 输出机读摘要
- --upstream <手动解压目录>：不 spawn 外部进程，最稳的上游对账
- --installer <exe>：用 7-Zip 自动解包官方安装包再对账（NSIS 外层到 $PLUGINSDIR/app-64.7z 内层，自动定位应用载荷根）
- 实测：本机安装目录 7814 文件与官方安装包 7811 个包内文件全部一致，0 差异；仅 3 个包外文件（7zip-installer-* 与 Uninstall exe）属合法安装产物

### P2 - LOCKED 重试（正在写入的这次不判）

- 扫描完先用两次 `lstat` 抽样（间隔 900ms）验一遍候选：大小或修改时间还在变 = 有人正在写，标 LOCKED 并从残留/未归类里拿掉，**不进清理清单**
- 目录候选看「修改时间 + 直接子项数」，目录里新增/删除文件也能抓到；抽样期间消失的直接不再报
- 报告新增「正在使用（本次跳过）」段，`--agent` 加 `locked=N`，`--section=locked` 可单看；最多 300 个候选，候选为 0 时完全不等待
- 替掉原来那段「10 分钟内写过的文件不判」的空实现（那段代码从来没生效过）
- 实测：向缓存目录里的 installer.exe 持续追加，扫描判为 LOCKED、不进清单；停止写入后下一次扫描正常转为残留

### P2 - 判例库（judge / unjudge）

- 新增 `judge`：把一处判定记进 known.json，以后扫描不再重复问。可带清单编号或绝对路径，按磁盘实际类型决定「整块目录」还是「单个文件」
- 四档判定：KEEP / CACHE / RESIDUE / UNKNOWN；判成 RESIDUE 的整块目录直接进清理清单（判据 `judged`），判成 KEEP 的连里面的文件都不再挑
- 新增 `unjudge`：撤一条或 `--all` 全撤
- 判例随扫描续命：还在的刷新 `lastSeen`，路径消失超过 90 天标 `stale`；判例库只记人做过的决定，不做推断
- 报告新增「判例库」段，`--agent` 加 `known=N`，`--section=known` 可单看
- 归属判据补一条：顶层目录里若（2~3 层内）装着与已装插件同名的目录，整块归给那个插件——插件自己的 `state\desktop\<插件名>\` 不再被报成「无法归属」
- 实测：判 `td:mystery` 为 KEEP 后未知项 3→2；判 `td:keep` 为 CACHE 后未知项再降；判 `td:mystery` 为 RESIDUE 后进清单（判据 judged）

### P2 - 状态与报告收尾（prune）

- 新增 `prune`：历史报告按 `YYYYMMDD-HHMMSS` 排序，只留最近 10 份（`--keep=N` 可改），其余进回收站；`--dry-run` 先看清单
- 旧状态收尾：`%LOCALAPPDATA%\dsh-clean` 里遗留的 roots / patches / roster / probe-cache / last-run / sizes / known / node-path.txt / inventory / reports，**先确认新状态目录里有（缺的先补过去）再收走旧的那份**——判例、补丁记录不会丢
- 旧 reports 目录：新位置历史已够长就直接收；不够长先把缺的补过来
- 扫描不自作主张收尾，只在超过保留数时提示：人类报告多一行「收尾」，`--agent` 行尾 `reports=N/prune`
- 顺带修掉两处自产垃圾：`install` 不再创建空的 `inventory` 目录；`node-path.txt` 弃用，节点路径改从 `install.json` 读（旧文件交给 prune 收）
- `install` 现在把仓库里所有 `*.cmd`（含 `apply.cmd`、`prune.cmd`）一并装到程序目录——此前只有 `dsh-clean.cmd` 被复制，双击入口会缺
- 顺手清掉自产垃圾：状态目录里的空 `inventory` 目录、`tmp\recycle-list-*.json`；回收站清单文件拿到回执后即删，不再无限攒
- 新增 `prune.cmd`：双击即用，先列清单再问一句，回车执行
- 实测：夹具 15 份报告 + 6 个旧状态文件 + 旧 reports 目录 → 一次收走 12 项，报告留 10、旧安装根只剩 app 与 install.json；再跑一次输出「已经收拾干净」，可重复执行

### P3 - 会话收尾、变动摘要、导出判例

- 会话清理纳入统一清单：空工作区容器、空会话目录、工作区路径已消失但还留着历史的（后者要人点头，B 档）。**工作区本身还在的空容器不列入清理**（那是正常占位，用户明确要求过不要动）
- 报告新增「本次变动」段：和上次扫描比，文件 / 残留 / 未归类 / 会话 / 插件 / 判例各变了多少，`--section=changes` 可单看
- 新增 `export-learning`：把本机判例导出成脱敏片段（只留名字模式与判定，不带绝对路径和用户名），可直接提 PR 反哺内置知识库
- 插件校验的措辞收紧：只有「内容与 pnpm 仓库原件对不上」这一条证据时，不再直接判成「被改过」，改记「无法校验」并单列——插件的安装脚本、不同源的复制安装都会造成同样的现象，不能拿它当篡改证据
- 报告的「顶层目录」表格改成**目录结构树**：按根分组，只往下展开插件（`profiles … node_modules` 里的包，标 `[插件]`）与会话（标标题）两棵子树，其余目录只列一层，每层最多 7 项，多的折成「… 还有 N 项」——一眼看清体积落在哪个插件 / 哪个会话上
- 树里顺带修了两个老毛病：文件的体积会算进去（以前文件行显示 0B）；目录联接（junction）指回上层时不再无限展开

### 规划中

- P3 体验：增量打磨、可选 skill 外壳
- P4 可选：只读面板（薄壳，不含扫描逻辑）
