# 2026-11-18 换渠道搬到 `llm/stream`（DSH 0.2.2 实机验证）

## 结论

`dsh-daruma` 0.1.11 在新宿主上「换备用渠道 = 整轮失败」的根因是 DSH 的模型选择契约
变了：从 `0.2.1-alpha.4` 起，模型选择在 step 准备阶段固定，`agent/request` 监听器
再改 provider/model 会被主循环直接判错。0.1.12 把换渠道移到 `llm/stream` 路由瀑布，
在 `0.2.2-rc.3` 上实测：主渠道 `429` → 切到备用 → 任务退出码 0；同一场景下改动前的
构建整轮失败。

## 生产现场（修复前）

宿主：桌面版 DeepSeek Harness `0.2.2-rc.3`（`app.asar` 内 CLI 版本相同）。

会话 `session-77bcb2b1-3e9b-42fe-836b-d4b7c34bdf72`，第 107 轮：

1. 请求发到 `ccmax/claude-opus-5-5`（www.wanhaapi.xyz 代理），上游回
   `503 {"error":{"message":"请稍后 1 分钟后重试…"}}`（会话事件 `assistant/attempt`
   `finish.error`）。
2. daruma 判定主渠道故障并武装转移目标（`~/.dsh/daruma/failover-log.jsonl`：
   `ccmax::claude-opus-5-5 -> deepseek-account::deepseek-flash`，`reason=SERVER`，
   `turn=107 step=1`，`retryExhausted=true`）。
3. 下一次请求尝试时，0.1.11 在 `agent/request` 里把 config 换到 deepseek-flash，
   主循环抛错，`turn/end` 记为 error：

```
agent "session-77bcb2b1-…": agent/request proposed "deepseek-account/deepseek-flash"
after step preparation fixed "ccmax/claude-opus-5-5"; use agent.model.select() before step preparation
```

影响面（该工作区 8 个会话里扫出）：4 个会话共 19 轮以这条错误结束——
`session-77bcb2b1` 9 轮、`session-fee9ac28` 5 轮、`session-26348a75` 4 轮、
`session-feb9b7aa` 1 轮。daruma 日志里同一会话有 6 次从 `ccmax::claude-opus-5-5`
切出（turn 61 / 68 / 69 / 70 / 105 / 107）。

## 根因（源码口径）

- 安装包内 `docs/upgrade-guide/v0.2.1-alpha.4/session-model-selection/guide.md`：
  `agent/request` 已弃用，「cannot change provider or model」，插件必须在提示词
  组装前用 `agent.model.select()` 选定；这一步之后的选择对**下一步**生效。
- `dsh-agent-loop/src/agent.ts:641`：主循环硬校验，provider/model 与 step 捕获的
  selection 不一致即抛错。
- `dsh-agent-loop/src/agent.ts:451`：同一步内的重试复用 `decision.selection`，
  所以「失败时先 `agent.model.select()` 再重试」也救不回当前这一步。
- 结论：换执行者只能发生在模型调用层，`llm/stream` 是宿主保留的路由瀑布
  （`dsh-llm/src/index.ts:76`，监听器可以不调 `next()` 自己产出流，
  `adapterStream` 会把适配器失败转成 `finish` chunk 而不是抛出）。

## 改动

`docs/aegis/plans/2026-11-18-llm-stream-failover.md` 有完整清单，要点：

- `src/index.ts`：删掉 `agent/request` 监听；新增 `llm/stream` 监听，命中本会话的
  待用转移目标时把这一次请求换到目标渠道执行（主循环请求对象不动，一次性 arm，
  10 分钟 TTL，递归防护）。`agent/request-error` 的判定与日志字段不变。
- `src/mapping.ts`：`toFailoverConfig` → `toFailoverOptions`（入参换成
  `GenerateOptions`），effort 取舍逻辑不变。
- 单测：`dsh-daruma` 113 条（新增 6 条覆盖换道、一次性、不劫持他会话/辅助调用、
  drop effort、不改原请求）。

## 验证（实测）

### 单元 / 构建（本地 Windows）

```
pnpm --filter dsh-daruma typecheck                  # pass
pnpm --filter dsh-daruma test                       # 16 files / 113 tests pass
pnpm --filter dsh-daruma build                      # pass
node scripts/check-no-bom.cjs                       # 153 files clean
```

### 真机 e2e：DSH 0.2.2-rc.3 宿主（桌面版运行时，临时 home + mock，不碰生产 `~/.dsh`）

```
ELECTRON_RUN_AS_NODE=1 "<Desktop>\DeepSeek Harness.exe" \
  scripts/e2e-failover.mjs --dsh "<Desktop>\…\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js" \
  --mock-port 3181
```

```
host: 0.2.2-rc.3 layout=forms
PASS  task exits 0 — status=0
PASS  task text came from mock-b — mock completion from mock-b
PASS  failover log has a boot line
PASS  failover log records mock-a -> mock-b (RATE_LIMIT)
PASS  failover was escalated by a spent retry budget — retryExhausted=true
PASS  tripped channel is persisted as COOLDOWN
PASS  fallback channel mock-b is HEALTHY
failover e2e: all checks passed
```

### 对照：改动前（`main` = 0.1.11）同一宿主、同一脚本

```
git worktree add … main && pnpm install --offline && pnpm -r build
ELECTRON_RUN_AS_NODE=1 … e2e-failover.mjs --dsh <0.2.2 bin.js> --mock-port 3182
```

```
FAIL  task exits 0 — status=1
FAIL  task text came from mock-b
FAIL  fallback channel mock-b is HEALTHY — null
dsh: MODEL_SWITCH_COMPACTION_FAILED: Cannot switch to mock/mock-b: context compaction failed …
```

如实说明：headless 场景里旧代码的失败形态是 `MODEL_SWITCH_COMPACTION_FAILED`
（切换到目标时会先过压缩压力检查），而生产 GUI 会话里是同一条 `agent/request …
after step preparation fixed` 报错。两者都源于同一处契约变化（旧代码在 `agent/request`
里换 provider/model），但**不是同一条错误文本**；对照证明的是「旧代码在该宿主上
换渠道必挂、新代码必成」，不是「复现了生产那条消息」。

## 尚未完成（部署）

- 插件代码已构建，但桌面 profile 仍指向 npm 的 0.1.11；生效需把 desktop profile 的
  `dsh-daruma` 指到本地构建并重启桌面版（插件只在启动时加载）。
- 重启后的生产判据：`failover-log.jsonl` 出现晚于重启的新 `boot` 行；下一次主渠道
  故障出现 `failover` 行且会话**不**以 `UNKNOWN` 结束；`session-77bcb2b1` 型会话
  可正常继续。
- 归属口径：助手消息记录的是主循环选择的路由，不记录实际应答渠道；真实去向以
  `failover-log.jsonl` / `channel-health.json` 为准。

## 复现命令

```powershell
# 单测与构建
cmd /c "cd /d C:\Users\shanzhiyu\code\daruma\packages\dsh-daruma && pnpm test"

# 0.2.2 真机 e2e
$exe = "C:\Users\shanzhiyu\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe"
$bin = "C:\Users\shanzhiyu\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js"
cmd /c "set ELECTRON_RUN_AS_NODE=1&& `"$exe`" C:\Users\shanzhiyu\code\daruma\scripts\e2e-failover.mjs --dsh `"$bin`" --mock-port 3181"
```
