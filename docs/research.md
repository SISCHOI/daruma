# Daruma — Research & Architecture

> 调研与架构决策记录。2026-08-26。

## 1. 问题

第三方订阅 API 不稳定（`429`/`500`/网络波动/模型抽风/风控审核）导致长任务非人为中断。诉求：检测「任务未执行 / 非人为中断」，自动让会话继续，或切换模型/渠道继续。目标宿主：DSH、Codex CLI、Claude Code。

## 2. 三工具机制调研

### 2.1 DeepSeek Harness (DSH)

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

### 2.2 Codex CLI

无进程内插件系统。`config.toml` 仅有重试配置。恢复入口：`codex exec resume <id>`（非交互）/ `codex resume --last`。可行路径是**外部 watchdog**（进程监控 + resume 拉起）。

### 2.3 Claude Code

有 hooks 系统（`SessionEnd`、`PreCompact` 等），可感知中断；但 hooks 是进程内 shell 命令，无法改模型选择。恢复入口：`claude --resume <id>` / `claude -r`。可行路径同样是**外部 watchdog**。

### 2.4 结论：一个核心 + 三个薄适配

三家的进程内机制不兼容，「大一统插件」不存在。但**决策逻辑可以三端共用**：

```
daruma-core（纯域层，零运行时依赖）
  ├─ dsh-daruma（Cordis 插件，进程内 failover）
  └─ daruma-watch（CLI daemon，codex/cc 进程 watchdog + resume）
```

## 3. ADR（架构决策记录）

### ADR-001 语言：全栈 TypeScript（pnpm monorepo）

- **约束**：`dsh-daruma` 是 Cordis 插件，必须是 TS/JS，与宿主同进程共享类型。
- **推论**：`daruma-core` 必须能被插件进程内 `import`，故也是 TS。用 Go/Rust 写 core 会迫使跨进程序列化，负资产。
- **daruma-watch**：复用 core 的唯一方式是同语言。单人项目，一种语言一个测试栈一条 CI，存活率最高。单二进制分发（Node SEA / 后续加壳）留作未来边界，现在不赌。
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

### ADR-005 非人为中断判定启发式

- 进程退出码非 0 / 信号杀死 / 停滞（`--stall-timeout` 无输出）→ 非人为。
- 退出码 0 → 正常，绝不 resume。
- `--skip-exit-codes` 显式标记「故意退出码」（如 130）不触发 resume。
- **已知局限**：无法 100% 区分 Ctrl-C 与崩溃，靠退出码 + 日志尾部 + 显式白名单三重判定降低误判。

### ADR-006 熔断状态机

- 状态：`HEALTHY → COOLDOWN → PROBE → HEALTHY`。
- 不变量：COOLDOWN 期间不路由；连续失败达预算熔断；`QUOTA`/`INVALID_CREDENTIAL`/`CONTEXT_WINDOW_EXCEEDED` 直接熔断（retry 无意义）；全局 `giveUpBudget` 耗尽 → `GIVE_UP` 终态。
- 渠道健康经 `ChannelHealthStore` 落盘（`~/.dsh/daruma/channel-health.json`），跨重启记住熔断。

## 4. 验证状态

| 项 | 状态 |
|---|---|
| daruma-core 32 单测 | ✅ |
| dsh-daruma 12 单测 | ✅ |
| daruma-watch 14 单测 | ✅ |
| dsh-daruma 实机启动（独立 profile `daruma-test` @ 3081，HTTP 200，无未解析服务） | ✅ |
| daruma-watch CLI 端到端（exit 1 → resume → exit 0） | ✅ |
| dsh-daruma 实机 failover（需真实 model 失败触发） | ⏳ 待做（需 mock LLM server 或真实 429 触发） |

## 5. 非目标（当前不做）

- 通用 LLM 反向代理（LiteLLM/one-api 类）——另一个项目。
- DSH 进程级崩溃 watchdog（DSH 请求失败不杀进程；会话持久化兜底）。
- 多 key 池轮换（DSH 侧多 key = 多 route，属 `dsh-llm-pi-ai` 配置）。
- 跨模型语义一致性评估器。
