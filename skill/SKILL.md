---
name: dsh-clean
description: 清点 DeepSeek Harness 桌面端在本机的全部文件夹占用，找出卸载残留、冗余文件，以及与安装包不一致的改动。当用户提到「DSH 不干净 / 有残留 / 卸载插件没卸干净 / 占了多少空间 / 客户端有没有被改过 / 清理 DSH」时使用。默认只读；用户明确要清理时才用 review/apply，删除一律进回收站。
---

# DSH-clean

一次调用拿到结论，**不要**自己遍历磁盘、不要用 glob/grep 去找残留。

## 执行

```
{{DSH_CLEAN_CMD}} scan --agent
```

一次就够。读它输出的第一行（结论）和最后一行（`REPORT <路径>`）。

**这一步只花几百 token，不要去改命令行**：

- 就按上面这行原样跑，**不要**用 `cmd /c`、`cmd //c`、`powershell -File …dsh-clean.cmd` 再包一层 —— 包了之后进程会静默不执行、输出全空（exit 0 假成功），白跑一次模型调用。
- 参数只有 `scan --agent`。不要加 `--json`（那是整包 JSON，几万 token）。
- 只有用户追问某一块细节时，才跑第二条：
  ```
  {{DSH_CLEAN_CMD}} scan --section=residue
  ```
  可用段名：`residue` 残留 / `plugins` 插件包 / `sessions` 会话 / `folders` 相关文件夹 / `purity` 纯净度 / `top` 顶层目录 / `unknown` 未归类 / `patches` 已知改动。跑一次 `--section` 只会多花一两百 token；`--json` 或整份 report.md 是几千到几万。

**汇报必须给文件卡，不是文字链接**。每次扫描汇报都要调用 `present`，把 `report.md` 交出去（`description` 写一句「最近一次扫描的完整报告」）：

    present({ files: [{ path: "<REPORT 那行的路径>", description: "最近一次扫描的完整报告" }] })

用户明确说过：**Markdown 链接点不开、他不喜欢**，只有文件卡才行。所以：

- 不要只贴一行链接就完事 —— 那等于没给。
- 路径照抄扫描输出 `REPORT` 那一行，不要自己拼。
- `present` 真的不可用时，才退回到尖括号包裹的链接（路径含空格必须包，否则只认空格前那截）：

    [打开完整报告：report.md](<D:\DeepSeek Harness\DSH-GitWorkspace\DSH-clean\Temp\dsh-clean\reports\20261028-122013\report.md>)

**不要**主动把 report.md 整份读进上下文（约 13KB ≈ 4k token）—— 用户追问哪块就用上面那条 `--section=`。

## 怎么汇报

- 用中文，用 Windows 的说法：路径保留反斜杠，体积用 GB/MB。
- 先一句话结论（干净 / 有 N 处残留 / 有 N 处要你确认），再最多列 3 条细节。
- 每条讲三件事：它像什么、为什么可疑、动了会怎样。
- 超过 3 条只报总数，问用户要不要看完整清单。

## purity

- `purity=0` 表示客户端与安装时一致；大于 0 说明有文件被改过，需要打开报告里的「纯净度」段解释清楚。
- `plugins=包数/问题数`：问题数含被改文件、多余备份、孤儿包、版本不符。用户问「插件被改过没」时看这一项。
- 安装目录上极少数偏离（< 0.5%）通常是安装包自带的静态文件，不要当成篡改来吓唬用户。
- `patch=在位/异常`：用户自己认可的手工改动。异常数 > 0 时说明「补丁被升级或重装覆盖了」，提醒他重打，不要当成篡改。

## 校验（客户端 vs 安装包，只有用户要求才跑）

用户问「客户端有没有被动过 / 和我们官方安装包对不对得上」时才跑 `verify`。平时 scan 自带基线的 mtime+大小闸门，已经够回答大部分「被改过没」。

```
{{DSH_CLEAN_CMD}} verify --agent
{{DSH_CLEAN_CMD}} verify --upstream=<手动解压的安装包目录>   # 最稳，不 spawn 外部进程
{{DSH_CLEAN_CMD}} verify --installer=<官方安装包.exe>        # 自动 7-Zip 解包，需宽松沙箱
```

读 `INTEGRITY dsh=… baseline=… upstream=…` 那行：`baseline=ok` 说明时间大小全对上、没读盘；`upstream=same N` 说明与官方安装包一致 N 个文件。差异里「只在本机」的 `7zip-installer-*` 与 `Uninstall *.exe` 是合法安装产物，不是篡改。

## probe（已知根之外还漏了谁）

- `probe=+新找到/疑似`：`+` 后面是有证据、已经纳入扫描的目录数（例如插件把数据写在 `~/.mnemon` 这种名字里不带 dsh 的地方）；`/` 后面是有弱线索、只列在报告里的疑似目录数。
- 有证据的判据只有三种：目录里有 `cordis.yml` / `.dsh` / `app.asar`；已装插件的代码里点名了这个目录；目录名与某个已装插件同名。
- 疑似数 > 0 时，把疑似目录的名字念给用户听（最多 3 个），问「这些要不要算进来」。他确认了就 `judge` 记进判例库，下次不再问。

## unknown 与 residue

