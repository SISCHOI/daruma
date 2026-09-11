# 实测：`dsh-sandbox-escalation-fix` 的修复在 0.1.5-rc.2 上**有效**，只是被版本白名单挡住

> **更正（同日追加，见 §6）**：上游 `main` 其实**已经**支持 `0.1.5-rc.1`/`0.1.5-rc.2`（提交 `3e6a394` 2026-09-10 17:19、`a59a7d2` 2026-09-11 00:03），本机看到的"白名单不含 rc"是 **2026-09-10 15:15 从 GitHub HEAD 安装的旧快照**（`0.1.5-alpha2-win-linux`）。因此原标题的"白名单挡住"只对**那个安装快照**成立，不是上游现状；用上游最新代码复测已通过（§6）。下面 §1-§5 保留当时的实验记录。

- 日期：2026-09-11
- 被测宿主：`@deepseek-ai/dsh@0.1.5-rc.2`（in-box 组件同为 0.1.5-rc.2）
- 被测插件：`dsh-sandbox-escalation-fix@0.1.5-alpha2-win-linux`（本机快照）
- 相关证据：`2026-09-11-latest-harness-compat.md`（T1 缺陷在最新宿主仍存在；T2 插件在最新宿主 fail-loud）
- 结论：**插件逻辑对新宿主有效**——把它的版本白名单临时加上 `0.1.5-rc.1` / `0.1.5-rc.2` 后，同一个"同级 `sandbox_permissions`"探针从**被拒**变成**真的执行**，且工具 schema 不再向模型暴露该字段。

## 1. 实验设置

实验室 profile `.dsh-lab/home/profiles/escalate-plugin-latest`（与生产同构：插件包 + 8 个受检包 junction 到 0.1.5-rc.2），设置 `DSH_PERMISSION_MODE=danger-full-access`（该版本由 `dsh-sandbox-policy`/`dsh-user-approval` 的 `!!js` 表达式读取，直接决定会话有效模式与审批策略），mock 让模型发出带同级 `sandbox_permissions` 的 `pwsh` 调用。

唯一改动：在实验室副本 `…/node_modules/dsh-sandbox-escalation-fix/lib/index.mjs` 的 `SUPPORTED_DSH_VERSIONS` 数组中追加两行（原文件另存 `.orig`）：

```js
	"0.1.5-alpha.2",
	"0.1.5-rc.1",
	"0.1.5-rc.2"
```

## 2. 结果对照（同一探针、同一宿主）

| 条件 | 工具结果 | `pwsh` schema 是否含 `sandbox_permissions` |
|---|---|---|
| 无插件（宿主原生） | `Error: sandbox escalation to "danger-full-access" is not strictly wider than this call's current "danger-full-access" mode`，`isError: true`，**命令未执行** | **含**（枚举 `workspace-write` / `danger-full-access`） |
| 插件生效（白名单已放宽） | `T1-TOOL-RAN`，`isError: false`，**命令真的执行了** | **不含**（只剩 `command` / `description` / `timeoutMs` / `workdir` / `run_in_background`） |

证据：
- `raw/session-with-plugin-whitelist-patched.jsonl.zstd` — 会话归档：`tool/result` seq 16 内容为 `"T1-TOOL-RAN\r\n"` 且 `isError:false`；`request/header` 里的 `pwsh` 工具定义不含升级字段
- `raw/pwsh-tool-schema-with-plugin.txt` — 从该会话 header 提取的 `pwsh` schema 原文
- `raw/mock-escalation-server.txt` — mock 侧日志：`[t1] tool result seen: "T1-TOOL-RAN\r\n"`
- 对照（无插件）见 `2026-09-11-latest-harness-compat.md` 的 T1 与 `raw/T1-session-escalation-reject.jsonl.zstd`

## 3. 复现命令

```powershell
$lab = 'C:\Users\shanzhiyu\code\daruma\.dsh-lab'
# 1) 白名单补两行（仅实验室副本）
#    …\dsh-sandbox-escalation-fix\lib\index.mjs 的 SUPPORTED_DSH_VERSIONS 追加 "0.1.5-rc.1" / "0.1.5-rc.2"
# 2) 起探针 mock
node .dsh-lab\mock-escalation.mjs 3097
# 3) 跑会话
$env:DSH_HOME = "$lab\home"; $env:MOCK_API_KEY = 'dummy'; $env:DSH_PERMISSION_MODE = 'danger-full-access'
node "$lab\install\node_modules\@deepseek-ai\dsh\lib\bin.js" --profile escalate-plugin-latest "T1 with plugin"
# 预期输出：T1-DONE tool outcome: TOOL-ACCEPTED
```

