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

### 规划中

- P1 上游校验：TOFU 哈希基线、`latest.yml` sha512 比对、已批准补丁白名单
- P2 决策与执行：`review` / `apply`、回收站通道、LOCKED 重试、判例库
- P3 体验：增量打磨、`export-learning`、可选 skill 外壳
- P4 可选：只读面板（薄壳，不含扫描逻辑）
