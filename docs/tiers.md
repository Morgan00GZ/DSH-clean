# 分级与判据

## 1. 「干净」的四条可测条件

| # | 条件 | 验收方法 | 不达标的表现 |
|---|---|---|---|
| 1 | 相关文件夹可穷举 | `roots.json` 每项都有 `source`；无「扫描时才发现但未登记」的路径 | 出现未登记根目录 |
| 2 | 每个目录都有归属 | 顶层目录 `owner` 覆盖率 100%，`unknown` = 0 | 有 `.dsh` 顶层目录说不出归谁 |
| 3 | 安装目录与安装包一致 | 除白名单外，哈希差异为 0 | 出现未登记的改动文件 |
| 4 | 无历史残留 | RESIDUE 队列为空，或全部裁决为 KEEP 且记录理由 | 有残留长期挂着 |

前两条不满足时，第 3、4 条没有意义——清完也不知道清的是什么。

## 2. 三档

| 档 | 含义 | 执行方式 |
|---|---|---|
| **A** | 无引用、可重建、或明确的临时产物 | 仍需显式 `apply`；可按档批量 |
| **B** | 体积大、或牵涉回滚/备份策略、或归属存疑 | 必须逐项裁决，不可批量 |
| **C** | 宿主机制、运行必需、用户资产 | 工具永不处置，只出现在报告中 |

超过 100 MB 的 RESIDUE 一律强制进 B 档，即使判据判为 A。

## 3. 判据清单

| id | 判据 | 命中条件 | 默认档 |
|---|---|---|---|
| `orphan-dir` | 名字无对应插件 | `.dsh` 顶层目录名既不在 `node_modules`、也不在名册与内置知识中 | B（先看内容） |
| `dangling-ref` | 悬空引用 | `cordis.patch.yml` / `pnpm-workspace.yaml` 引用了未安装的插件 | A |
| `superseded` | 被取代 | 同目录存在更晚的同类索引/快照文件 | A |
| `bak-timestamp` | 时间戳备份 | 文件名含 `-bak-<ts>` 或 `.bak-<ts>` | A |
| `tmp-partial` | 半成品 | `*.tmp` / `*.part` / 0 字节，且 mtime > 10 分钟 | A |
| `empty-dir` | 空目录 | 递归后 0 文件 | A |
| `rebuildable` | 可重建缓存 | 位于 `.dsh\cache\*`，且无活跃引用 | A |
| `stale-log` | 停滞日志 | 日志目录中 mtime > 90 天 | A |
| `dup-version` | 重复版本 | 同一包存在多版本，仅一个被引用 | B |
| `big-artifact` | 大件 | 被判 RESIDUE 且 > 100 MB | B |
| `uninstalled-plugin-data` | 卸载遗留 | 数据根一层的目录/文件，名字能对上某条「已卸载」名册记录（去 scope、去 `dsh-`/`plugin-` 前缀后主干词相同或同族） | B |
| `stale-config-row` | 死配置行 | `cordis.patch.yml` 的 `- id:`/`name:` 指向的包既不在 profile、也不在客户端内置包 | B（只报告，不进清理清单） |
| `upgrade-leftover` | 升级遗留 | dsh-ops 受限 MSYS 缓存的 identity 与当前收据不符，或缺 `.ops-ipc.json`（暂存中断） | B |

判据是**关系型**的，不写死具体路径。这样换机器、换版本依然成立。新增一类残留有两条路：路径类的往 `rules.json` 加一条；关系类的（要跨文件推断）在 `lib/` 里加一个判据模块并在 `scan.mjs` 接线。

另有两条**插件包体检**项不进残留表，只在「插件包」段报告：

| id | 判据 | 命中条件 | 后果 |
|---|---|---|---|
| `host-link` | 宿主符号链接 | `node_modules` 里的链接指向安装目录（`app.asar`）或 profile 之外 | pnpm install 抛 `[ENOTDIR]`，删链接即修，运行时不依赖 |
| `dangling-link` | 悬空链接 | 链接目标已不存在 | 属残留，可清 |

## 4. 硬边界

1. **只进回收站**：任何删除动作都是移到 Windows 回收站，可从回收站还原。不做永久删除、不做「移动到隔离目录」。
2. **NOT-MINE**：不是本工具生成的文件，在没有明确残留证据时只报告、不处置。
3. **禁动清单（C 档，示例）**：`dsh-runtimes`、`models`、`profiles/*/node_modules`、`dsh-ops`、`sessions`、`attachments`、`guardian`、`integrations`、`dependencies`。
4. **未裁决的 B 档不执行**：`apply` 遇到没有裁决记录的 B 档条目直接跳过并提示。

## 5. 边界案例（本机实测，已沉淀进内置知识库）

| 路径 | 像什么 | 实际是什么 | 档 |
|---|---|---|---|
| `.dsh\guardian` | 像 `dsh-my-guardian` 插件残留 | 宿主自带启动名册预检的缓存，仍在写 | C |
| `.dsh\dsh-runtimes` | 运行时目录，像缓存 | 宿主运行时（约 289 MB），app.asar 直接引用 | C |
| `profiles\desktop\node_modules` | 依赖堆积 | 已核验无孤儿包的工作集（约 951 MB） | C |
| `rollback-points\objects` `payloads` | 可删的旧快照 | 回滚点内容，手删会留下指向空洞的记录 | B（走插件 UI 裁剪） |
| `profiles\.dsh-backups` | 备份，留几份随意 | 切配置出问题时的回退路径 | B（保留份数是策略问题） |
| `cordis.patch.yml.bak-<ts>` | 配置本体 | 插件改写配置时的时间戳备份 | A |
| `.dshw-*.json` | 当前状态文件 | 旧版命名迁移遗留，最后写入停在迁移前 | A |
| `.dsh\prompt-inject.md` | 正常的配置 | 非 DSH 产物；出现在根目录即注入式残留 | B |

最后一条说明了本项目的边界：它不只查「冗余文件」，也查**不属于这里的东西**。

## 6. 档位与执行

| 档 | 需要显式 apply | 可批量 | 需要裁决记录 |
|---|---|---|---|
| A | 是 | 是（`--tier A`） | 否 |
| B | 是 | 否 | 是（逐项） |
| C | 永不 | 否 | — |
