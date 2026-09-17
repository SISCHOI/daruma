# 重试耗尽升级（retry-exhaustion escalation）

> 日期：2026-09-17 ｜ 分支：`fix/retry-exhausted-trip` ｜ 插件版本：0.1.7（未发版）
> 触发事件：生产 3080 实例当日连吃 5 次 429，一次都没切渠道
> 三态：【实测】/【推断】/【开放】

## 1. 现场（【实测】，来自会话存档事件流）

来源：`~/.dsh/sessions/<workspace>/<session>/session.v3.jsonl.zstd`（多帧 zstd，按 magic 切帧解压）
＋ `~/.dsh/daruma/failover-log.jsonl` ＋ `~/.dsh/daruma/channel-health.json`。

| 时间（本地） | 事件 |
|---|---|
| 10:46:49–10:47:02 | 会话 `session-b07ae2e9`：`llm/retry` × **5**，全部 `code=RATE_LIMIT`、`provider=mt`、`retry=1..5 / maxRetries=5` |
| 10:47:11 | 该回合失败（`turn/end`） |
| 10:49:30–10:49:42 | 本会话 `session-02b9e7e4`：同样 **5** 次 `RATE_LIMIT` 重试（`turn=1 step=1`） |
| 10:49:51 | 回合失败；`channel-health.json` 落盘：`mt::glm-5.3` = `HEALTHY` / `consecutiveFailures=2` |
| 10:56:20 | 另一会话 `session-d744084c`：`daruma/failover` **真实发生**（`mt::glm-5.3` → `mt::gpt-5.5`，`reason=QUOTA`） |

两轮 RATE_LIMIT 在 `failover-log.jsonl` 里**零条目**——daruma 从未被要求做切换决策。
（daruma 只在 `boot` / `failover` / `give-up` 三处写日志：`dsh-daruma/src/index.ts`。）

**计数自证**：本会话 `assistant/attempt=6`（1 次首试 + 5 次重试）、`llm/retry=5`，而 daruma 只记
**1** 次。两个失败回合 → `consecutiveFailures=2`。

## 2. 根因

`dsh-llm-retry` 是 `agent/request-error` waterfall 的上游处理者
（`dsh-llm-retry/lib/index.js:151-173`）：对策略内的可重试码走**同渠道**重试，只有
`previousRetry >= maxRetries` 时才 `next()`，把失败交给下游的 daruma。

于是：

- 用户看到的 5 次 429 = **同一个请求的 5 次同渠道重试**，daruma 一次都看不到；
- daruma 收到的是重试耗尽后的**那 1 次**，`decide()` 中 `RATE_LIMIT` 不是终止码，只计 1 分
  （`daruma-core/src/failure.ts:24-37`、`recovery-policy.ts`）；
- `failureBudget: 3` 因此实际含义是"**3 个各自把 5 次重试打光的失败回合**"，而不是 3 次请求失败；
- 对比：`QUOTA` 是终止码且不在重试码表内 → 直达 daruma → **首次即切**（10:56:20 实测）。

即：**最常见的限流比少见的配额耗尽更难触发切换**，与"保长任务活着"的目标相反。

## 3. 修法

把"宿主同渠道重试预算已经耗尽"升级为一个显式信号，而不是继续按 1 次计数。

| 层 | 改动 |
|---|---|
| `daruma-core/src/signal.ts` | `FailureSignal.retryExhausted?: boolean`：宿主已为这次失败花光同渠道重试预算 |
| `daruma-core/src/config.ts` | `tripOnRetryExhausted?: boolean`（默认 `true`）+ `DEFAULT_CONFIG`；`false` 退回旧计数语义 |
| `daruma-core/src/recovery-policy.ts` | `tripsCircuit()`：终止码**或** `retryExhausted` 直接跳闸；两个原因各自成条 |
| `dsh-daruma/src/mapping.ts` | `isRetryExhausted(code, policy)`：`policy` 存在且 `mode==='normal'` 且该码在 `retryableCodes` 内 ⇒ 真 |
| `dsh-daruma/src/index.ts` | 组装信号时带上该标志；`failover` 日志行记 `retryExhausted: true`（可审计"为什么现在切"） |
| `dsh-daruma/src/config.ts` | 解析 `tripOnRetryExhausted`（默认开、类型校验） |

