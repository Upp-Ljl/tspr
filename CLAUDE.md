# localsprite — Claude 项目说明

> 给未来 Claude 会话用。仓库特定的坑与本地约定写这里。

## localsprite 是什么

**localsprite = TestSprite 的本地 MCP 平替**。原则：能抄全抄，效果对齐为准，速度可以慢，只要本地修改效果。

- **形态**：MCP server（任何兼容客户端都能调：Claude Code、Cursor、VS Code、Windsurf、Trae…）
- **测试沙箱**：本地 Docker ephemeral container（不是云端，不是 worktree）
- **不持 API key**：跟 d2p 同源——`claude --model X -p` CLI 子进程
- **第一版覆盖面**：Node.js / TypeScript only（FE：React/Vue/Svelte；BE：Express/Fastify/Next）
- **入口姿势**：仿 TestSprite——用户主动 MCP tool call，非后台自动跳
- **Auto-patching 姿势**：仿 TestSprite——返结构化 failure + suggested fix，让 cc/Cursor 自决是否 apply

**不是**：SaaS / 云沙箱 / Cursor 插件 / 通用 multi-agent / 直调 Anthropic API / 跨语言通吃。

## 8 个 MCP tool（mirror TestSprite surface）

参 `docs/research/testsprite-mcp-surface.md`。第一版目标是接口形状对齐，client 写好之后能 swap base URL 切换。

## 当前阶段

**MVP-0**：详 `docs/plans/2026-05-26-localsprite-mvp0.md`。

## Agent Work Rules

继承 d2p CLAUDE.md 全套 8 站台 + 3 安全网，路径替换为 localsprite 本地路径。要点不重复，参 `D:\lll\d2p\CLAUDE.md` "Agent Work Rules" + "Workflow Discipline" 两节，全量适用。

特有差异：
- **新 MCP tool = 新用户面**：同 PR 必带 auto-runnable test（vitest 单测 + 真起一只 MCP client 调一次的 smoke）。违反 `surface_without_self_test` 红线。
- **Docker 依赖问题**：用户机器没装 Docker = 我们 fail fast 报错让他装。第一版不做 fallback。
- **MCP 接口仿写**：tool 名同 TestSprite（`localsprite_bootstrap_tests` etc.），parameter shape 同。这是 functional interface，非 copyright 保护对象，目的是 interop。

## 风格约定

继承 d2p：中文对话，英文代码/路径/commit，conventional commits，不加 Co-Authored-By trailer。

## 项目坐标

- **本地路径**：`D:\lll\localsprite`
- **姊妹项目**：`D:\lll\d2p`（独立 repo，独立 roadmap）
- **主分支**：`main`
- **测试命令**：`npm test`
- **dogfood / smoke**：`node scripts/smoke-localsprite.mjs`
- **plans**：`docs/plans/YYYY-MM-DD-<slug>.md`
- **research**：`docs/research/`
- **SPEC-SPLIT artifacts**：`docs/details/<NN>-<slug>-{spec,public-surface,tests,comparison-report}.md`

## 环境

- **OS**：Windows 11
- **Shell**：PowerShell + bash via Bash 工具
- **路径风格**：Read/Write 用绝对 Windows 路径

## 跟 d2p 共享什么 / 不共享什么

**共享**：workflow discipline、cc subprocess 模式、Docker / worktree 知识、reviewer pipeline 设计思路。
**不共享**：repo、release cycle、产品定位、package.json、SQLite schema。
