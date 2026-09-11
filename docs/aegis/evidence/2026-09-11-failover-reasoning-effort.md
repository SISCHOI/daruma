# Failover 请求形态收口：目标渠道不接受 reasoningEffort 时的处置（2026-09-11）

- 分支：`fix/failover-reasoning-effort`
- 触发：生产会话 `session-ee18808a-…`（工作区 `C:\Users\shanzhiyu\Documents\code\CMusa-agent`）连续 4 轮死在
  `provider "mt" model "…" does not support reasoning effort "high"`，用户提问"这个能解决吗"
- 结论：能。根因是 daruma 换渠道时把调用方的 `reasoningEffort` 原样带到了不接受该档位的目标渠道，
  且该拒绝发生在 DSH 的派发前校验里（`agent/request-error` 之外），整轮直接死亡、failover 渠道从未真正派发。
  修复后换渠道请求按目标能力收敛形态，仍保留主渠道的 `high`。

## 1. 现象与证据

### 1.1 会话存档（一手证据）

存档：`C:\Users\shanzhiyu\.dsh\sessions\--C-Users-shanzhiyu-Documents-code-CMusa-agent--\session-ee18808a-09b7-4759-9ac8-47c880f4ed5a\session.jsonl.zstd`
（多 zstd frame 拼接，按 `28 B5 2F FD` magic 分段解压后得 18284 行 JSONL）

| seq | 事件 | 关键字段 |
| --- | --- | --- |
| 367308 | `daruma/failover` | turn 26：`deepseek-official::deepseek-v4-flash` → `mt::deepseek-v4-flash`，`CONTEXT_WINDOW_EXCEEDED`/400 |
| 367310 | `turn/end` | `{"kind":"error","error":{"code":"UNSUPPORTED_REASONING_EFFORT","message":"provider \"mt\" model \"deepseek-v4-flash\" does not support reasoning effort \"high\""}}` |
| 367318 / 367320 | `daruma/failover` / `turn/end` | turn 27 → `mt::minimax-m3`，同样 `UNSUPPORTED_REASONING_EFFORT` |
| 367328 / 367330 | `daruma/failover` / `turn/end` | turn 28 → `mt::deepseek-v4-pro`，同样 `UNSUPPORTED_REASONING_EFFORT` |
| 381229 / 381231 | `daruma/failover` / `turn/end` | turn 31 → `mt::deepseek-v4-pro`，同样 `UNSUPPORTED_REASONING_EFFORT` |

同时段 `request/header` 记录主渠道请求形态：`{"provider":"deepseek-official","model":"deepseek-v4-flash","reasoningEffort":"high","maxTokens":256000}`。

### 1.2 daruma 审计日志

`C:\Users\shanzhiyu\.dsh\daruma\failover-log.jsonl`（同一 agentId，`failoverCount` 1→2→3→4，`giveUpBudget` 8）：

```
{"kind":"failover",…,"from":"deepseek-official::deepseek-v4-flash","to":"mt::deepseek-v4-flash","reason":"CONTEXT_WINDOW_EXCEEDED","status":400,"turn":26,…}
{"kind":"failover",…,"to":"mt::minimax-m3",…,"turn":27,…}
{"kind":"failover",…,"to":"mt::deepseek-v4-pro",…,"turn":28,…}
{"kind":"failover",…,"to":"mt::deepseek-v4-pro",…,"turn":31,…}
```

每次 `from` 都还是主渠道 —— 说明每轮都在主渠道失败→武装目标→目标请求在派发前被拒→整轮结束，
下一轮又从主渠道重来；`mt` 侧渠道从未真正收到请求，因此永远保持 HEALTHY、每轮都会被重新选中。

## 2. 根因（代码级）

1. `packages/dsh-daruma/src/mapping.ts`（修复前 `toCallConfig`）只替换 `provider/model`，其余字段原样保留，
   `reasoningEffort: "high"` 被一起带到目标渠道。
