# 路线图

## 阶段总览

| 阶段 | 目标 | 主要产出 | 验收标准 |
|---|---|---|---|
| **P0** | 陌生机器也能列出全部 DSH 相关目录、报告变动、建立基线 | `install`、`scan`、`baseline`、技能、清单与变动报告 | 见下 |
| **P1** | 把判定变成可执行的清理 | `review`、`apply`、回收站通道、会话清理策略、判例库 | 每次删除都能从回收站还原；单项失败不中断 |
| **P2** | 与上游安装包比对（可选） | `verify`、`latest.yml` sha256/sha512 比对、已批准补丁白名单 | 能回答「客户端与官方安装包是否一致」 |
| **P3** | 一键可用 | `export-learning`、可选 skill 外壳、文档打磨 | 新机器三条命令完成首轮 |
| **P4** | 可选面板 | 薄壳插件（只读报告 + 一个 tool） | 自身不含扫描逻辑；坏掉时主链路仍可用 |

## P0 工作分解

| 文件 | 内容 |
|---|---|
| `dsh-clean.mjs` | 主入口、参数解析、子命令路由 |
| `lib/find-dsh.mjs` | 根目录发现：注册表卸载项、默认安装位置、portable 探测、AppData、工作区反解 |
| `lib/walk.mjs` | 快照遍历、指纹比对、增量差分、volatile 过滤、半成品保护 |
| `lib/classify.mjs` | 三源归类（判例 / 内置知识 / 结构判据）+ UNKNOWN 队列 |
| `lib/report.mjs` | `report.md`、人类模式输出、`--agent` 单行 |
| `data/knowledge.base.json` | 内置经验：宿主机制名单、名字模式、角色映射 |
| `data/rules.json` | 判据阈值（半成品 10 分钟、停滞 90 天、大件 100 MB 等） |
| `dsh-clean.cmd` | 启动器：定位程序、三级找 node、转发参数与退出码 |
| `install.cmd` / `uninstall.cmd` | 双击即用的部署/卸载入口，转调引擎对应子命令 |
| `lib/install.mjs` | 部署与回滚：复制程序、写技能、记 `install.json`、校验卸载 |
| `skill/SKILL.md` | 技能正文（约 2 KB）：何时触发、跑什么参数、怎么读摘要、怎么问人 |

P0 **不实现**：`review` / `apply` / `verify` / `export-learning` 的真实逻辑，仅保留 `--help` 文案与「将在 Pn 提供」提示。

## P0 验收清单

1. 全新终端：`git clone` → `dsh-clean.cmd scan` 一次成功，无需安装任何依赖
2. 报告里根目录不少于 4 类（安装 / 用户数据 / AppData / 工作区），每项都有 `source`
3. 归不进去的条目进入 UNKNOWN 队列，而不是消失
4. 全程不哈希全盘；本机 4 万文件量级耗时 < 10 秒
5. 二次运行走增量，`changed` 显著小于 `files`
6. 除 `state` 与 `reports` 外无任何写操作
7. 双击 `install.cmd` 后，DSH 技能列表里出现 `dsh-clean`，对话里可用；`uninstall` 后消失且无残留目录

## 风险与对策

| 风险 | 对策 |
|---|---|
| 注册表里找不到安装项（绿色版/被清理过） | 默认位置 + portable 探测 + `--install-dir` 手动指定，三级回退 |
| 不同 DSH 版本目录结构不同 | 内置知识按「角色」描述而非固定路径；判据是关系型的 |
| 目标机器没有 node | 三级回退（宿主环境变量 → Electron 主程序 + ELECTRON_RUN_AS_NODE → PATH），全失败时给出明确解决步骤 |
| 扫描被中断 | `inventory.json` 先写 `.tmp` 再原子重命名，不会留下半份状态 |
| 误判导致误删 | 默认 dry-run；B 档必须逐项裁决；C 档永不处置；只进回收站 |
| 隐私泄露 | 状态不进仓库；报告脱敏用户目录；回流只导出模式 |

## 不做的事

- 自动运行、后台常驻、定时任务
- 云同步、遥测、上传任何数据
- 修改客户端文件
- 非 Windows 平台（引擎已按可移植方式组织，后续可扩）