## 4. 影响与建议

1. **插件作者**（`HakureiMonika/dsh-sandbox-escalation-fix`）：把 `0.1.5-rc.1` / `0.1.5-rc.2`（以及后续 rc）加入 `SUPPORTED_DSH_VERSIONS` 与 `peerDependencies`，即可以让插件覆盖当前最新宿主——实现层已验证可用，无需其他改动。当前行为是 fail-loud（整个 profile 起不来），风险是用户误以为插件坏了。
2. **daruma / 其他第三方插件**：这条只解决"升级字段"这一半；`connection.rpc.handle()` 在 0.1.5-* 上仍然对任何第三方插件抛 `cannot get property "webServer" without inject`（见 `2026-09-11-latest-harness-compat.md` §3.3b/c），面板类功能仍需宿主修复。
3. **上游**：根治仍然是让工具 schema 按会话有效模式投影（会话已是 `danger-full-access` 时不再暴露同级升级字段），并修 `rpc.handle()` 的服务上下文依赖。

## 5. 局限

- §1-§4 的实验改过实验室副本的白名单；`index.mjs.orig` 保留原文件，正式环境未做任何修改
- 只验证了"同级冗余升级"这一条路径；插件的其他兜底路径（如跨级升级请求）未逐个复测
- 只测 `0.1.5-rc.2`，`0.1.5-rc.1` 未单独复测（两者 `dsh-client-connection` 同代，推测一致）

## 6. 更正 + 上游最新代码复测（同日追加）

### 6.1 事实核对

| 项 | 事实 |
|---|---|
| 上游 `main` 是否支持 rc | **支持**：`3e6a394 chore: support DSH 0.1.5-rc.1`（2026-09-10 17:19）、`a59a7d2 chore: support DSH 0.1.5-rc.2`（2026-09-11 00:03）；`src/compatibility.ts` 与提交进仓的 `lib/index.mjs` 都含 `"0.1.5-rc.1"`/`"0.1.5-rc.2"`，`package.json` 的 peer 范围也已包含 |
| 本机安装的插件 | `dsh-sandbox-escalation-fix@0.1.5-alpha2-win-linux`，白名单里 rc 条目数 **0** —— 它是 **2026-09-10 15:15** 通过 `dsh plugin add github:HakureiMonika/dsh-sandbox-escalation-fix` 装下的**当时 HEAD 快照**，早于上游那两个提交 |
| 结论修正 | "被白名单挡住"只对**本机这个旧快照**成立；上游并不缺 rc 支持。原先据此给上游开的 issue（HakureiMonika/dsh-sandbox-escalation-fix#14）属于**误报**，已更正并关闭 |

### 6.2 用上游最新代码复测（0.1.5-rc.2）

把实验室 profile 里的插件目录换成上游 `main`（`a59a7d2`）提交进仓的 `lib/` + `package.json`（**未做任何白名单修改**），同一探针、同一宿主：

```
T1-DONE tool outcome: TOOL-ACCEPTED      # 命令真的执行
pwsh schema 暴露 sandbox_permissions: false
```

证据：`raw/upstream-latest/session-upstream-plugin.jsonl.zstd`（`tool/result` = `"T1-TOOL-RAN\r\n"`，`isError:false`）、`raw/upstream-latest/pwsh-tool-schema.txt`（1049 字节，无升级字段）、`raw/upstream-latest/mock-escalation-server.txt`。

### 6.3 对本机的处置建议

1. **刷新插件安装**：`dsh plugin --profile web add github:HakureiMonika/dsh-sandbox-escalation-fix`（重新解析 HEAD）即可拿到 rc 支持；装完重启 DSH 生效。
2. **按上游 README 的建议锁定 SHA**：`github:HakureiMonika/dsh-sandbox-escalation-fix#<sha>`，避免再次出现"装的是旧快照、行为与上游文档不一致"的情况——本次误判的根因就是这个。
3. **对 daruma 的教训**：以后对第三方依赖做兼容性判断前，先核对**本地安装快照的版本/提交**，而不是拿上游仓库现状反推；本次 §1-§4 的结论若不做这一步，就会把"安装过期"错报成"上游缺支持"。
