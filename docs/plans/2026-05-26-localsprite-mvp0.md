# DUCKPLAN — localsprite MVP-0

> 日期：2026-05-26
> Slug：localsprite-mvp0
> 状态：draft，待用户确认进 SPEC-SPLIT

## Plan

实现 8 个 MCP tool（mirror TestSprite 接口表面，详 `docs/research/testsprite-mcp-surface.md`），跑在本地 Node 进程，背后用本地 Docker container 做沙箱，用 `claude` CLI subprocess 做生成引擎。

**4 大功能模块**（与用户 scope 锁定一致）：

1. **Intent infer** — tool 2/3 / `generate_code_summary` + `generate_standardized_prd`
   - 扫 user 项目根目录，识别框架（React/Vue/Svelte/Express/Fastify/Next）
   - 派 cc subprocess 读 README + package.json + 主要路由文件，生成结构化 PRD
   - 输出：`{projectPath}/.localsprite/code_summary.json` + `standard_prd.json`

2. **Parallel UI exploration agents** — tool 4 + tool 6 frontend 路径
   - 起 N=3 只 Playwright headless 实例
   - 每只一只 cc subprocess 驱动："你是用户，去探索这个应用 5 分钟，记录所有可达页面 + 交互 + 异常"
   - 汇总 coverage + 生成场景 → `frontend_test_plan.json`
   - tool 6 调用时：把场景翻成 Playwright 代码 + 在 Docker 里跑

3. **Backend integration test 生成** — tool 5 + tool 6 backend 路径
   - 扫 Express/Fastify/Next 路由清单
   - cc 生成 vitest + supertest 风格集成测试，含 dynamic fixture + auto-cleanup teardown
   - 在 Docker 容器内启 server + 跑测 + 捕获结果

4. **Auto-patching report** — tool 6 输出格式
   - 测试挂时：返结构化 JSON 含 `failing_test_id` / `stack` / `dom_snapshot`（UI 测）/ `response_body`（API 测）/ `suggested_fix_region: {file, line_start, line_end, why}` / `suggested_patch?: string`
   - MCP tool 返这块 JSON，由调用方（cc / Cursor）决定下一步

**支撑组件**：
- MCP server framework：`@modelcontextprotocol/sdk` (stdio transport)
- Docker 控制：`dockerode`
- 浏览器：`playwright`
- 状态：`better-sqlite3` → `~/.localsprite/db.sqlite`（run history、test results、dashboard）
- 验证 schema：`zod`

**架构 sketch**：

```
MCP client (cc/Cursor)
        │ stdio
        ▼
┌─────────────────────────────────────────────┐
│  src/mcp/server.ts                          │
│  ListTools + CallTool handlers              │
└──┬──────────────────────────────────────────┘
   │
   ├─ src/tools/bootstrap.ts          (tool 1)
   ├─ src/tools/codeSummary.ts        (tool 2)
   ├─ src/tools/prd.ts                (tool 3)
   ├─ src/tools/frontendPlan.ts       (tool 4)
   ├─ src/tools/backendPlan.ts        (tool 5)
   ├─ src/tools/generateAndExecute.ts (tool 6) ← 最重
   ├─ src/tools/dashboard.ts          (tool 7)
   └─ src/tools/rerunTests.ts         (tool 8)
        │
        ├─ src/engine/ccClient.ts         (claude --model X -p)
        ├─ src/sandbox/docker.ts          (start/exec/teardown)
        ├─ src/sandbox/browserPool.ts     (Playwright N 实例)
        ├─ src/state/db.ts                (sqlite)
        └─ src/types/                     (zod schemas)
```

## Expected Outputs

完工后存在的 artifacts：

