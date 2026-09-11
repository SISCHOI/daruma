# 最新 deepseek-harness（0.1.5-rc.2）实测：daruma 0.1.6 使用与兼容性 / 沙箱升级缺陷 / escalation 插件

- 日期：2026-09-11
- 被测宿主：`@deepseek-ai/dsh@0.1.5-rc.2`（npm dist-tag `next`；`latest` = `0.1.5-rc.1`；上游 tag 至 `dsh-v0.1.5-rc.2`）
- 被测插件：`dsh-daruma` / `daruma-core` 0.1.6（仓库 `main` @ `63b21da`，`lib/` 已构建）
- 隔离实验室：`C:\Users\shanzhiyu\code\daruma\.dsh-lab\`（仓库内、已 gitignore；独立 `DSH_HOME`，独立 npm cache / profile / sessions，未触碰生产 `~/.dsh` 与 3080 实例）
- 结论：**T1 缺陷仍在；T2 插件在最新版不可用（fail-loud）；T3 daruma 核心链路可用，但宿主 RPC（面板数据通路）在最新版不注册**

## 0. 环境对照

| 项 | 值 | 证据 |
|---|---|---|
| 最新宿主（本次实测） | `@deepseek-ai/dsh` 0.1.5-rc.2，in-box 组件全部 0.1.5-rc.2（dsh-agent/llm/session/sandbox/tools/user-approval/base/headless/permission-presets） | `.dsh-lab/install/node_modules/@deepseek-ai/*/package.json` |
| 生产宿主（未改动） | CLI `0.1.0-rc.6` + 组件 `0.1.0-rc.7`，3080 由 PID 24476 服务于 2026-09-10 15:25 启动 | `nodejs\node_modules\@deepseek-ai\dsh\package.json`、`netstat -ano` |
| 上游最新 | npm `next=0.1.5-rc.2`、`latest=0.1.5-rc.1`、`alpha=0.1.5-alpha.2`；git tag 至 `dsh-v0.1.5-rc.2` | `npm view @deepseek-ai/dsh` / `git ls-remote --tags` |

实验室装配方式（与生产 profile 同构）：`package.json` 的 `dsh.profile.bundles` 声明 bundle 层，`cordis.patch.yml` 叠加 settings 与插件配置，插件以 junction 挂入 profile 的 `node_modules`。宿主自身依赖由 `.dsh-lab/install` 提供，故 profile 无需 pnpm 安装。

## 1. T1：沙箱升级缺陷在最新版**仍然存在**（实测，非推断）

复现：`DSH_PERMISSION_MODE=danger-full-access`（该版本由 `dsh-sandbox-policy`/`dsh-user-approval` 的 `!!js` 表达式读取，直接决定会话有效模式与审批策略），mock LLM 让模型发出带同级 `sandbox_permissions` 的 `pwsh` 工具调用。

实测结果：

```
tool/call  seq=15  name=pwsh  arguments={"command":"Write-Output T1-TOOL-RAN", ... ,
                    "sandbox_permissions":"danger-full-access",
                    "justification":"T1 repro: redundant same-level sandbox escalation probe"}
tool/result seq=16 isError=true
  Error: sandbox escalation to "danger-full-access" is not strictly wider than
  this call's current "danger-full-access" mode
```

命令未执行，模型侧判定 `ESCALATION-REJECTED`。同时该版本 `pwsh` 工具 schema **仍无条件暴露** `sandbox_permissions`（枚举 `workspace-write` / `danger-full-access`）与 `justification`——即上次"上游还没修"的判断在最新版上成立，但直到本次才完成运行时实测。

- 证据：`raw/T1-session-escalation-reject.jsonl.zstd`（seq 15/16）、mock 侧日志（见 §4 命令）
- 影响：`approval=never` 或 All Access 会话中，习惯填该字段的第三方模型会持续"报错→换参数→再报错"

## 2. T2：`dsh-sandbox-escalation-fix` 在最新版**直接拒绝加载**

按生产同样方式装配（插件包复制进 profile `node_modules`，8 个受检包 junction 到 0.1.5-rc.2），启动即 fail-loud：

```
dsh: failed to apply loader entry sandbox-escalation-fix (dsh-sandbox-escalation-fix):
  dsh-sandbox-escalation-fix: unsupported DSH version "0.1.5-rc.2";
  supported versions: 0.1.0-rc.5, 0.1.0-rc.6, 0.1.0-rc.7, 0.1.0-rc.8,
  0.1.1-rc.1, 0.1.1-rc.2, 0.1.2-alpha.1 … 0.1.2-rc.1, 0.1.3-alpha.1,
  0.1.3-alpha.2, 0.1.5-alpha.1, 0.1.5-alpha.2
Error: dsh: plugin tree failed to load: failed to apply loader entry sandbox-escalation-fix
```

- 插件版本 `0.1.5-alpha2-win-linux`，`SUPPORTED_DSH_VERSIONS` 与 `peerDependencies` 都止于 `0.1.5-alpha.2`，不含任何一个 rc 版
- 行为是**崩溃**而非静默降级：整个 profile 起不来（exit≠0）
- 影响：T1 的缺陷仍在，而目前唯一的社区绕过手段在最 rc 版本上不可用

## 3. T3：daruma 0.1.6 在最新版上的使用与兼容性

### 3.1 通过（核心故障转移链路）

| 检查 | 结果 | 证据 |
|---|---|---|
| headless failover e2e | `mock-a` 429 → 切 `mock-b` → 输出 `mock completion from mock-b`，exit 0 | mock 日志；`raw/T3-daruma-failover-log.jsonl` |
| 持久化决策日志 | `boot` + `failover`（`from mock::mock-a`、`to mock::mock-b`、`reason RATE_LIMIT`、`turn/step/failoverCount`） | 同上 |
| 健康状态与成功复位 | `mock::mock-a = COOLDOWN`（1 次失败，budget 1）、`mock::mock-b = HEALTHY`（`agent/turn-stopping` 推断成功生效） | `raw/T3-daruma-channel-health.json` |
| 会话事件（0.1.6 新增 event-sink） | session v3 日志含 `daruma/failover`（seq 15）完整载荷 → `agent.session.append` 在新宿主可用**且被持久化** | `raw/T3-session-daruma-failover.jsonl.zstd` |
| 客户端模块注册 | web profile 页面的模块清单含 `dsh-daruma/client.js`，`inject` 指向 `dsh-client-connection` 等 | `raw/T3-web-boot.txt` + 下方便是页面清单原文 |

页面模块清单原文（`GET /?token=…` 返回的 HTML 内嵌清单，节选）：

```
…dsh-client-file-upload/client.js,@deepseek-ai/dsh-api-remotes/client.js,
@deepseek-ai/dsh-client-ui-deliverables/client.js,dsh-daruma/client.js,
@deepseek-ai/dsh-typert-registry/client.js,…
{"id":"dsh-daruma","url":"/plugins/??dsh-daruma/client.js&rev=752c5fdbb13b75a3-48",
 "rev":"752c5fdbb13b75a3-48","inject":["@deepseek-ai/dsh-client-connection", …]}
```

### 3.2 不通过（宿主 RPC 通道未注册 → 面板/备用选择器数据通路失效）

路由探针（同一请求，两种宿主对照）：

| 宿主 | `POST /dsh-daruma/status` | `POST /api` |
|---|---|---|
| 生产 3080（rc.6 CLI + rc.7 组件） | **200**（返回 `server-response` 信封 → 通道已注册） | 404（该版本共享通道语义） |
| 最新 3083（0.1.5-rc.2） | **405**（未匹配任何路由 → 落到 SPA 兜底） | 401（`connection` 插件已加载并持有 `/api`） |

即：**同一 daruma 0.1.6 代码，在旧宿主注册了 RPC，在最新宿主没有注册**；而 `connection` 服务本身在最新宿主是活的（`/api` 401 可证），所以不是服务缺失，而是**时序**问题。

### 3.3 根因（实测证据，非猜测）

实验室探针插件（`.dsh-lab/probe-plugin`，仅记录时序、不改宿主）在 web profile 中记录到：

```jsonl
{"phase":"apply","hasConnection":false,"t":1789096556365}
{"phase":"inject-connection","hasConnection":true,"t":1789096560789}
```

`ctx.get('connection')` 在 **apply 阶段为 false**，在 `ctx.inject(['connection'])` 触发时（约 4.4 秒后）为 true。源码对照解释了差异：

- rc.7（生产）：`dsh-client-connection` 的 `function apply(ctx, config)` 是**同步**的，`new HostConnectionService(...)` 立即执行 → 兄弟插件 apply 时服务已在
- 0.1.5-rc.2（最新）：`async function apply(ctx, config)` 且 `new HostConnectionService(ctx, trustedHosts, await BrowserAuth.create(...))` → 服务在 await 之后才提供
- daruma 0.1.6 的 `mountRpc()` 在 `apply()` 里**同步** `ctx.get('connection')`，取不到即 `return`（原意是 headless 分支）→ 通道静默不注册
- 0.1.6 新增的 `detectHostCapabilities()` 会把 `rpc:false` 记入 info 日志，但用户侧只表现为面板/备用选择器无数据

附带语义变化：rc.2 的 `rpc.handle(channel, handler)` 已不再接受第三个 options 参数，daruma 传入的 `{authority:'loopback'}` 被忽略（无害，loopback + 浏览器鉴权由 rc.2 的 `requestRejection` 统一兜底）。

### 3.3b 惰性挂载修复后：仍有第二个上游缺陷挡住 0.1.5-*

把 `mountRpc` 改为从 `ctx.inject(['connection'], …)` 挂载后重测（分支 `test/latest-harness-compat`，实现于 `packages/dsh-daruma/src/host-mount.ts` + `src/rpc.ts`），矩阵结果：

| 宿主 | `POST /dsh-daruma/status` | headless failover e2e |
|---|---|---|
| 0.1.0-rc.7（= 生产那一代） | **HTTP 200**，返回真实状态载荷（`{"ok":true,"value":{"current":null,"backup":null,"channels":[{"channel":"mock::mock-a",…`） | PASS |
| 0.1.5-rc.1 | HTTP 405（路由未注册） | PASS |
| 0.1.5-rc.2 | HTTP 405（路由未注册） | PASS |

证据：`raw/S-matrix-summary.txt`（脚本 `.dsh-lab/matrix.ps1`）。

探针进一步定位（`raw/S-rpc-registration-probe.jsonl`）：

```jsonl
{"phase":"direct-route-ok", …}
{"phase":"rpc-handle-error","message":"cannot get property \"webServer\" without inject"}
```

- `connection.rpc.handle('/dsh-daruma', …)` 在 0.1.5-rc.1/rc.2 上对**任何调用方**都抛 `cannot get property "webServer" without inject`：该版本的 `dsh-client-connection` 把 `webServer` 从插件级 `inject` 中去掉（改为在内部 `ctx.inject(['webServer'], …)` 里挂 `/api` 路由），而 `rpc.handle() → register()` 仍通过服务自身 ctx 取 `owner.webServer` 注册路由 → 必然失败。调用方额外注入 `webServer` 也无济于事（已实测）。
- 直接在注入到的 `webServer` 上注册路由**可行**（探针 `POST /lab-direct/status` → 200），这正是 in-box `dsh-api-gateway` 在 rc.2 采用的写法。代价：该自建路由不经过宿主浏览器令牌/权威校验（`requestRejection` 只作用于 connection 自己注册的路由），等于把面板 RPC 暴露给本机任意进程（loopback-only）——安全权衡，需显式决策。

### 3.3c 静态版本扫描：两个边界，以及比"最新版"更大的影响面

用 `npm pack @deepseek-ai/dsh-client-connection@<ver>` 取各版本源码做静态判定（脚本 `.dsh-lab/sweep.ps1`，结果 `raw/S-version-sweep.txt`）：

| 版本 | 插件级 inject | apply 是否 async | `rpc.handle` |
|---|---|---|---|
| 0.1.0-rc.7 / rc.8 | `["webServer"]` | 否 | OK |
| 0.1.1-rc.1 / rc.2 | `["webServer"]` | 否 | OK |
| 0.1.2-alpha.2 / alpha.5 / 0.1.2-rc.1 / 0.1.3-alpha.2 | `["webServer","credentials"]` | **是** | OK |
| 0.1.5-alpha.1 / alpha.2 / 0.1.5-rc.1 / rc.2 | `["credentials"]` | **是** | **BROKEN** |

（`0.1.3-alpha.1` 的 tarball 拉取失败，未纳入；其余在 peer 范围内的版本全覆盖。）

两个边界由此确定：

1. **服务延迟提供自 0.1.2-alpha.2 起** → 同步 `ctx.get('connection')` 的旧写法从那一代起就让面板失效；`peerDependencies` 声明的 `>=0.1.0-rc.7 <0.1.6` 覆盖的 0.1.2-* / 0.1.3-* / 0.1.5-* 区间里，面板从来不是"实测可用"状态（本次首次实测证实）。
2. **`rpc.handle` 自 0.1.5-alpha.1 起不可用** → 即便修好惰性挂载，0.1.5-* 上的面板仍需宿主修复（或采用上面的无鉴权自建路由方案）。

### 3.4 建议修复

1. **daruma（已实现）**：`mountRpc` 改为惰性挂载——`ctx.inject(['connection'], (c) => mountRpc(c, deps))`，注册失败时**大声 warn** 而非静默；`detectHostCapabilities` 在注入后取值，避免把"还没提供"误报成"宿主不支持"。修复覆盖 0.1.2-alpha.2 → 0.1.5-rc.2 全线的挂载路径，且不回归 rc.7（面板 200 实测）
2. **上游（必须）**：`0.1.5-alpha.1` 起 `dsh-client-connection` 的插件级 `inject` 去掉了 `webServer`，而 `register()` 仍用服务 ctx 取 `owner.webServer` → `connection.rpc.handle()` 对所有第三方插件不可用。修复二选一：恢复插件级 `webServer` 注入，或让 `register()` 在自身 `ctx.inject(['webServer'], …)` 作用域内注册路由
3. **escalation 插件**：把 `0.1.5-rc.1`/`0.1.5-rc.2`（及后续 rc）加入 `SUPPORTED_DSH_VERSIONS` 与 peer 范围；当前最新宿主上它是 fail-loud 不可用
4. **上游**：T1 表明工具 schema 仍需按会话有效模式投影（会话已是 `danger-full-access` 时不应再向模型暴露同级升级字段）
5. **README / peer 范围（待定）**：failover 可用性与面板可用性不是同一个版本范围，当前 peerDependencies 把两者混在一起声明

## 4. 复现命令

```powershell
$lab = 'C:\Users\shanzhiyu\code\daruma\.dsh-lab'
$dsh = "$lab\install\node_modules\@deepseek-ai\dsh\lib\bin.js"
$env:DSH_HOME = "$lab\home"; $env:MOCK_API_KEY = 'dummy'

# T3 故障转移 e2e（先起 mock：node scripts\mock-llm-server.mjs 3099）
node $dsh --profile daruma-latest "Reply with exactly: OK"

# T1 沙箱升级缺陷复现（mock：node .dsh-lab\mock-escalation.mjs 3097）
$env:DSH_PERMISSION_MODE = 'danger-full-access'
node $dsh --profile escalate-latest "T1 probe"

# T2 escalation 插件在最新版上 fail-loud
node $dsh --profile escalate-plugin-latest "T2 probe"

# web 面 + RPC 路由探针
node $dsh --profile web-latest --no-open --port 3083
# 再对 http://127.0.0.1:3083/dsh-daruma/status 发 POST（需先 GET /?token=... 换 cookie）

# 多版本矩阵（RPC 路由 + headless failover，逐版本建独立 DSH_HOME）
powershell -ExecutionPolicy Bypass -File .dsh-lab\matrix.ps1 -Versions 010rc7,015rc1,015rc2
# 各版本 client-connection 静态扫描（npm pack）
powershell -ExecutionPolicy Bypass -File .dsh-lab\sweep.ps1
```

原始证据：`raw/`（会话归档、failover log、健康状态、探针时序、矩阵/扫描汇总、web 启动日志）。

## 5. 局限与未覆盖

- 未做浏览器端 UI 端到端（无浏览器自动化驱动）：RPC 结论来自路由探针 + 服务时序探针 + 客户端模块清单三路互证，不是面板点击
- 运行时矩阵覆盖 `0.1.0-rc.7`、`0.1.5-rc.1`、`0.1.5-rc.2` 三档；其余版本（0.1.2-* / 0.1.3-*）只做了静态扫描。`0.1.3-alpha.2` 在本机装不上（依赖 `fs-ext` 需 node-gyp 原生构建），`0.1.3-alpha.1` 的 tarball 拉取失败
- 生产 3080 实例与 `~/.dsh` 全程只读未改；T3.2 的对照请求是对生产的一次匿名 POST 探针
- 沙箱升级缺陷的另一半（子代理 approval 恒为 `never` 的叠加因素）本次未复测
- 修复合入后需要重跑一次 rc.7 的**面板**人工确认（本机 3080 重启后），路由探针只能证明通道已注册