- `unknown=N`：有 N 个顶层目录无法归属。**逐条**用一句话问用户「X 是什么、还要不要」，不要一次列十个。
- 用户的回答就是最终裁决，落盘成判例（否则下次还会问）：

  ```
  {{DSH_CLEAN_CMD}} judge <编号或路径> --as=KEEP|CACHE|RESIDUE --note="用户的原话"
  ```

  - `KEEP` 保留别动 / `CACHE` 是缓存 / `RESIDUE` 确认可清（会直接进清理清单）/ `UNKNOWN` 先不下结论。
  - 编号直接用 review 里那个；路径要绝对路径。判错了用 `unjudge <编号或路径>` 撤销。
- `locked=N`：这些项扫描时正在被写入（下载中 / 插件正在写），这次跳过不判，**不要**把它们当残留，也不要说「下次一定清」。如实说「有 N 项正在使用，这轮没判」。
- 判例库对用户最大的价值是「不再重复问」。同一类东西判过一次之后，报告里 `known=N` 会涨，`unknown` 会降。
- `residue=N` 只是判定结果。**用户没说「清掉 / 删掉 / 收拾一下」就不要主动清理**，也不要用 rm/del 自己动手 —— 只有一个通道：下面的 review / apply。

## 导出判例（只在用户想把经验贡献出去时）

```
{{DSH_CLEAN_CMD}} export-learning --out=<保存到哪.json>
```

导出的内容只有「名字模式 + 判定 + 原因」，不含绝对路径和用户名，可以直接提 PR。判例库是空的时候会直接说明。

## 清理（只有用户明确说要清的时候）

1. 先列清单，不要直接删：

   ```
   {{DSH_CLEAN_CMD}} review
   ```

   输出是带编号的表（编号 / 档位 / 体积 / 理由 / 路径），一屏几百 token。

2. 用中文问「要清哪几项」，**A 档和 B 档分开说**：A 档是明确残留（备份、0 字节半成品），B 档多半是没用的安装包但要用户点头。一次问清，别逐项来回。

3. 只按用户给过的编号执行，**不要自作主张扩大范围**：

   ```
   {{DSH_CLEAN_CMD}} apply --ids=1,3 --yes
   ```

   - 这一步必须带 `sandbox_permissions=danger-full-access`（要从 Node 启 PowerShell 删东西）。**没有放宽沙箱时工具会报「没删成 … EPERM」，那不是失败信息，是让你换权限重跑。**
   - 退出码：`0` 全部进箱 / `2` 有项没进箱 / `3` 沙箱挡着 / `4` 回收站不可写（未删任何东西）。
   - 结果里每项要么「已进回收站 #N → $RXXXXXX」，要么「失败 [PERMANENT-DELETE]」—— 后者要立刻告诉用户「这项没进回收站」，不要含糊过去。

4. 汇报三句话：清了几项、腾出多少空间、**回收站里可以还原**。再补一句台账位置（`<state>\apply-log.jsonl`）。

绝不要用 `rm` / `del` / `Remove-Item` 代替 apply：那会永久删除，回收站里找不回来。

## 收尾（看到 reports=N/prune 就直接做，不用问）

`scan` 每跑一次攒一份报告，攒多了 `--agent` 行尾会出现 `reports=N/prune`。**看到这个标记就直接跑，不要问用户、也不要先 `--dry-run`**：

```
{{DSH_CLEAN_CMD}} prune --agent
```

它会：

- 历史报告只留最近 10 份（`--keep=N` 可改），其余进回收站
- 旧状态文件（`%LOCALAPPDATA%\dsh-clean` 下的 roots / patches / probe-cache / last-run / sizes / inventory / reports 等）先补到新状态目录、确认没丢，再收走

全部进回收站、可还原，属于例行维护，不需要用户批准。汇报时一句话带过即可（「顺手收走了 N 份旧报告」）。`PRUNE … ok=1` 说明成功；退出码 4 才是没做成。

## 边界

- 扫描阶段不修改、不移动、不删除任何文件，也不读文件内容（只统计大小与时间）。
- 清理只走 `apply`（进回收站）；不要用 rm/del/Remove-Item 自己删，也不要在工具外手工搬文件。
- 用户没要求时不要重复扫描。
- 退出码不是失败：`1` = 有残留、`2` = 有未归类项等你确认、`0` = 干净；只有 `3` 才是真出错（那时 stderr 里有一句「运行失败：…」）。别因为看到 1 就重跑或换命令。
- 状态与报告默认都在工作区 `Temp\dsh-clean\` 下，不需要放宽沙箱；只有 install / uninstall 会写 `%LOCALAPPDATA%\dsh-clean`，那两步才可能需要放宽。
- 若命令报「找不到 Node 运行时」，说明 DSH 安装目录异常，先把这条告诉用户，不要尝试自己修。

## 用户自己改过的东西

被改的文件如果是用户自己改的（他认可的补丁），跑一次 accept 记下来：

    {{DSH_CLEAN_CMD}} accept "<文件路径>" --note="改了什么"

之后它不再算脏。哪天插件升级把文件覆盖回 pnpm 原件，第一行会出现 patch=0/1 和 PATCH-LOST —— 这时提醒用户「补丁被升级覆盖了，要重打」。
