# 计划：把换通道动作搬到 `llm/stream`

> 2026-11-18。目标宿主：桌面版 DeepSeek Harness `0.2.2-rc.3`（同时兼容 `0.1.x`）。
> 触发事故见 `docs/aegis/evidence/2026-11-18-dsh-0.2.2-request-swap-rejected.md`。

## 要修的问题

DSH 从 `0.2.1-alpha.4` 起把模型选择固定到 step 准备阶段：`agent/request` 监听器
**不允许**改 provider/model（安装包内 `docs/upgrade-guide/v0.2.1-alpha.4/session-model-selection/guide.md`）。
主循环在 `dsh-agent-loop/src/agent.ts:641` 硬校验，任何改动直接抛错、整轮报废：

```
agent/request proposed "deepseek-account/deepseek-flash" after step preparation fixed "ccmax/claude-opus-5-5"
```

daruma 0.1.x 的换通道恰好就写在 `agent/request` 里，于是在新宿主上每一次故障转移
都变成一次自杀：ccmax 的 503 本来只是失败一次，被 daruma 一换就整轮死掉。

同一 step 内的重试会复用捕获的 selection（`agent.ts:451`），所以「先
`agent.model.select()` 再重试」也救不回当前这一步——换执行者这件事只能发生在
模型调用层，不能发生在智能体循环层。

## 为什么选 `llm/stream`

宿主把 `llm/stream` 明确定义成路由瀑布（`dsh-llm/src/index.ts:76`）：

```ts
'llm/stream'(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk>
```

- 它在**每一次**流式模型调用外面，参数就是完整请求 `GenerateOptions`（含
  `provider`/`model`/`sessionId`），监听器可以不调 `next()` 而自己产出流；
- 适配器失败在 `adapterStream` 里被转成 `finish` chunk（不是抛出），所以监听器
  能看见错误并决定下一跳；
- 主循环请求带 `markAgentLoopRequest` 标记（`isAgentLoopRequest()` 可判定），
  和压缩、标题这类辅助调用能区分开；
- 改的是「谁执行」，请求内容（messages/system/tools）原样透传，符合
  「失败后只换执行者、不改请求形状」的既有设计。

实测两代宿主都有该事件与标记：`0.1.5-alpha.1` 与 `0.2.2-rc.3` 的
`dsh-llm/lib/index.js` 均含 `llm/stream` 分发与 `isAgentLoopRequest`。

## 改动清单（只动 `packages/dsh-daruma`）

1. `src/index.ts`
   - 删除 `agent/request` 监听器（它做过的事只有两件：记录当前通道、执行换模型；
     前者移到新监听器里，后者作废）。
   - 新增 `llm/stream` 监听器：
     - 只处理 `isAgentLoopRequest(options)` 为真、且带 `sessionId` 的调用；
     - 进入时记录 `currentChannel`（会话 → 本次实际路由）、清掉
       `failedSinceRequest`（与旧的 attempt 粒度一致）；
     - 命中本会话待用的转移目标（`pending`，一次性 + 10 分钟 TTL）时：同步消费，
       `currentChannel` 记为目标通道，返回一个换到目标通道的新请求流
       （`ctx.llm.stream({ ...options, provider, model })`，并对该新请求打递归
       防护标记）；
     - 未命中：`next()`，原样走宿主链路。
   - `agent/request-error` 的判定逻辑（跳闸、预算、日志、返回 `{ kind: 'retry' }`）
     保持不动——它仍然是「宿主重试预算耗尽」这一信号的唯一入口。
   - 转移目标改为按 `sessionId` 挂起，不再要求 `from` 路由等于本轮 selection：
     第二次及以后的跳转里，主循环的路由始终是用户选的原始通道，多跳链条靠
     「会话 + 一次性 arm + TTL」才能继续。
2. `src/mapping.ts`
   - `toFailoverConfig` → `toFailoverOptions`：入参从 `LlmCallConfig` 换成
     `GenerateOptions`，reasoning effort 的取舍逻辑（读到目标能力才保留，否则丢弃）
     与日志口径完全不变。
3. `src/index.test.ts` / `src/mapping.test.ts`
   - 改为驱动新的瀑布：断言换道发生在 `llm/stream`、`next()` 不被调用、
     arm 一次性、非本会话/非主循环调用不被劫持、effort 丢弃仍生效、
     重试耗尽升级路径的日志字段不变。
4. `README.md` / `README.zh-CN.md`
   - 扩展点描述改为 `agent/request-error` + `llm/stream`，并写明已知代价：
     助手消息里记录的是**选择的路由**，不是实际应答的通道（归属由
     `failover-log.jsonl` 与 `channel-health.json` 兜底）。
5. `packages/dsh-daruma/package.json`：`0.1.11` → `0.1.12`。

## 不做的事

- 不动 `daruma-core` 的决策逻辑、渠道健康、JSONL 日志格式、RPC 与面板、
  备用通道存储。
- 不引入虚拟 provider / 本地代理这类大改；如果 TTL + 一次性 arm 的行为在
  真实面不够用，再单独评估。
- 不改宿主、不改生产 profile（部署到桌面版是最后一步，需用户重启）。

## 验收

1. 单测：`pnpm --filter dsh-daruma test`，含新增的 5 条。
2. `typecheck`、`build`、BOM 守卫（`pnpm run check:bom` 或等价命令）。
3. 真实宿主 e2e：用桌面版自带的 `0.2.2-rc.3` CLI 跑 `scripts/e2e-failover.mjs`
   （临时 home + mock 服务器，不碰生产 `~/.dsh`），断言 `mock-a 429 → mock-b 200`、
   任务 exit 0、failover 行 `mock::mock-a -> mock::mock-b`。
4. 对照组：同一 e2e 跑当前发布的 `0.1.11`（旧代码），在 `0.2.2` 上应复现
   「整轮失败」；这条对照证明修的是真问题，不是测试判据。
5. 生产生效（需用户重启桌面版）：把 desktop profile 的 `dsh-daruma` 指向本地构建，
   重启后核对新 `boot` 行 + 下一次真实故障的 `failover` 行，且会话不再以
   `UNKNOWN` 结束。

## 回退

`git revert` 本分支提交 + desktop profile 依赖改回 `^0.1.11` + 重启桌面版。
