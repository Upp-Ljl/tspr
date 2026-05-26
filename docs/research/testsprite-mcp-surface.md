# TestSprite MCP — 接口表面扒皮报告

> 来源：docs.testsprite.com/mcp/core/tools, npmjs.com/package/@testsprite/testsprite-mcp, 公开宣传材料
> 日期：2026-05-26
> 用途：localsprite 的 mirror 实现基准。**只描述行为接口，不复制其源码**。

## 大背景

TestSprite 是 SaaS：MCP server 是个轻 stub，背后调云沙箱。安装：

```
npm install -g @testsprite/testsprite-mcp@latest
```

MCP 配置带 `API_KEY` 环境变量。我们 localsprite 不要这个——所有工作本地 Docker 完成。

## 8 个 MCP tool（按工作流顺序）

### 1. `*_bootstrap_tests`
**输入**：
- `localPort: number`（默认 5173，待测应用监听端口）
- `path?: string`（要测的特定路由，不经导航能到的）
- `type: "frontend" | "backend"`
- `projectPath: string`（绝对路径）
- `testScope: "codebase" | "diff"`

**输出**：next action 指令（环境检查、把"应用正在跑"这件事确认下来）

**作用**：会话入口，初始化配置。

### 2. `*_generate_code_summary`
**输入**：`projectRootPath: string`
**输出**：`code_summary.json`——架构分析、框架识别、feature 映射

### 3. `*_generate_standardized_prd`
**输入**：`projectPath: string`
**输出**：`standard_prd.json`——产品概览、user stories、功能与技术需求

### 4. `*_generate_frontend_test_plan`
**输入**：`projectPath: string`，`needLogin: boolean`（默认 true）
**输出**：`frontend_test_plan.json`——UI 交互、表单校验、导航、视觉回归场景

### 5. `*_generate_backend_test_plan`
**输入**：`projectPath: string`
**输出**：`backend_test_plan.json`——API endpoint、集成、DB、auth、错误处理

### 6. `*_generate_code_and_execute`
**输入**：`projectName: string`，`projectPath: string`，`testIds: string[]`（默认 []），`additionalInstruction: string`（默认 ""）
**输出**：测试代码文件、`test_results.json`、markdown / HTML 报告、bug 报告含 fix 建议

**这是最重的 tool**：生成测试代码 + 跑测 + 回报。

### 7. `*_open_test_result_dashboard`
**输入**：无
**输出**：dashboard 视图（历史 suite 结果、recording、步骤详情）

### 8. `*_rerun_tests`（beta）
**输入**：`projectPath: string`
**输出**：refined 结果、updated `test_results.json`、refined 报告

## 工作流闭环

```
1. bootstrap_tests        — 用户开局调
   ↓
2. generate_code_summary  — 扫 codebase
   ↓
3. generate_standardized_prd  — infer 测试目标
   ↓
4. generate_{frontend,backend}_test_plan  — 排测试场景
   ↓
5. generate_code_and_execute  — 写测试代码 + 跑 + 出报告
   ↓
6. 用户改代码（或 cc 看 fix 建议自己改）
   ↓
7. rerun_tests  — 再跑一遍
```

`open_test_result_dashboard` 是侧路 UI 入口，非主流程。

## localsprite mirror 决策

| 维度 | TestSprite | localsprite |
|---|---|---|
| tool 名 prefix | `testsprite_*` | `localsprite_*` |
| 沙箱 | cloud ephemeral | local Docker ephemeral |
| API key | 必需 | 不需 |
| 引擎 | 内部 LLM（疑似 GPT / 自研） | `claude --model X -p` subprocess |
| 数据持久化 | 云端 + dashboard | 本地 SQLite `~/.localsprite/db.sqlite` |
| dashboard | 云端 web UI | tool #7 返本地 file:// URL 或 localhost 静态页 |
| 接入覆盖 | Node/Python/Go… | MVP-0 只 Node/TS |

**接口形状对齐**：tool name 替换 prefix 后，参数 schema 与返回 artifact 文件名完全一致。目的是 client 互换（用户从 TestSprite 切 localsprite 不用改 prompt）。

## 反推空白

- **`generate_code_and_execute` 内部到底怎么"生成代码+跑"？**官方没说细节。我们的实现路径：起 Docker → 把 user 项目挂进去 → 调 cc 写测试代码进容器 → 跑 vitest/playwright → 捕获结果 → 回报。
- **`rerun_tests` 怎么知道上次跑了什么？**靠本地 SQLite 状态。
- **dashboard 长啥样？**官方截图见过：testcase list + step-by-step replay + 截图。localsprite 第一版给极简版（HTML 文件 + Playwright trace viewer 嵌入）。
- **"parallel agents" 怎么并行？**官方语焉不详。我们实现：N 只 Playwright headless 浏览器实例，每只一只 cc subprocess 驱动，分头点 UI，最后汇总 coverage。

## 法律边界

- ✅ 描述其 public API surface、mirror tool 名与参数 schema（functional interface，US Sega v Accolade、Oracle v Google 判例支持）
- ✅ 用我们自己代码实现同样行为
- ❌ 复制其源码、复制其文档原文、宣传时说 "compatible with TestSprite" 暗示官方背书
