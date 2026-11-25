# 外部增强 Skills 分类与约束说明

本文件记录 Harness 核查并纳入管理的四项外部增强能力的归类依据、实际形态、同步策略与强制工程约束。机器同步脚本读取同目录的 [external-skills-catalog.json](external-skills-catalog.json)。

## 1. 核查结论与分类总览

### A. Rust 开发与质量增强（`rust-engineering`）

1. **BeautifulRust**（`https://github.com/morganlinton/BeautifulRust`）
   - 核查形态：上游仓库在 `skills/` 下提供 3 个标准 Agent Skills：`rust-best-practices`、`rust-review`、`rust-port`（附 `references/` 与 `evals/`），无额外二进制依赖。
   - 适用范围：全部 Rust 下游项目（`cli`、`mcp`、`gui`、`nsh`）。
   - 同步方式：新建项目与 Harness 工程升级时，自动从上游默认分支拉取最新提交并安装到 `.agents/skills/{rust-best-practices,rust-review,rust-port}/`。
   - 协同约束：与 Harness 的 `docs/ENGINEERING_RULES.md`（core-first、workspace 依赖下界、分层行数门禁、中文业务注释）同时生效；工程边界与项目规则冲突时以 Harness 规则为准。

2. **deslop-please**（`https://github.com/deterministic-machines/deslop-please`）
   - 核查形态：上游仓库**不包含** `skills/` 或 `SKILL.md`，而是基于 `rust-analyzer scip` 索引的 Rust 架构质量检查 CLI 工具，检查 `module-cycle`、`tangle`、`field-leak`、`shallow-module`、`wide-directory`、`long-file`。
   - 环境依赖：同时需要 `deslop-please` 可执行文件与 Rust 工具链的 `rust-analyzer` 组件。
   - 延迟安装策略：**延迟到项目创建时**由 `$desktop-check-development-environment` 的 `ensure_deslop_please.mjs --install-missing` 检查并安装到标准用户级 Cargo/rustup 位置；Harness 模板源维护期不安装。
   - 使用纪律：
     - 运行 `deslop-please` 检查 Rust 工作区结构腐化；
     - 告警必须从第一性原理修复（深模块、窄接口），禁止通过机械移动函数、空壳转发或滥用 `--allow` 隐藏问题；
     - `module-cycle` 与 `tangle` 先厘清抽象分层；`field-leak` 与 `shallow-module` 先整体收敛数据结构和调用模式；
     - 重构前绘制前后结构图向用户说明变化。

### B. UI 与前端设计增强（`ui-design`）

3. **taste-skill**（`https://github.com/Leonxlnx/taste-skill`）
   - 核查形态：上游当前将技能收拢在 `skills/taste-skill/`，其 `SKILL.md` frontmatter `name` 为 `design-taste-frontend`（包含 `assets/`、`library/`、`references/`、`scripts/`；其浏览器完成门禁需要 Node 22+ 与 Chrome/Edge/Chromium）。
   - 适用范围：仅含图形界面的下游项目（`gui`，或 `nsh` 且 `nsh-targets` 含 `desktop`、`mobile`、`web`）；纯 CLI、MCP 与纯 TUI 项目默认跳过，不安装无关前端视觉资产。
   - 同步方式：新建项目与 Harness 工程升级时，自动从上游拉取最新 `skills/taste-skill/` 并安装到 `.agents/skills/design-taste-frontend/`，同步写入旁注约束文件 `HARNESS-CONSTRAINTS.md`，绝不执行上游 `install.sh`。
   - 协同约束：图形界面视觉仍以 `docs/design_standards/ui_foundation.md` 为唯一共享基座；与上游前端营销页规则、字体/动效偏好或第三方示例风格冲突时，一律以 `ui_foundation.md`、框架专项标准与已批准产品设计为准。

### C. 跨语言向 Rust 迁移（`rust-migration`）

4. **rust-anything**（`https://github.com/erkamyaman/rust-anything`）
   - 核查形态：上游仓库在 `skills/rust-anything/` 提供 `SKILL.md` 与 `whole-app.md`，并配套独立 Rust CLI / MCP Server（`rust-anything`）。上游默认同时涵盖 FFI 桥接模式（`napi-rs`/`wasm`/`PyO3`/`C ABI`/`cgo`/`magnus`/`JNI`）与整应用重写模式。
   - 适用范围：全部 Rust 下游项目（`cli`、`mcp`、`gui`、`nsh`）。
   - 同步方式：新建项目与 Harness 工程升级时，自动从上游拉取最新 `skills/rust-anything/` 安装到 `.agents/skills/rust-anything/`，并写入旁注约束文件 `HARNESS-CONSTRAINTS.md`；配套 CLI/MCP 二进制仅在真正执行迁移任务时按需检查安装，不预装。
   - **纯 Rust 强约束（硬规则）**：
     - 使用 `$rust-anything` 将其他语言模块或应用迁移到当前项目时，**必须**产出符合当前 Rust 框架与项目架构的**纯 Rust 实现**（业务逻辑下沉至 `<project_id>_core`、依赖集中于根 `[workspace.dependencies]`、对外入口通过已选 `cli`/`mcp`/`gui`/`nsh` 薄适配器接入）；
     - **严禁**把兼容包装层、FFI 桥接层或外部语言运行时壳合入目标项目，包括但不限于 `napi-rs`、`PyO3`、`cgo`、`JNI`、`magnus`、C ABI 包装器、子进程调用原程序的薄壳，以及未完成 `lift` 的 `front-door` 回退层；
     - `rust-anything` 的行为录制、回放、差异比对和基准工具仅可用于迁移过程中的行为等价验证；最终交付必须完全移除对原语言源码、解释器、运行时与桥接胶水的依赖。

## 2. 同步安全与锁记录

- 同步脚本仅使用 Node.js 标准库和已门禁的 `git` 执行浅克隆读取，绝不运行任何上游 shell/Node 安装脚本。
- 同步落盘前校验无符号链接、无路径越界、无空洞目录，且保留上游 `SKILL.md` 原字节与上游 `LICENSE`。
- 每次同步把解析后的 40 位上游 commit SHA、仓库地址、适用接口、文件清单摘要和 Harness 叠加约束写入受保护的 `.harness/external-skills-lock.json`。
- 网络不可达或上游结构变化导致缺少 `SKILL.md` 时失败关闭，保留既有目录并明确报告阻断，绝不伪称已更新到最新。