2. `~/.dsh/settings.yaml` 的 `mt` 路由模型条目只声明 `id/contextWindow/maxTokens`，未声明 `reasoningEfforts`；
   `dsh-llm-pi-ai` 对未声明的模型返回 `reasoning: false`（`lib/index.js:1063-1066`，`mt` 不在 pi-ai 内置目录、无 base 可继承）。
3. `dsh-llm` 在 `resolveCallFor` 里对显式 effort 做硬校验并抛
   `UNSUPPORTED_REASONING_EFFORT`（`lib/index.js:1274`，无 clamping/aliasing）。
4. 该错误由 `dsh-agent-loop` 的 `buildRequest` → `llm.prepareCall()` 抛出（`lib/index.js:685-700`），
   **不在** `step()` 里包 `agent/request-error` 的那段（`lib/index.js:629-641`，只覆盖 `stream()` 的 finish 错误）。
   所以：整轮以该错误结束，daruma 的 request-error 钩子拿不到第二次失败，目标渠道无法被标记为不可用。

链上三个候选（`mt::deepseek-v4-flash` / `mt::minimax-m3` / `mt::deepseek-v4-pro`）都未声明 reasoning 能力，
即"不是选错目标，而是这条链一个都落不了地"。

## 3. 修复

- `mapping.ts`：新增 `toFailoverConfig(config, target, lookup?)`，替换原 `toCallConfig`。
  换渠道时读目标模型元数据（`LlmRuntime.resolveModelInfo`，即 `reasoning.efforts[].id` + `defaultEffort`）：
  - 目标支持该档位 → 保留；
  - 目标未声明 reasoning 能力 → 去掉该字段（`EffortDisposition = dropped-unsupported`，携带 advertised 列表）；
  - 能力查询失败 / 无 llm runtime → 去掉该字段（`dropped-unverifiable`，fail-closed 到"能派发"）；
  - 调用方本来没有 effort → 完全不查运行时（`none-requested`）。
  其余字段（`maxTokens`/temperature/stop）一律原样透传。
- `index.ts`：`agent/request` 钩子 `await toFailoverConfig(current, armed, ctx.llm)`，
  并通过 `logEffortDisposition` 在服务端日志显式记录被丢弃的档位（否则用户只会看到"悄悄降档"）。
- `packages/dsh-daruma/README.md`：在 "How it works" 补上"目标渠道必须能接受该请求"的契约说明。

## 4. 验证

### 4.1 红检（先证伪再证真）

把 `withoutEffort` 临时改成 no-op（保留 effort）后重跑 `mapping.test.ts` + `index.test.ts`：
**6 个用例失败**（4 个 mapping + 2 个插件级），`kept` / `none-requested` 两类仍通过；恢复实现后全绿。
即新增用例确实锁住了这次的故障面，而不是"总是绿的"。

### 4.2 回归

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 单元回归 | `pnpm test` | `daruma-core` 28 passed；`dsh-daruma` 71 passed（12 files，含新增 `src/index.test.ts` 4 例、`mapping.test.ts` 11 例） |
| 类型 | `pnpm typecheck`（逐包） | 通过 |
| Lint | `pnpm lint` | 通过 |
| BOM 守卫 | `node scripts/check-no-bom.cjs` | `91 files (tracked + untracked) clean` |
| 构建 | `pnpm build` | 两包构建通过，`packages/dsh-daruma/lib/index.js` 已含 `toFailoverConfig` 与两条 drop 日志 |

> 说明：本机 `workspace-write` 沙箱下 vitest（fork 池）与 Vite 的 Windows realpath 探测都会
> `spawn EPERM`，测试/构建/守卫三条命令是在一次性提权（danger-full-access）下跑的。

### 4.3 插件级用例覆盖的链路

