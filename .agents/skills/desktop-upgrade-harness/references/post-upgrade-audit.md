# 升级后置审计、结构重构与当前版本豁免

完成 Harness 工程层基线记录（`record`）、版本状态迁移、发布后动作核对及外部增强 Skills 同步后，必须在目标下游根依次执行以下三项后置闭环。这三项步骤绝不静默改写产品代码或依赖；所有变更与豁免均须经用户明确确认。

## 1. 依赖升级询问与遗留清理收窄

在目标根运行只读依赖与遗留清理盘点：

```text
node "<downstream-root>/.agents/skills/desktop-upgrade-harness/scripts/harness_upgrade_audit.mjs" deps --project-root "<downstream-root>" --source-root "<clean-harness-source-root>"
```

1. 向用户呈现盘点结果：可升级的 Rust crate 下界、npm 依赖范围、工具链 MSRV 漂移，以及检测到的遗留信号（已退役依赖、根 `[workspace.dependencies]` 未引用孤儿依赖、可由官方插件替代的旧代码如手写 `/usr/bin/open`、文档中失效的旧入口引用）。
2. 明确询问用户是否一并升级项目依赖（“一并升级依赖并同步清理收窄” / “暂不升级依赖”）。
3. **若用户选择一并升级**：
   - 按 `$desktop-manage-dependencies` 与 `$desktop-implement-change` 执行依赖升级与兼容验证（遵守当前项目 `dependency-lock-policy` 与 `compatibility-feedback.md`）。
   - **同步执行清理与收窄**：
     - **遗留旧代码**：删除已被新版官方生态/API 取代的旧兼容实现、手工子进程调用与死代码分支；
     - **遗留依赖**：从根 `Cargo.toml`、成员清单与 `package.json` 移除不再使用或已被替代的旧依赖，并将保留依赖的 features 收窄为最小集合；
     - **遗留能力**：移除已关闭或已退役能力残留的命令、ACL、配置项、i18n 键与资源文件（严格保留已批准现行产品能力）；
     - **遗留文档**：同步清理并收窄 `README.md` 与项目文档中的旧版本、旧依赖、旧命令和失效能力说明。
   - 运行本次依赖与清理直接影响的单元/回归测试，确认编译与行为正常。

## 2. 项目结构检测与最佳实践重构

在目标根运行只读项目结构最佳实践检测：

```text
node "<downstream-root>/.agents/skills/desktop-upgrade-harness/scripts/harness_upgrade_audit.mjs" structure --project-root "<downstream-root>"
```

检测范围覆盖 Harness 架构与结构最佳实践：
- Workspace 依赖集中化（成员 `Cargo.toml` 应通过 `workspace = true` 复用根 `[workspace.dependencies]`）；
- Core-first 依赖方向（复用 `check_core_first.mjs`）；
- Rust 多文件模块布局（必须采用 `<module>/mod.rs`，禁止 `<module>.rs` 与同名同级目录并存）；
- 前端模块高内聚与桶文件约束（禁止使用 `export *` 掩盖真实导出源）；
- 反模式兜底命名（`utils`/`common`/`helpers`/`misc`）与泛化命名提示（`manager`/`processor`/`handler`）；
- 单文件行数阈值（复用 `check_file_line_limits.mjs`）与 Cargo 全局 target 目录卫生（禁止项目级 `.cargo/config.toml` 重定向 `target-dir`，报告仓库内遗留 `target/`）；
- `.gitignore` 对开发过程中生成文件的自动覆盖情况（联动 `sync_gitignore.mjs`）。

对检出的结构问题列出清晰的重构方案；经用户确认后，委托 `$desktop-refactor-code` 与 `$desktop-implement-change` 按最佳实践执行**行为保持**的重构（不改变对外契约与可观察行为），并运行受影响的非空单元/回归测试。若项目已安装 `deslop-please`，可结合其分析辅助识别环依赖或状态泄漏，从第一性原理修复。

## 3. 升级结果综合验证与当前版本豁免（下次升级自动失效）

在目标根运行综合验证：

```text
node "<downstream-root>/.agents/skills/desktop-upgrade-harness/scripts/harness_upgrade_audit.mjs" verify --project-root "<downstream-root>" --source-root "<clean-harness-source-root>"
```

1. **旧豁免自动失效**：若目标存在 `.harness/upgrade-exemptions.json`，验证脚本会将其记录的 `harness_version` 与 `harness_commit` 同当前 `.harness/upstream-lock.json` 精确比对。只要 Harness 已升级到新版本或新提交，**所有旧豁免自动判定为 `expired`**（列入 `expiredExemptions`），不再隐藏任何发现，必须重新评估。
2. **逐项询问用户处理方式**：对 `unresolvedFindings` 中的每一项约束或风格不一致，逐项向用户呈现规则、路径、现状与修复建议，并提供两项明确选择：
   - **一并调整**：立即按 Harness 规则修改代码、配置、`.gitignore` 或文档并重新运行验证；
   - **记录当前版本豁免**：仅针对当前已升级的 Harness 版本与提交记录豁免原因，明确告知用户**该豁免将在下一次 Harness 升级时自动失效**。
3. **硬性边界不可豁免**：单文件硬行数超限（Rust >800 / 前端 >1000 / 文本 >2000）、core-first 依赖方向违规、符号链接/墓碑等安全硬门禁不允许写入豁免，必须修复。
4. **原子持久化豁免**：将用户逐项确认的豁免整理为 JSON 文件后，调用受管脚本原子写入受保护的 `.harness/upgrade-exemptions.json` 并重新运行 `verify` 复核结果：

```text
node "<downstream-root>/.agents/skills/desktop-upgrade-harness/scripts/harness_upgrade_audit.mjs" record-exemptions --project-root "<downstream-root>" --input "<confirmed-exemptions.json>"
```

豁免记录文件由所有权清单保持 `protected`，不进入升级候选或来源锁；报告升级完成时必须明确区分“全部通过”“带当前版本豁免通过（列出具体豁免及失效条件）”与“仍有待处理不一致项”。
