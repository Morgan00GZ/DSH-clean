# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

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

### 规划中

- P2 收尾：旧状态目录与旧报告的自动收尾（保留最近 10 份）
- P3 体验：增量打磨、`export-learning`、可选 skill 外壳
- P4 可选：只读面板（薄壳，不含扫描逻辑）
