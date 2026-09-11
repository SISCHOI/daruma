# daruma 跨平台适配（Windows / Linux / macOS）

- 日期：2026-09-11
- 分支：`feat/cross-platform`（后续收口在 `fix/wsl-dsh-interop`；两者均已合并进 main）
- 结论：**源码、脚本、文档与 CI 全部去 Windows 化；Linux 与 macOS 由真实 runner 实跑验证（4/4 e2e 作业 + 6/6 verify 作业全绿），另有本机 WSL 全流程实测**
- CI 运行：`ci` #34567264975 @ `cf194e0`、#34575893336 @ `fe0f876`（WSL 守卫）、#34577540218 @ `7371312`（合并后 main）→ 均 10/10 success（首次 #34563184490 的失败见 §3；本机 WSL 实测见 §3b）

## 1. 平台耦合审计

| 位置 | 问题 | 处置 |
|---|---|---|
| `packages/dsh-daruma/src/config.ts` | 默认状态文件硬编码 `homedir()/.dsh/daruma/...`，忽略 `DSH_HOME` → 自定义 home 的测试/沙箱 profile 会写进真实 `~/.dsh`（三个平台都会踩） | 改为与宿主 `dsh-home-paths` 同优先级：显式 `stateFile` > `$DSH_HOME` > `~/.dsh`；空白 `DSH_HOME` 视为未设置 |
| `packages/dsh-daruma/src/failover-log.ts` | 手写 `dirnameOf()` 同时按 `/` 与 `\` 切分，重复实现 `node:path` 语义 | 改用 `node:path.dirname`（单一所有者，按当前平台正确解析） |
| `scripts/start-daruma-test.ps1` | 仅 Windows 可用的启动器（PowerShell `Start-Process`/`Stop-Process`） | 逻辑迁移到跨平台 `scripts/start-daruma-test.mjs`；`.ps1` 变成 3 行薄封装，只保留 Windows 习惯入口 |
| 无跨平台 e2e 入口 | 端到端验证只能按 `docs/e2e-test.md` 手工在 Windows 上敲 | 新增 `scripts/e2e-failover.mjs`：在任何系统上建临时 DSH home → 链接本仓插件 → 起 mock → 跑 headless 任务 → 断言 6 项 |
| `eslint.config.js` | 本地 `.dsh-lab` 测试台（gitignored）被 lint，CI 又会因缺少它而看不见问题 | 显式 ignore `.dsh-lab/**` |
| CI | 无 | 新增 `.github/workflows/ci.yml`（3 系统 × 2 Node 版本 + Linux/macOS e2e 作业） |
| 文档 | README / `docs/e2e-test.md` 全是 PowerShell 与 `C:/Users/...` 示例 | 补 POSIX 命令与 `$DSH_HOME` 说明；新增"支持的 DSH 宿主"表 |

已确认**无需改**的部分（审计结论，避免无谓改动）：`store.ts` 的落盘（`mode 0o600` + rename 失败回退 + `chmodSync`，Windows 上 chmod 为 no-op 不抛错）、`model-llm-server.mjs`（绑定 `127.0.0.1`）、`check-no-bom.cjs`（`execSync('git ls-files …')` 在 POSIX 走 `/bin/sh`）、全部测试夹具（用 `os.tmpdir()` + `path.join`）、所有相对 import 的大小写与实际文件名一致（Linux 大小写敏感 fs 安全）、`.gitattributes` 已强制 LF。

## 2. 数字与命令

- 单测：`daruma-core` 28 + `dsh-daruma` 62 = **90**（新增 2 条 `DSH_HOME` 优先级断言）
- 本机（Windows）验证：`pnpm run build` / `typecheck` / `lint` / `test` / `check:no-bom` 全过，`node scripts/e2e-failover.mjs --dsh .dsh-lab/install-010rc7/.../bin.js` → 6/6 PASS
- CI 新增入口：`pnpm run start:test`（任意系统起 web 测试环境）、`pnpm run e2e:failover`（任意系统跑端到端）

## 3. CI 矩阵与结果（run #34567264975 @ `cf194e0`）

| 作业 | 结果 |
|---|---|
| verify (ubuntu-latest, node 22 / 24) | success ×2 |
| verify (macos-latest, node 22 / 24) | success ×2 |
| verify (windows-latest, node 22 / 24) | success ×2 |
| failover e2e (ubuntu-latest, dsh 0.1.0-rc.7 / 0.1.5-rc.2) | success ×2 |
| failover e2e (macos-latest, dsh 0.1.0-rc.7 / 0.1.5-rc.2) | success ×2 |

Linux 实跑原始输出（`raw/ci-failover-e2e-ubuntu-latest-dsh-0-1-5-rc-2--summary.txt`）：

```
mock completion from mock-b
PASS  task exits 0 — status=0
PASS  task text came from the fallback channel — mock completion from mock-b
PASS  failover log has a boot line
PASS  failover log records mock-a -> mock-b (RATE_LIMIT) — {"kind":"failover",…,"from":"mock::mock-a","to":"mock::mock-b","reason":"RATE_LIMIT",…}
PASS  tripped channel is persisted as COOLDOWN — {"channel":"mock::mock-a","state":"COOLDOWN","consecutiveFailures":1,…}
PASS  fallback channel is HEALTHY — {"channel":"mock::mock-b","state":"HEALTHY","consecutiveFailures":0,…}
platform=linux node=v24.20.0 dsh=dsh
failover e2e: all checks passed
```

首次运行（#34563184490 @ `04fb608`）**e2e 4/4 通过、verify 6/6 失败**，根因是 CI 步骤顺序：全新 checkout 没有 `packages/*/lib`，而 workspace 包之间通过构建产物互相解析（`daruma-core` 的 types/runtime 都在 `lib/`），于是 `typecheck` 报 `Cannot find module 'daruma-core'`。修复：verify 作业先 `pnpm run build` 再跑类型级 gate（commit `cf194e0`），并在 README 开发段落写明"全新 clone 必须先 build"。

## 3b. 本机 WSL 实测（2026-09-11 追加）

用户确认本机有 WSL。实测环境：WSL 2.7.12 / 内核 6.18.33.2-microsoft-standard-WSL2 / **Ubuntu 24.04.4 LTS**（此前未安装任何发行版，本次装入 `Ubuntu-24.04`），Node v24.19.0 + pnpm 11.7.0（发行版内安装，`/opt/node`）。

在 Linux 文件系统上（`/root/daruma-wsl`）跑完整流程：

| 步骤 | 结果 |
|---|---|
| `pnpm install --frozen-lockfile` + `pnpm run build` | 通过 |
| `pnpm run test`（28 + 71 = 99） | 全绿 |
| 互操作守卫：`--dsh /mnt/c/Users/shanzhiyu/nodejs/dsh` | **exit 2 + 修复提示**，且未留下任何 mock 进程（`:3099` 空闲） |
| `e2e:failover` vs `0.1.0-rc.7`（发行版内安装） | 6/6 PASS，`platform=linux node=v24.19.0` |
| `e2e:failover` vs `0.1.5-rc.2` | 6/6 PASS |
| `$DSH_HOME` 默认路径 | `DSH_HOME=/tmp/daruma-home` → `/tmp/daruma-home/daruma/channel-health.json`；未设 → `/root/.dsh/daruma/channel-health.json` |

原始逐行 transcript（含 `set -x`）：`raw/wsl-local-verification.txt`（Linux 侧生成后原字节拷回，UTF-8 无 BOM；扩展名用 `.txt` 是因为 `.gitignore` 忽略 `*.log`）。

**过程中发现并修掉的真问题**：WSL 会追加 Windows 的 PATH，裸 `dsh` 解析到 `/mnt/c/Users/shanzhiyu/nodejs/dsh`，用 Linux 的 node 去加载 Windows 安装 → `sharp`/`koffi` 平台二进制加载失败，报错形态是 `plugin tree failed to load`，看起来像 daruma 的问题。第一版守卫放在 `dshCommand()` 里、**在 mock server 启动之后**才拒绝并 `process.exit(2)`，于是留下一个仍占用 `:3099` 的孤儿 mock，导致后续 e2e 的新 mock 绑定失败、fallback 渠道被误判为 COOLDOWN（假失败）。修复：`assertUsableHost()` 提到分配任何资源之前（parse 之后立即校验），并补测"拒绝后 `:3099` 必须空闲"。

## 4. 证据

`raw/`
- `ci-run-jobs.json` — 成功运行的 10 个作业及其结论（GitHub API 原始响应）
- `ci-failover-e2e-<os>-dsh-<ver>-summary.txt` ×4 — 各 e2e 作业的 PASS/断言原文（含 `platform=linux|darwin`）
- `wsl-local-verification.txt` — 本机 WSL Ubuntu 24.04 全流程逐行 transcript

## 5. 局限与未覆盖

- **macOS/Linux 的 Web 面板**未做浏览器端验证（CI 与 WSL 都无头）：跨平台证据覆盖单测、类型、构建与 headless 故障转移全链路；面板的 RPC 注册问题见 `2026-09-11-latest-harness-compat.md`（属宿主缺陷，与平台无关）
- 本机 WSL 的 Linux 实测覆盖 Ubuntu 24.04；CI 另外覆盖 macos-latest，macOS 未在本机实跑
- CI 的 e2e 只跑 `ubuntu` 与 `macos`（Windows 的 e2e 已在生产实例与本机 lab 长期实测过，并未纳入矩阵以控制时长）
- `0.1.3-alpha.1/alpha.2` 未纳入 e2e 矩阵（前者 tarball 拉取失败，后者依赖 `fs-ext` 原生构建，本机与 CI 默认环境都装不上）