**为什么可以读"到达即耗尽"**：daruma 在 retry 下游，被调用本身就意味着 retry 拒绝了这个码；
对策略内的可重试码，那就是预算已耗尽。两种例外显式排除：
`policy === undefined`（没有路由拥有该请求，没人重试过）与 `mode === 'always'`
（该模式**先**征询下游再决定重试，到达不携带预算信息）。

## 4. 验收（【实测】）

命令（两个包各自）：

```powershell
cd packages\daruma-core ; node_modules\.bin\tsc.CMD -p tsconfig.build.json ; node_modules\.bin\vitest.CMD run --pool=threads
cd packages\dsh-daruma ; node_modules\.bin\vitest.CMD run --pool=threads
```

| 套件 | 基线 | 修复后 | 新增用例 |
|---|---|---|---|
| `daruma-core` | 28 passed | **35 passed** | `recovery-policy.test.ts` 5 条（耗尽即跳闸／无主计数／开关关闭／终止码不受影响／确定性）+ `config.test.ts` 2 条 |
| `dsh-daruma` | 82 passed, 1 failed | **91 passed, 1 failed** | `mapping.test.ts` 5 条（含 `always` 与无策略反例）、`config.test.ts` 1 条、`index.test.ts` 3 条（真实 payload 形状下端到端触发 + 日志字段 + 反例） |

关键用例（`dsh-daruma/src/index.test.ts`，走真实插件钩子）：
`failureBudget: 3` 下，一个带 `retryPolicy`（`mode: normal`、5 个重试码、`maxRetries: 5`）的
`RATE_LIMIT` 失败**首次**即武装并切换到链上目标，且 `failover-log.jsonl` 该行带
`retryExhausted: true`；不带 `retryPolicy` 的同样失败仍需要 3 个回合。

`retryPolicy` 的取值形态取自**生产实况**：会话存档中该策略的 `policyKey` 为
`["normal",5,["EMPTY_RESPONSE","RATE_LIMIT","SERVER","TIMEOUT","TRANSPORT"],500,10000,0.1]`，
测试里的夹具与之逐项一致。

**已知既有失败（非本次改动，未修）**：`dsh-daruma/src/http-transport.test.ts >
"answers 403 off loopback, 415 on wrong content type, 400 on broken JSON"` —— broken JSON 期望
400 实得 403；属工作区中未提交的 `http-transport` 半成品（`src/http-transport.ts` 另有 5 处
tsc 报错）。本次提交不含该文件。

## 5. 行为变更与兼容

- `FailureSignal` 与 `RecoveryPolicyConfig` 新增字段均为**可选**，旧配置可编译；
  但默认值本身就是本次修复（`tripOnRetryExhausted: true`），即**行为默认变更**：
  重试耗尽后的首次失败即跳闸。
- 需要旧语义的 profile 显式写 `tripOnRetryExhausted: false`。
- 生产生效条件：【开放】插件 `lib/` 需重新构建并重启 DSH 进程；本次仅为源码 + 测试，
  未构建 `dsh-daruma/lib`（工作区存在未提交的 client/http-transport 改动，构建会把半成品一并
  编译进运行时）。

## 6. 待办（【开放】）

- README 的 Configure 节需补一段 `tripOnRetryExhausted` 说明与"重试耗尽语义"小节；
  因 `README.md` / `packages/dsh-daruma/README.md` 当前有未提交改动（截图节），本次未触碰。
- `always` 模式下无法从到达位置判断预算，当前按"不升级"处理；如果将来要覆盖，需要宿主暴露
  重试次数（例如 payload 增加 `retryAttempt`）。
- 未做真实面验证（需要在 3080 实例重启后复现一次 429 场景）。
