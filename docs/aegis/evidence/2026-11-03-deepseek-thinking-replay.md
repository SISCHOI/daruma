# DeepSeek「thinking must be passed back」到底是什么条件（2026-11-03）

调查起点：一轮 MUSA 优化目标在 11:15 启动后，第 2 步请求被判 `400 INVALID_REQUEST`
（`The content[].thinking in the thinking mode must be passed back to the API.`），
该轮直接失败。问题被两次误判——先被归为「纯环境问题」，随后又被归为「DSH 把
跨模型历史降级、丢了 thinking 块」。本文用会话原档、全量扫描和真实 API 探针把
触发条件钉死。

## 结论（实测）

**thinking 模式下，任何带 `tool_use` 的 assistant 消息必须附一个 `thinking` 块；
块内容与签名都不校验。** 不带 `tool_use` 的 assistant 消息不需要 thinking。

推论：一个在非 DeepSeek 模型上开始的会话，只要其中某一步是工具调用且那个模型没吐出
推理内容，这段历史就无法直接回放给 DeepSeek 的 thinking 模式。渠道本身完全健康。

## 证据一：真实请求的历史里没有 reasoning（会话原档）

`session-a3d656b5`（cwd `cudnn-frontend`）逐条记录：

| seq | 记录 | 内容 |
|---|---|---|
| 28 | `request/header` | `provider: mt, model: gpt-6.1-sol` |
| 30 | `assistant/message` | content 只有 `tool-call`（`skill`），`source.replayState.kind = pi-ai` |
| 35 | `assistant/attempt` | `TIMEOUT`，`Request timed out.` |
| 36 | `request/header` | 改道 `provider: deepseek-account, model: deepseek-flash, reasoningEffort: high` |
| 38 | `assistant/attempt` | `INVALID_REQUEST` / 400，原报错 |
| 40 | `turn/end` | 同一个 400 |

该轮 mt 模型的流式块只有 `block-start(tool-call)` / `tool-call-chunks` /
`block-end`，没有任何 reasoning delta。**没有任何内容被丢弃**，DSH 保存的就是模型
真实返回的东西。

## 证据二：同一段历史，mt 通道全过

`session-c0c7f554` 同一时段（历史完全相同）：

| 时间 | 通道 | 结果 |
|---|---|---|
| 1793626577952 | deepseek-account | 400 thinking |
| 1793626607073 | deepseek-account | 400 thinking |
| 1793626614939 | mt/glm-5.3 | 200 `[text, tool-call]` |
| 1793626909238 | deepseek-account | 400 thinking |
| 1793626957316 | mt/deepseek-v4-flash | 200 `[text, tool-call]` |

可重复、方向一致：不是抖动，是协议条件。

## 证据三：全量扫描（837 个会话存档）

方法：解压 `~/.dsh/sessions/**/session.v4.jsonl.zstd`（多帧 zstd，逐帧解压），
找出 `assistant/attempt` 中 `status=400` 且消息含 `thinking` 的记录，回看紧邻的
`assistant/message` 的块类型与 `source`。

结果：33 次，落在 17 个会话；**全部**满足「紧邻的 assistant 消息来自 mt 或 ccmax」，
没有一次来自 deepseek-account。细分：

- 28 次：那条外来消息不含 reasoning（`[tool-call]` 或 `[text, tool-call]`）；
- 5 次：含外来 reasoning，DSH 会发出无 signature 的 `thinking`。

两种都 400，说明「补回 signature」不是必要条件；真正缺的是 `tool_use` 旁边的
thinking 块本身。

## 证据四：API 探针（区分四个假设）

脚本：`scripts/probe-deepseek-thinking-replay.py`（读本机凭据，只打印状态码与响应
片段，不打印 token）。端点 `https://api.deepseek.com/anthropic`，模型
`deepseek-flash`，`anthropic-version: 2023-06-01`。两次独立运行结果一致。

| 探针 | 历史形态 | thinking | 结果 |
|---|---|---|---|
| R1 | assistant 纯文本、无 thinking | enabled | 200 |
| R2 | 同上 | disabled | 200 |
| T1 | assistant `tool_use`、无 thinking | enabled | **400**（原报错） |
| T2 | 同上 | **disabled** | **200** |
| T3 | `tool_use` + 无签名 thinking | enabled | 200 |
| T4 | `tool_use` + 空 thinking（外来签名） | enabled | 200 |
| T5 | text + `tool_use`、无 thinking | enabled | **400** |

这份矩阵同时否掉了两个假设：不是「assistant 一律要 thinking」（R1 过），也不是
「外来 thinking 的签名不合法」（T3/T4 过）。

## 对 DSH 的含义（开放项）

DSH 的 DeepSeek 适配器把外来历史按「有推理就发 thinking、没有就不发」序列化
（`dsh-llm-deepseek/lib/index.js` 的 `assistant()`），于是外来工具调用回合一旦没有
推理内容，发出去的请求必然 400。服务端允许两种修法，且都已实测：

1. 给这类回合补一个空 `thinking` 块（T4）；
2. 把该请求降成 `thinking: disabled`（T2）。

两条都只在 DSH 适配器里可做。是否值得做取决于它是否愿意改写外来历史的形状——
这一点需要上游决策，本文只提供可复现的证据。

## 对 daruma 的含义（已实现）

故障转移不该把一个「只拒这段对话」的 400 当成渠道故障：老策略把它归到 `UNKNOWN`
（可重试、需连续 3 次才跳闸），于是每次都重新选中同一个 backup，一轮内 ping-pong
到 `giveUpBudget` 用尽。现在 `INVALID_REQUEST` 是 request-scoped：不动渠道健康，
只把该渠道从**当前会话**的路由里排除。改动与测试见
`fix/request-scoped-channel-exclusion` 分支。

## 证据边界

- API 探针打的是 `api.deepseek.com` 的账号路由（`x-dsh-auth-token`），与生产
  `deepseek-account` 渠道同一端点、同一模型；未覆盖 DeepSeek 之外的服务端实现。
- 「33 次 / 17 会话」只覆盖本机存档；不代表其他机器上的分布。
- 会话原档证明历史里确无 reasoning，但没有记录实际发出的 JSON 请求体——「服务端
  看到的就是无 thinking 的 tool_use 回合」这一步由 T1/T5 的构造请求等价复现。
