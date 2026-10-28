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
- 技能里明确：报告要用 Markdown 链接给出（裸路径在客户端里点不开）；`--json` 不默认使用
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

### 规划中

- P1 上游校验：TOFU 哈希基线、`latest.yml` sha512 比对、已批准补丁白名单
- P2 决策与执行：`review` / `apply`、回收站通道、LOCKED 重试、判例库
- P3 体验：增量打磨、`export-learning`、可选 skill 外壳
- P4 可选：只读面板（薄壳，不含扫描逻辑）
