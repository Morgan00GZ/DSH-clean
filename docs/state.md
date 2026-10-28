# 状态与知识

## 目录布局

状态目录默认放在**工作区里**（`<当前目录>\Temp\dsh-clean\`），程序与安装记录留在 `%LOCALAPPDATA%\dsh-clean`。这样日常扫描只写工作区，不需要放宽沙箱；只有 install / uninstall 要动工作区外的两处。

解析顺序：`--state-dir` → 环境变量 `DSH_CLEAN_STATE` → 安装记录里的 `stateDir` → `<当前目录>\Temp\dsh-clean`。

旧的 `%LOCALAPPDATA%\dsh-clean` 布局里的状态会在 `install` 时**只补不覆盖**地移到新目录（roots / patches / roster / probe-cache / last-run 与 reports / inventory），旧文件不删，确认无误后可手动清掉。

```
<工作区>\Temp\dsh-clean\
  roots.json              根目录登记表
  inventory.json          最近一次完整快照
  baseline-install.json   安装目录哈希基线（P1 起）
  known.json              本机判例库
  patches.json            用户认可的改动（补丁）：路径 + sha512 + 备注
  roster.json             插件名册历史：谁什么时候装的、什么时候消失的
  probe-cache.json        插件代码点名了哪些目录（按插件版本缓存，避免重复读文件）
  sizes.json              每个顶层目录上次的体积（算「这次多了多少」）
  last-run.json           最近一次运行的一行摘要 + 报告路径
  apply-log.jsonl         清理台账：什么时候把什么送进了回收站（一行一条）
  install.json            安装记录（程序/技能的实际落地路径与版本）
  reports\
    20261027-215812\
      report.md           人类报告
      plan.json           计划（含编号，机读）
      pending.md          待确认清单（中文，人看）
      run.json            本次运行的元数据（耗时、版本、参数）