`src/index.test.ts` 用假 ctx 驱动真实 hook：先发一次 `agent/request` 建立当前渠道，
再发 `agent/request-error`（`failureBudget: 1` → 立刻跳闸）确认返回 `{ kind: 'retry' }`，
然后发第二次 `agent/request` 断言换渠道后的 config。覆盖"武装 → 换渠道 → 降档日志"这条真实路径。

## 5. 未覆盖 / 后续（本次未做）

1. **上游缺口**：前置校验错误（`UNSUPPORTED_REASONING_EFFORT`、`NO_ADAPTER`、模型 id 不存在等）
   不经过 `agent/request-error`，任何改写 request config 的插件都无法补救。建议向上游反馈
   （或 daruma 侧预校验：本次已用 `resolveModelInfo` 覆盖了 effort 这一类）。
2. **本次 `CONTEXT_WINDOW_EXCEEDED` 本身不是"会话太长"**：provider 原文为
   `requested 1051050 tokens (795050 in the messages, 256000 in the completion)`，
   而 `deepseek-official` 的 `maxTokens` 默认 256000（`dsh-llm-deepseek/lib/index.js:413`）——
   是完成预算把请求顶出 1M 窗口。即便修好 effort，换到 mt（1M 窗口 + 继承的 256k / mt 自身 384k）大概率同样超限。
   现实解法：调小该路由 `maxTokens`（`settings.yaml` 的 `llm-deepseek:` 段）、`/compact` 或换会话。
3. **`compaction-basic` 没有接管这次 overflow**：turn 26–28 会话内没有任何 `compaction/start|end|summary`，
   只有 turn 29 的 18 条 `compaction/prune`。它的 overflow 分支会先 prune 再选摘要区间，
   区间为 `null` 时 `return null` 并落回 `next()`（`dsh-compaction-basic/lib/index.js:868-875, 824`），
   才轮到 daruma。具体为何没选出区间未复现，值得单独查（可能与 token meter 不计 `max_tokens` 预留有关）。
4. **配置侧替代方案未采纳**：给 `mt` 的 28 个模型逐个声明 `reasoningEfforts` 也能让 `high` 通过校验，
   但会改变所有 mt 调用的线上行为（真的下发 `reasoning_effort`，网关是否接受未验证），
   且无法覆盖未来任何新增渠道；代码侧收敛一次性解决。
5. **`CONTEXT_WINDOW_EXCEEDED` 是否该换渠道**未在设计上收紧：daruma 拿不到 prompt 大小，
   无法判断目标 `contextWindow - maxTokens` 是否容得下，目前仍按终端失败换渠道（换到更大窗口的渠道是合理动作）。

## 6. 提交与工作区说明（审计必读）

本次实现期间，**另一个会话在同一工作区并发提交**：`cf2c717 "fix: strip the BOM the evidence collector wrote"`
（author/committer = shanzhiyu，2026-09-11 14:03:08）用 `git add -A` 把本任务**未提交的源码改动**
（`src/mapping.ts`、`src/index.ts`、`src/mapping.test.ts`）连同它自己的 cross-platform 证据文件一起提交了，
提交信息与内容不符；`feat/cross-platform` 分支停在 `5bd0cbe`，其 BOM 修复实际落在本分支上。
为不干扰在跑的另一会话，未做 history rewrite。因此本分支上：

- `cf2c717` = 另一会话的 BOM/证据改动 + 本任务的源码改动（混合，信息不准确）；
- 后续一个提交 = 本任务的测试（`src/index.test.ts`、`mapping.test.ts` 收尾）+ 本证据文档 + README 契约说明。

如需干净历史，可在两分支都无在跑会话时用 `git reset --soft` 拆分为
「cross-platform 证据 + BOM」与「failover effort 收敛」两个提交。

**2026-09-11 决定（用户）**：本分支连同 `cross-platform` 一条线的内容**作为一个 MR 交付**，
不做历史拆分；`feat/cross-platform` 的全部内容已在本分支（`5bd0cbe` 是祖先），合并后可删除。
若 cross-platform 会话之后还有新提交，需另行 cherry-pick 或另开 MR。