1. `D:\lll\localsprite\package.json` 含 `bin: localsprite`，`npm install -g .` 后 `localsprite mcp` 起 MCP server
2. `dist/mcp/server.js` 真起 MCP server，stdio 双向通
3. 8 个 tool 全 implement + zod 校验输入
4. `~/.localsprite/db.sqlite` 自动初始化，含 `runs` / `test_results` / `code_summaries` 三张表
5. `scripts/smoke-localsprite.mjs` 端到端跑完一次：
   - 起 demo 应用（fixtures/demo-app，一个 Express + React）
   - 调 `bootstrap_tests` → `generate_code_summary` → `generate_standardized_prd` → `generate_backend_test_plan` → `generate_code_and_execute` → 看到 test_results.json 落地
6. `tests/` 下每个 tool 一份 vitest 单测 + 一份 MCP client smoke 测试
7. `docs/research/testsprite-mcp-surface.md` 完整（已写）
8. CHANGELOG / README（README 待用户批后写，不主动写）

## How To Verify

```bash
# 1. 单测全绿
cd D:/lll/localsprite && npm install && npm test

# 2. build 过
npm run build

# 3. 端到端 smoke
npm run smoke
# 期望末尾打印：
# ✓ bootstrap   OK
# ✓ summary     OK  (code_summary.json 大小 > 0)
# ✓ prd         OK  (standard_prd.json 含 user_stories[])
# ✓ backend plan OK (含 ≥3 test scenarios)
# ✓ execute     OK  (test_results.json 含 pass/fail)
# ✓ docker teardown OK (没残留 container)

# 4. MCP client smoke（独立脚本起 cc 真调一次）
node scripts/smoke-mcp-client.mjs

# 5. 跨引擎 1+2+3 验证
node scripts/probe-tool-list.mjs   # haiku 读源码列 tools
# vs subagent 黑盒列 tools
# vs 真起 server `tools/list` RPC
# 三方 jq -S byte-identical
```

## Probes (Gate 1+2+3 准备)

**Gate 1 — Fast haiku probe**：

```
claude --model haiku -p '读 D:/lll/localsprite/src/mcp/server.ts，
列出所有 MCP tool 的 name + 必填参数，返 JSON：
{"tools": [{"name": "...", "required_params": [...]}]}'
```

**Gate 2 — Subagent fresh context**：

```
派 general-purpose subagent：
"读 D:/lll/localsprite，列所有 MCP tool name + 必填参数，
返同 schema JSON。禁止读 docs，只读源码。"
```

**Gate 3 — Real run**：

```bash
node dist/mcp/server.js &
# stdio JSON-RPC: {"method":"tools/list"}
# 捕获响应，提取同 schema JSON
```

三 JSON 用 `jq -S` 后 byte-identical 才算 ship。

## Out of Scope（明确不做）

- Python / Go / Rust / Java 支持
- Cloud sandbox fallback
- 付费层 / API key 系统
- Web dashboard（dashboard tool 只返 trace viewer file:// URL 起步）
- 跨 repo 状态同步
- Concurrency > 1 个 user 项目（单实例单租户）
- 视频录制 / replay 流（trace viewer 够用）
- IDE extension UI（MCP 协议本身够）
- 主动 hook（用户保存 → 自动跑测）—— TestSprite 也不做，仿
- README / 营销页（等 v0.1 发布前再写）

## 风险登记

| 风险 | 概率 | 应对 |
|---|---|---|
| Docker on Windows 启动慢 / 占资源 | 高 | fail fast 报错让用户装 Docker Desktop；image 用 alpine + node:24-slim 双备选 |
| Playwright N 并发吃内存 | 中 | N 默认 3，可配；超时 5min 强制 kill |
| cc subprocess quota 烧太快 | 中 | tool 6 一次跑 cap 10 个 test case；超出让用户分批；用 haiku 做 plan 用 sonnet 做 codegen |
| MCP SDK API 跟我们想的不一样 | 低 | bootstrap 时先起个 hello-world server 验通 |
| TestSprite 改 API 我们不知 | 低 | research doc 标时间戳，季度 refresh |

## 下一步

用户 confirm 此 plan → 进 SPEC-SPLIT（4 个模块各一组 spec/surface/tests/comparison）→ teamwork 并行实现 → 1+2+3 → autoship。
