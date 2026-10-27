# 设计总览

本文说明 DSH-clean 为什么是现在这个形状，以及它怎么工作。

## 1. 形态决策

| 形态 | 能否分发 | 能否按需 | 主要问题 | 结论 |
|---|---|---|---|---|
| DSH 插件 | 差（依赖宿主版本、需安装） | 否（随宿主启动） | 检查器住在被检查对象里；自身往 `.dsh` 写 node_modules 与 `*.bak-<ts>`，制造待清残留 | 不用 |
| 纯 bat / PowerShell | 中 | 是 | 大量文件时慢；无法解析 asar；无结构化状态 | 只做外壳 |
| 纯 skill | 好 | 是 | 没有引擎，每轮靠模型重新推理，最贵且会漂移 | 只做附属 |
| **独立 CLI（Node 单文件）** | **好** | **是** | 无 UI | **采用** |

三条硬理由：

1. **可用性**：本项目要检查的正是「profile 坏了、node_modules 冲突、插件互相干扰」。检查器若寄生在 profile 里，它想测的故障会让它自己加载不了。
2. **可分发**：其他电脑/其他人复用要求解压即用、零依赖、自定位。插件带安装和版本矩阵，做不到。
3. **按需**：不常驻、不定时、不改宿主配置。一个 `.cmd`，几个子命令。

skill 作为可选外壳保留：它只在被调用时加载（约 2 KB），负责告诉 agent「什么时候跑、读哪个文件、怎么把结论压成一句话问人」。不带这个外壳，工具照常可用。

## 2. 数据流

每一步都可单独运行、结果落盘，任何一步中断都不丢状态。

~~~
find-dsh  ->  roots.json          发现安装 / 数据 / AppData / 工作区
                     |
                     v
                   scan  ->  inventory.json     (path, size, mtime)
                     |
   knowledge.base.json  (内置经验，随仓库)
   known.json           (本机判例)
   rules.json           (判据阈值)
                     |
                     v
              classify  ->  KEEP / CACHE / RESIDUE / UNKNOWN / LOCKED
                     |
        +------------+-------------+
        |            |             |
        v            v             v
    report.md    plan.json    unknown 队列
                     |
                 (人工裁决 review)
                     |
                     v
                  apply  ->  Windows 回收站
~~~

## 3. 四层处理

### 3.1 发现层（首次运行、或根目录变化时）

按可靠度依次尝试，全部失败才要求手动指定：

| 类别 | 来源 |
|---|---|
| 安装目录 | 注册表卸载项（DisplayName 含 DeepSeek Harness）→ UninstallString 反推；默认位置 `%LOCALAPPDATA%\Programs\DeepSeek Harness`；portable 版标记 |
| 用户数据 | `%USERPROFILE%\.dsh` |
| AppData | `%APPDATA%\@deepseek-ai\dsh-desktop` |
| 更新缓存 | `%LOCALAPPDATA%\@deepseek-ai\dsh-desktop-updater*` |
| 工作区 | 从 DSH 自身配置反解（`tool-management/history-workspaces.json`、会话索引、`memory/workspaces` 目录名） |

结果写入 `roots.json`，每项带 `source`（registry / default / portable / config / manual）与 `confidence`。之后只读表，不再重新发现——除非表中路径消失。

### 3.2 快照层

- 遍历每个 root，记录 `(relpath, size, mtimeMs)`；**不哈希**
- 指纹 `size:mtime`，与上一份 inventory 做 join，得到 `new / changed / gone`
- `node_modules` 照常遍历（它本身就是残留高发区），但按包粒度聚合展示
- 冷启动目标：4 万文件量级 < 10 秒

### 3.3 归类层（三源 + 兜底）

优先级从高到低，先命中先返回：

1. **本机判例** `known.json`：你裁决过的路径，永不重复问
2. **内置知识** `knowledge.base.json`：按名字模式、目录角色、宿主机制名单判定（随仓库分发，陌生机器首跑就有判断力）
3. **结构判据** `rules.json`：孤儿 / 悬空 / 被取代 / 空目录 / 临时备份 / 停滞
4. **都不中 → UNKNOWN**：显式入队，不静默丢弃。第一轮未知，你一句话裁决后进判例库

标签只有五个：`KEEP`、`CACHE`、`RESIDUE`、`UNKNOWN`、`LOCKED`。
归属 `owner`：`host` / `plugin:<name>` / `cache` / `workspace` / `unknown`。

### 3.4 计划层

`plan.json` 每项包含：编号、路径、体积、分类、档位、依据（哪条判据命中）、证据、建议动作。
计划不执行任何操作；`apply` 才动，且只做一件事——移入回收站。

## 4. 增量机制

| 场景 | 做什么 | 成本 |
|---|---|---|
| 冷启动（新机器首跑） | 发现根目录 + 全量元数据快照 + 内置知识归类 | 一次 stat 遍历，无哈希 |
| 日常巡检 | 读上一份 inventory，全量 stat 比对，只对变动项做归类 | 同上量级，但无文件读取 |
| 需要校验安装目录时 | 对安装目录文件做 sha256，按 `(size, mtime)` 缓存 | 首次数百 MB，之后增量 |

哈希分级：安装目录必哈希（一致性是目标 3）；数据目录默认不哈希，仅当某条目 > 50 MB 且待裁决、需要判断「是否与某安装包同源」时才读内容。

## 5. 运行期约束（不要求关闭客户端）

实测：客户端运行中，`.dsh` 全树 15 分钟内仅约 6 个文件变动，且都是可枚举的已知写手（用量账本、模型目录、会话索引）。所以只读扫描完全可以开着跑。

- **volatile 名单**：`sessions/`、`logs/`、`storages/`、`cache/*`、`guardian/`、`*.ndjson`、`*.jsonl`、`*.sqlite*`、`*.lock` 的变动不计入 `changed`
- **半成品保护**：`mtime` 在 10 分钟内的文件，不判残留、不列入计划
- **LOCKED**：`EBUSY` / `EPERM` 的条目记 `LOCKED`，跳过并留在队列，下轮重试，不报错、不重试死循环
- 唯一需要关闭客户端的场景：要移动正被映射的安装目录文件（罕见），届时工具会明确提示

## 6. 成本模型

| 使用方式 | token | 说明 |
|---|---|---|
| 直接跑 `.cmd` | 0 | 人不经模型 |
| 首次由 agent 判读 | 约 1–2k | 一次调用 + 读报告首屏 + 若干裁决 |
| 日常增量 | 200–400 | 一行摘要 + 必要时 2–3 条问句 |

省 token 的机制不是「扫得更快」，而是：结果落盘、摘要定长、变动才报、裁决不重复问。

## 7. 非目标

- 不做常驻进程、定时任务、启动钩子
- 不做 GUI（P4 只是可选的只读面板，不含扫描逻辑）
- 不修改客户端文件；唯一的写动作是把文件移进回收站
- 首发不支持非 Windows 平台