```

## apply-log.jsonl

每执行一次真清理（`apply … --yes`）追加一行，不覆盖、不回滚：

~~~json
{"at":1761000000000,"ok":true,"items":[{"id":1,"path":"C:\\Users\\User\\AppData\\Local\\@deepseek-aidsh-desktop-updater\\installer.exe","bytes":289406976,"status":"RECYCLED","bin":"$R3PYQ8U.exe"}]}
~~~

`status` 取值：`RECYCLED` 已进回收站、`PERMANENT-DELETE` 没进箱（被永久删了，脚本会报警）、`FAILED-STILL-THERE` 还在原地、`MISSING` 本来就不在了。`bin` 是回收站里的条目名（`$R…`），要还原时按它找。

## patches.json

用户自己改过的插件文件（打补丁）不该算脏，也不该在插件升级把它覆盖后悄无声息地丢掉。

~~~json
{
  "schema": 1,
  "items": [
    {
      "path": "C:\\Users\\User\\.dsh\\profiles\\desktop\\node_modules\\@njjpro\\dsh-remote-workspace\\lib\\index.js",
      "sha512": "6b2b…（128 位十六进制）",
      "size": 24701,
      "note": "用户自改：dsh-remote-workspace/index.js",
      "acceptedAt": 1793000000000
    }
  ]
}
~~~

**只存哈希，不存内容。** 每次扫描对每个条目算一次 sha512（几十 KB 的文件，成本可忽略），结局有三种：

| 现状 | 判定 | 报告位置 |
|---|---|---|
| 哈希与记录一致 | 补丁在位 | 「已知改动 N 处」 |
| 哈希能在 pnpm 仓库里查到 | 已恢复成原件，升级或重装覆盖了补丁 | 「补丁异常」+ PATCH-LOST |
| 两者都不匹配 | 又被别人改过 | 「补丁异常」+ 照常计脏 |

状态**不在仓库内**：仓库可只读、可多处克隆、多台机器互不污染。`--state-dir` 可覆盖，便于把状态放进同步盘或测试沙箱。

## roster.json

回答「这个数据目录是谁的、那家伙还在不在」。

~~~json
{
  "schema": 1,
  "known": {
    "dsh-bottom-info-bar": {
      "firstSeen": 1793000000000, "lastSeen": 1793163913014,
      "status": "retired", "retiredAt": 1793163913014, "version": "1.2.0"
    }
  }
}
~~~

判定只有两步：

| 现状 | 结论 |
|---|---|
| 名册里 status=installed，数据目录在 | 正常，归属该插件 |
| 名册里 status=retired，数据目录还在 | **残留**（`plugin-data-orphan`），插件卸了数据没清 |
| 名字在宿主基础设施清单里 | 宿主数据，不归任何插件 |

匹配用归一化名字（去 `@scope/`、去非字母数字、转小写），因为 npm 包名和目录名不一定一致。

局限：名册是从**装上这个工具那天**开始记的。更早卸掉的插件从来没有出现在名册里，不会被判成残留——这是证据制判定必然的边界，宁可漏报也不冤枉。

## probe-cache.json

探测「已知根之外还有哪些 DSH 相关目录」要去翻已装插件的入口文件，看它有没有点名某个目录。这很贵（几百个包、上百 MB），所以按插件的 `name@version` 签名缓存：插件没变，直接复用上次的扫描结果。

缓存键是「已装插件的名字+版本排序后拼接」的哈希。装、卸、升级任何插件都会让缓存整体失效并重扫一次。

## roots.json

```json
{
  "schema": 1,
  "generatedAt": 1761574800000,
  "machine": { "dshVersion": "44.7.0", "os": "windows", "arch": "x64" },
  "roots": [
    { "id": "install", "kind": "install", "path": "D:\\Software\\DeepSeek Harness",
      "source": "registry", "confidence": "high", "dshVersion": "44.7.0" },
    { "id": "data", "kind": "data", "path": "C:\\Users\\<user>\\.dsh",
      "source": "default", "confidence": "high" },
    { "id": "appdata", "kind": "appdata", "path": "...\\@deepseek-ai\\dsh-desktop",
      "source": "default", "confidence": "high" },
    { "id": "updater", "kind": "cache", "path": "...\\dsh-desktop-updater",
      "source": "default", "confidence": "medium" },
    { "id": "workspace:1", "kind": "workspace", "path": "D:\\DeepSeek Harness",
      "source": "config", "confidence": "high" }
  ],
  "volatile": ["sessions/", "logs/", "storages/", "cache/", "guardian/"]
}
```

- `source`：`registry` / `default` / `portable` / `config` / `manual`
- `confidence`：找不到时降级，并在报告中提示
- 表内路径失效（被删/改名）时，下次 `scan` 自动重新发现该类别

## inventory.json

体积敏感，用数组而不是对象：

```json
{
  "schema": 1,
  "rootId": "data",
  "scannedAt": 1761574800000,
  "count": 20841,
  "entries": [
    ["profiles/desktop/package.json", 1658, 1761000000000],
    ["cache/attachments/ab/abcdef.png", 40231, 1761500000000]
  ]
}
```

每个 root 一份，避免单文件过大。`(relpath, size, mtime)` 三元组即指纹，够用且零解析成本。

## baseline-install.json（P1）

```json
{
  "schema": 1,
  "dshVersion": "44.7.0",
  "feed": "https://download.deepseek.com/dsh-desk/feeds/win-x64/",
  "channel": "nightly",
  "capturedAt": 1761574800000,
  "files": {
    "resources/app.asar": ["<sha256>", 182794869, 1760000000000],
    "DeepSeek Harness.exe": ["<sha256>", 246343144, 1760000000000]
  },
  "patches": [
    { "file": "resources/app.asar", "sha256": "<sha256>",
      "reason": "skillhub desktop profile patch", "approvedAt": 1761000000000 }
  ]
}
```

`feed` 与 `channel` 从安装目录的 `app-update.yml` 读出来——**不硬编码 URL 与版本**，换版本、换通道、换机器自动成立。
`patches` 是「故意改动」的白名单：有了它，校验才能只报出补丁之外的变化。

## 两层知识

| 层 | 位置 | 内容 | 来源 |
|---|---|---|---|
| **内置经验** | `data/knowledge.base.json`（随仓库） | 名字模式、目录角色、宿主机制名单、通用判据 | 多个终端审计沉淀后脱敏 |
| **本机判例** | `<state>/known.json` | 具体路径 → 分类 + 理由 + 时间 | 你的每一次裁决 |

内置经验**不含任何具体路径**，否则换机器就失效。本机判例**不含任何推断**，只记录人做过的决定。

```json
{
  "schema": 1,
  "owners": {
    "guardian": { "owner": "host", "class": "KEEP",
                  "note": "宿主启动名册预检缓存，仍在写入" }
  },
  "judged": {
    "dsh-config-manager/rollback-points/index.v2.backup.json": {
      "class": "RESIDUE", "tier": "A",
      "reason": "现役 index.json 更晚，此为 10-15 陈旧全量快照",
      "at": 1761574800000
    }
  },
  "counters": { "scans": 12, "lastScan": 1761574800000 }
}
```

合并规则：

1. `judged` 命中即用，不问第二次
2. 未命中则查 `knowledge.base` 的 `owners` 与 `patterns`
3. 再未命中走 `rules.json` 的结构判据
4. 全不中 → UNKNOWN

路径消失的判例不删除，90 天后标 `stale`——防止「删了又装回来」时重新问一遍。

## 经验回流

`export-learning` 产出一份可提交的片段：

```json
{
  "schema": 1,
  "exportedAt": 1761574800000,
  "patterns": [
    { "match": "dsh-*-provider-*", "role": "plugin", "class": "KEEP" },
    { "match": "*.bak-*", "role": "backup", "class": "RESIDUE", "tier": "A" }
  ],
  "hostOwned": ["guardian", "dsh-runtimes", "tool-management"]
}
```

脱敏规则：去掉盘符、用户名、时间戳、版本号，只留**模式**。这样别人提 PR 不会泄露自己的目录结构。

## schema 版本与迁移

- 每个状态文件带整型 `schema`
- 读到低于当前版本 → 走 `migrations/` 下的升级函数，升级前备份为 `*.schema<N>.bak`
- 读到高于当前版本 → 拒绝运行并提示升级工具，**不尝试解析**

## 损坏处理

JSON 解析失败时：

1. 原文件重命名为 `<name>.corrupt-<ts>`
2. 重建空骨架（`roots.json` 会触发一次重新发现）
3. 在报告顶部标注「状态曾损坏并重建」

绝不静默丢弃，也不因单个文件坏掉而整体失败。

## 隐私

状态文件含本机绝对路径与用户名。因此：

- 默认位于 `%LOCALAPPDATA%`，不进仓库（`.gitignore` 兜底）
- `report.md` 中把 `%USERPROFILE%` 替换为 `~`
- `export-learning` 强制脱敏，且不含文件内容
