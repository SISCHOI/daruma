# Daruma — Research & Architecture

> 调研与架构决策记录。2026-08-26。

## 1. 问题

第三方订阅 API 不稳定（`429`/`500`/网络波动/模型抽风/风控审核）导致长任务非人为中断。诉求：检测「任务未执行 / 非人为中断」，自动让会话继续，或切换模型/渠道继续。目标宿主：DeepSeek Harness (DSH)。

## 2. DSH 机制调研

DSH 的插件是 **Cordis 插件**：一个 ESM npm 包，`package.json` 声明
`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，导出 `apply(ctx, config)`。
`dsh plugin add` 把它装进 profile，reconcile 时把声明了 `dsh.bundle` 的依赖加入 layer stack。

与本需求直接相关的官方扩展点（`@deepseek-ai/dsh-agent` / `@deepseek-ai/dsh-llm`）：

| 扩展点 | 类型 | 作用 |
|---|---|---|
| `agent/request-error` | waterfall | payload 含 `{ agent, turn, step, provider, failure{code,status}, retryPolicy, signal }`；返回 `{ kind: 'retry' }` 且不调 `next()` 即「接管恢复」 |
| `agent/request` | waterfall | `await next()` 得 `LlmCallConfig { provider, model, ... }`；**返回替换对象即换 provider/model** |
| `dsh-llm-retry`（内建） | — | 同 provider 的重试预算（normal/always 模式）；预算耗尽或非可重试 code 时 `next()` 委派给下游 |

失败分类是 provider-neutral 稳定 code：`RATE_LIMIT` / `SERVER` / `TIMEOUT` /
`TRANSPORT` / `EMPTY_RESPONSE` / `QUOTA` / `CONTEXT_WINDOW_EXCEEDED` / `INVALID_CREDENTIAL`。

**结论**：DSH 端可完整实现「检测失败 → 换渠道继续」，进程内、顺着官方架构纹理。

### 架构：一个核心 + 一个薄适配

决策逻辑抽成纯域层，DSH 插件只是薄薄的适配层：

```
daruma-core（纯域层，零运行时依赖）
  └─ dsh-daruma（Cordis 插件，进程内 failover）
```

## 3. ADR（架构决策记录）

### ADR-001 语言：TypeScript（pnpm monorepo）

- **约束**：`dsh-daruma` 是 Cordis 插件，必须是 TS/JS，与宿主同进程共享类型。
- **推论**：`daruma-core` 必须能被插件进程内 `import`，故也是 TS。用 Go/Rust 写 core 会迫使跨进程序列化，负资产。
- **决定**：TS，`strict` + `noUncheckedIndexedAccess` + `verbatimModuleSyntax`。

### ADR-002 架构：战略 DDD + 六边形

- core 是纯域层：`classify`/`decide` 无 I/O、不读全局时钟（Clock 注入）、确定性输出。
- 端口（`Clock` / `ChannelHealthStore` / `HealthProbe` / `SignalSource`）在 core 定义，适配器实现。
- 限界上下文：Failure Taxonomy（分类）、Channel Health（熔断状态机）、Recovery Policy（决策）。
- **不做全套战术 DDD**（CQRS/事件溯源/Repository 抽象数据库）——规模不匹配，且 DSH 会话本身已 event-sourced，core 再搞一套是重复所有权。

### ADR-003 与 `dsh-llm-retry` 的分工

- `dsh-llm-retry` 管**同 provider 重试预算**（normal/always）。
- daruma 管**跨渠道 failover**：观察失败、累计渠道健康，只有当 retry 已委派（`next()` 下来）或渠道已熔断时才接管。
- daruma 在 `agent/request-error` 里先看 `next()` 的结果再决定是否接管，**对监听顺序稳健**（无论在上游还是下游都正确）。
- 触发 FAILOVER 时返回 `{ kind: 'retry' }` 并在下一次 `agent/request` 换 `LlmCallConfig`。

### ADR-004 渠道身份与模型粒度

- 渠道身份 = `provider::model`（派生 id）。`agent/request-error` 只给 `provider`，故模型用 `agent/request` 追踪的「当前渠道」补全。
- 同一 provider 下换模型（`mt::deepseek-v4-pro` → `mt::glm-5.2`）与跨 provider 换渠道是同一机制。

### ADR-005 熔断状态机

- 状态：`HEALTHY → COOLDOWN → PROBE → HEALTHY`。
- 不变量：COOLDOWN 期间不路由；连续失败达预算熔断；`QUOTA`/`INVALID_CREDENTIAL`/`CONTEXT_WINDOW_EXCEEDED` 直接熔断（retry 无意义）；每个 agent/session 的 `giveUpBudget` 耗尽 → `GIVE_UP` 终态。当前宿主没有 request-success 事件，因此 PROBE 仅保留为域状态，适配器不主动持久化半开状态。
- 渠道健康经 `ChannelHealthStore` 落盘（`~/.dsh/daruma/channel-health.json`），跨重启记住熔断。

### ADR-006 备用渠道与状态 UI

- **备用渠道**：存 `daruma:` settings namespace（`ctx.settings`），failover 决策优先选备用（`decide().preferred`）。
- **settings 空对象怪癖**：schemastery 对缺省 section 解析为空对象 `{}` 而非 `undefined`，`getBackup()` 必须校验 provider/model 非空，否则空对象会被当成合法 backup 选中（曾导致 failover 切到字段全 undefined 的渠道）。
- **状态 UI**：client bundle 挂 `conversation.input.dock`（常驻状态条）+ 弹出面板（候选测试/设备用），经 `/dsh-daruma` RPC 通信；failover 追加 durable `daruma/failover` 事件。
- **failover 历史**：engine 内存保留最近 5 次 failover，状态条显示「最近切换」。完整的会话流 conversation node 事件行暂缓。

## 4. 验证状态

| 项 | 状态 |
|---|---|
| daruma-core 27 单测 | ✅ |
| dsh-daruma 20 单测 | ✅ |
| dsh-daruma 实机启动（独立 profile @ 3081，HTTP 200，无未解析服务） | ✅ |
| **dsh-daruma 端到端 failover**（mock LLM：mock-a 429 → 自动切 mock-b → 任务完成，exit 0） | ✅ |
| **/dsh-daruma RPC 挂载**（status / listCandidates / setBackup） | ✅ 3081 实机启动无错 |
| **client bundle 加载**（`/plugins/dsh-daruma/client.js` serve 200） | ✅ |
| 状态条 / 备用面板的浏览器交互（需人工打开 3081 确认视觉） | ⏳ 代码与加载已验证，视觉待用户确认 |
| 完整 conversation node 会话流事件行 | ⏳ 简化为状态条「最近切换」显示，完整版记入后续 |

### 端到端 failover 复现方法

见 [e2e-test.md](./e2e-test.md)：用 `scripts/mock-llm-server.mjs` 模拟「主渠道 429、备渠道 200」，
在独立 headless profile 里配置 daruma 渠道 `mock-a → mock-b`，跑一个任务即可观察到
`mock-a → 429 → FAILOVER → mock-b → 200` 的完整链路。

## 5. 非目标（当前不做）

- 通用 LLM 反向代理（LiteLLM/one-api 类）——另一个项目。
- DSH 进程级崩溃 watchdog（DSH 请求失败不杀进程；会话持久化兜底）。
- 多 key 池轮换（DSH 侧多 key = 多 route，属 `dsh-llm-pi-ai` 配置）。
- 跨模型语义一致性评估器。
- Codex CLI / Claude Code / VS Code Codex 扩展的兼容（已评估，本期砍掉，聚焦 DSH）。
