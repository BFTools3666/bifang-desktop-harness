---
name: desktop-manage-external-skills
description: 分类管理并按接口同步外部增强 Skills（BeautifulRust、taste-skill、rust-anything）至最新上游版本，强制约束 rust-anything 产出纯 Rust 实现，并配合延迟安装的 deslop-please 结构检查规则。
---

# 管理外部增强 Skills

集中维护 Harness 引入的外部能力分类清单、叠加工程约束与上游最新同步入口。所有新建项目与 Harness 工程升级均通过本 Skill 的标准库脚本把适用的外部 Skill 同步到最新上游提交，并把精确来源与提交摘要记录在 `.harness/external-skills-lock.json`。

完整分类与强约束见 [外部增强 Skills 分类与约束](references/external-skills-constraints.md)，机器可读清单位于 [外部增强 Skills 清单](references/external-skills-catalog.json)。

## 分类与适用范围

| 分类 | 外部来源 | 形态与安装位置 | 适用项目接口 | 同步与安装时机 |
|---|---|---|---|---|
| Rust 开发与质量增强（`rust-engineering`） | [BeautifulRust](https://github.com/morganlinton/BeautifulRust) | 3 个上游 Agent Skill：`.agents/skills/rust-best-practices/`、`rust-review/`、`rust-port/` | 全部 Rust 项目（`cli`、`mcp`、`gui`、`nsh`） | 新建项目与每次 Harness 工程升级自动同步至最新上游 |
| Rust 开发与质量增强（`rust-engineering`） | [deslop-please](https://github.com/deterministic-machines/deslop-please) | 上游无 `SKILL.md`，为 Rust 架构质量 CLI（依赖 `deslop-please` + `rust-analyzer`） | 全部 Rust 项目（`cli`、`mcp`、`gui`、`nsh`） | **延迟到项目创建时**由 `$desktop-check-development-environment` 的 `ensure_deslop_please.mjs` 安装环境，不在 Harness 源维护期安装 |
| UI 与前端设计增强（`ui-design`） | [taste-skill](https://github.com/Leonxlnx/taste-skill) | 上游 `skills/taste-skill`（frontmatter `name: design-taste-frontend`）→ `.agents/skills/design-taste-frontend/` | 仅图形界面项目（`gui`，或 `nsh` 且 `nsh-targets` 含 `desktop`/`mobile`/`web`）；纯 CLI / MCP / 纯 TUI 跳过 | 新建项目与每次 Harness 工程升级自动同步至最新上游 |
| 跨语言向 Rust 迁移（`rust-migration`） | [rust-anything](https://github.com/erkamyaman/rust-anything) | 上游 `skills/rust-anything` → `.agents/skills/rust-anything/`（CLI/MCP 工具按需在真实迁移时安装） | 全部 Rust 项目（`cli`、`mcp`、`gui`、`nsh`） | 新建项目与每次 Harness 工程升级自动同步至最新上游 |

## 强制叠加约束

1. **`rust-anything` 纯 Rust 架构硬约束**：
   - 使用 `$rust-anything` 迁移或重写其他语言代码/应用时，最终落入当前项目的实现**必须**是符合当前 Rust 框架与项目架构（shared core-first、根 `[workspace.dependencies]`、所选 `cli`/`mcp`/`gui`/`nsh` 适配器边界）的**纯 Rust 实现**。
   - **严禁**产出、引入或保留任何包装兼容层、FFI 桥接层或原语言运行时壳（包括 `napi-rs`、`PyO3`、`cgo`、`JNI`、`magnus`、C ABI 包装器、外部进程回退壳或未完成 `lift` 的 `front-door` 代理层）。
   - 上游提供的行为录制/回放/对比能力仅可用于迁移期间等价性验证，不得作为兼容层保留到最终代码、依赖清单或构建产物中。
2. **`taste-skill`（`design-taste-frontend`）与共用设计基座关系**：
   - 图形界面视觉统一以 `docs/design_standards/ui_foundation.md` 为唯一共享基座；`$design-taste-frontend` 作为美学与交互增强补充，与共用基座、框架标准或已批准产品设计冲突时，一律以 `ui_foundation.md` 及已批准产品设计为准。
3. **`deslop-please` 第一性原理修复约束**：
   - 环境安装延迟到下游项目创建阶段执行，不预先安装在 Harness 模板源仓库维护期。
   - 遇到 `module-cycle`、`tangle`、`field-leak`、`shallow-module`、`wide-directory`、`long-file` 告警时，必须从抽象层次与深模块/窄接口出发根本重构，并在修复说明中绘制调整前后结构图；禁止通过机械拆分文件、空壳转发或滥用 allowlist 掩盖结构问题。

## 命令入口

本 Skill 使用 Node.js `>=24.0.0` 标准库脚本与已门禁的 `git`，绝不执行上游 `install.sh` 或未知脚本，也不引入第三方包。

只读检查当前项目适用的外部 Skill 分类、本地状态与锁记录：

```text
node .agents/skills/desktop-manage-external-skills/scripts/sync_external_skills.mjs inspect --project-root .
```

新建项目或 Harness 工程升级时，将全部适用外部 Skill 同步更新到最新上游提交（并写入 `.harness/external-skills-lock.json` 与旁注约束文件 `HARNESS-CONSTRAINTS.md`）：

```text
node .agents/skills/desktop-manage-external-skills/scripts/sync_external_skills.mjs sync --project-root .
```

在 Cargo 清单尚未写入或需要显式指定目标接口时，可传入 `--interfaces <csv>` 与 `--nsh-targets <csv>`（例如 `--interfaces cli,gui` 或 `--interfaces nsh --nsh-targets desktop,web`）。网络不可达、仓库拉取失败、缺少 `SKILL.md` 或检测到符号链接/越界路径时，脚本失败关闭并保留既有有效目录，不伪造“已同步最新”。

## 所有权与升级协同

- 本 Skill 自身（`SKILL.md`、`agents/openai.yaml`、`references/*`、`scripts/*`）属于 Harness `managed` 工程资产，随新建项目和 Harness 升级传播。
- 同步落盘的外部 Skill 目录（`.agents/skills/rust-best-practices/**`、`rust-review/**`、`rust-port/**`、`design-taste-frontend/**`、`rust-anything/**`）以及 `.harness/external-skills-lock.json` 在 `ownership-manifest.json` 中保持 `protected`，不参与静态三方源码覆盖；每次工程升级完成基线记录后，立即运行本 Skill 的 `sync` 更新至最新上游。
