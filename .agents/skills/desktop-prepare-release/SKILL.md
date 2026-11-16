---
name: desktop-prepare-release
description: 整理并验证当前源码，提交发布元数据，合并本地默认主分支并创建版本 tag；随后执行已确认的发布后动作。
---

# 准备并完成 Git 发布

维护 helper 只使用 Node.js `>=24.0.0` 标准库。明确“发布”授权本次已复核源码的必要提交、普通合并、本地版本 tag 和精确复核。本地默认主分支和版本 tag 指向同一最终提交后，Git 发布即结束；该命令不访问远端、不推送、不打包、不删除登记资源。完成初始化的下游在发布开始时把 `docs/AGENT_POLICY.md` 中已确认的 `post_release_action` 冻结到 Git common-dir 生命周期记录，发布后按该次冻结值完成所选路径及实际结果复核；该选择是未来发布后对应动作的持久授权。Harness 源的 `pending` 是待复制模板字段，其源码归档或推送仍由用户在当次发布后决定。

## 正式发布流程

1. 读取 `docs/RELEASE.md`、版本事实源、最新 Product Spec 和本次真实触发的 Changelog/Verification。用 `$desktop-manage-git-lifecycle inspect` 精确核对登记分支、Worktree、上次发布与未完成 journal。根同时包含 Harness `Version.md` 和活动 `$desktop-instantiate-project` 时按 Harness 源处理，否则按已初始化下游处理。任何正在进行的旧双模式发布不能静默改作单一路径。
2. 完成初始化的下游在任何发布写入前解析当次 `releaseChannel`。用户已明确时复用，否则以可点击单选呈现 Release（`release`）和 Beta（`beta`），等待明确选择。下游日常开发为 `dev`，同次发布重试读取已冻结的渠道。Harness 源沿用固定的 `release` 分支，跳过渠道问询。随后解析当次 `reviewSelection: enabled | disabled`：当前请求已明确时复用；安全、隐私、不可逆操作、对外兼容契约或产品/渠道硬要求强制启用；否则询问一次。同一发布重试复用审查结论，新发布重新解析。完成初始化的下游此时还须确认 `post_release_action` 为 `local_package` 或 `push_release_branch`；缺失、非法或 `pending` 时先由 `$desktop-switch-post-release-action` 补选，不推断默认值。Harness 源允许模板字段为 `pending`，不调用只适用于下游的切换 Skill。E2E 与 macOS 签名仍由适用打包 Skill 按本次构建解析。
3. 要求独立 Git 顶层目录和真实 HEAD。执行 `node .agents/skills/desktop-prepare-release/scripts/release_git.mjs inspect --project-root .`，逐项复核 staged、unstaged、untracked 与真实 diff，排除秘密、未完成范围、缓存和归属不明文件。分支名和历史形状不构成额外门禁；快照的 branch/HEAD/statusSha256 用于防止复核后漂移。
4. Harness 只在本次正式发布开始且完成前述复核后运行 `node .agents/skills/desktop-prepare-release/scripts/harness_version_clock.mjs stamp --project-root .`，以当前 `Asia/Shanghai` 年月日时分直接写入 `Version.md` 的唯一版本字段。同一分钟无法产生新版本就等待下一分钟；重试复用已写入目标，不再次取号。将同一版本同步到 README、最新 Product Spec 与 `docs/RELEASE.md`，把本次已包含变化的 `required_version = pending` 物化后运行 `node scripts/validate_harness.mjs`，再复核全部待提交路径。下游只运行 `$desktop-manage-version check --phase release`，使用开发阶段已完成并通过相关测试的目标版本；发布准备不补算 Minor/Patch、不绕过记录纠错门禁。
5. 紧邻实际提交调用 `$desktop-configure-git-commits`，仅补仓库 local 身份和提交模板。用复核的 `statusSha256` 与 literal `--path` 清单调用 `release_git.mjs commit` 提交源码/治理变化及已独立触发的 Changelog；正常运行 hooks，不使用 `--no-verify`。clean 且无源码变化时不创建空提交。提交后的 clean HEAD 是 `sourceHead`；此后不得补写 Changelog。
6. 按 `reviewSelection` 对上次真实发布提交到 `sourceHead` 的累计差异形成 `releaseReview`。启用时检查行为、core/adapter 边界（由 `$desktop-review-core-boundaries` 承接）、对外契约、职责与规模、临时标记，Harness 另运行 `node scripts/validate_harness.mjs --release-review`，通过后记录 `passed`、五项固定检查和绑定 `sourceHead` 的摘要；关闭且无硬要求时记录 `Not run`、原因与剩余风险。范围、秘密、必要测试和 clean 检查始终执行。
7. 从上次真实发布到 `sourceHead` 的差异，按下方 [更新日志撰写](#更新日志撰写) 整理双语 `release-notes.json`，保留包含当前发布版本在内的最近 10 个实际发布版本。每版“功能优化”和“问题修复”各最多 10 项，合计至少一项。写入前并排核对每项 `zh-CN`、`en-US` 的含义、适用范围和数字。运行 `release_notes.mjs upsert` 写入，随后交 `$desktop-inspect-release-notes` 执行 `check --expected-version` 和两个 locale 的 `render`，并并排核对结果。日志是源码发布元数据；本步骤不创建候选或修改 Changelog。
8. 读取并复核本地默认主分支，使用同一版本、发布日期、`sourceHead` 和审查结果写入发布上下文。下游必须传 `--channel <release|beta>`，写入 schema v4。Harness 源省略该参数，沿用 schema v3：

   ```text
   node .agents/skills/desktop-prepare-release/scripts/release_context.mjs write --project-root . --source-head <sourceHead> --version <version> --release-date YYYY-MM-DD --default-branch <defaultBranch> [--channel <release|beta>] --review-selection <enabled|disabled> --scope-base <oid> --scope-diff-sha256 <sha256> <review arguments>
   node .agents/skills/desktop-prepare-release/scripts/release_context.mjs check --project-root . --expected-version <version> --expected-sha256 <releaseContextSha256>
   ```

   上下文只冻结版本、日期、默认主分支、预期 tag、源码身份与审查结论，下游另冻结发布渠道；不保存推送模式、远端、候选签名或打包选择。`write` 拒绝当前 HEAD 不等于 `sourceHead`。重新运行 `release_git.mjs inspect`，把且只把 `release-notes.json` 与 `.harness/release-context.json` 放入同一发布元数据提交；不得混入源码、Changelog 或其他治理文件。
9. 要求工作树 clean，并把上下文精确 SHA-256 传给单一路径生命周期命令：

   ```text
   node .agents/skills/desktop-manage-git-lifecycle/scripts/git_lifecycle.mjs release --project-root . --version <version> --date YYYYMMDD --release-context-sha256 <releaseContextSha256>
   ```

   helper 在任何合并或 tag 副作用前核对 tracked 上下文；从关联 Task Worktree 发起时先核对调用 Worktree 的 HEAD blob 和工作字节，再路由主 Worktree。合并登记分支得到最终 HEAD 后再次核对该提交中的上下文 blob。它只切换本地默认主分支、普通合并、创建或复用同名且指向最终 HEAD 的轻量 tag，并复读本地两条 ref；同名 tag 指向其他提交时停止。失败重试沿用冻结 HEAD，不吸收新变化。
10. 生命周期成功后锁定最终 40 位 `sourceCommit`，运行 `release_context.mjs verify --project-root . --expected-version <version> --expected-sha256 <releaseContextSha256> --expected-head <sourceCommit>`。要求 clean 本地默认主分支、该分支 HEAD、本地预期 tag 和上下文均精确一致。`sourceHead` 是审查输入，`sourceCommit` 是合并后的发布提交，两者不要求相等。此时报告 `Released` 并结束 Git 发布；不以远端、源码归档、产品候选或渠道分发判断完成。
11. 完成初始化的下游在发布后读取生命周期记录里该次冻结的 `postReleaseAction`，执行并检测后续路径；旧发布没有冻结值时保留 Git `Released`，并报告缺少可恢复动作。`local_package` 按 [$desktop-switch-post-release-action 的已发布快照路由](../desktop-switch-post-release-action/SKILL.md#按已发布快照路由) 解析唯一候选并复核实际结果。`push_release_branch` 按 [$desktop-manage-git-lifecycle](../desktop-manage-git-lifecycle/SKILL.md#命令) 运行 `push-release --remote <name>` 并复核目标引用。Harness 源按用户当次决定处理源码归档或使用同一 `push-release` 命令。Git 发布事实保持 `Released`，整个下游发布后流程只有所选路径实际通过才算完成。下游下一次开发在新 feature 分支按 [$desktop-manage-version](../desktop-manage-version/SKILL.md) 复核主分支/tag 并执行 `finalize-release`，再分类新改动。

## 更新日志撰写

- 围绕本版实际交付的内容，按读者要完成的任务组织条目。用发布范围内的真实差异核对变化，结合实际用法、测试或测量记录确认正文。合并同一场景中的相关变化，优先写影响较大的结果。正文使用日常语言和用户实际看到的名称，省略线程、内部接线、数据库结构等实现细节，以及没有可确认用户影响的内部改动。
- 新增或改进功能时，说明用户现在能做什么、在哪种场景下用得上。需要用户操作时，写明真实入口和关键步骤。修复问题时，写清在哪种操作下会遇到什么问题，以及更新后会怎样。平台、使用条件或限制会影响读者判断时，一并说明。
- 性能优化写具体场景和实际改善，例如打开某个页面的等待时间缩短，或批量处理时内存占用降低。有相近设备、环境和负载下的前后实测时，给出变化量或经合理取整的百分比，并简述适用条件。只有定性证据时，只写已确认的体验变化。缺少证据时，省略数字及未经确认的性能主张。
- 写入前确认每项功能、使用方法、修复结果和量化收益都有依据。若筛选后没有可证实的条目，说明原因，避免使用笼统表述或虚构收益填补条数。

## 边界

- Harness 的正式取号在 Git common-dir 保存受管凭证，绑定取号时间、版本和 `Version.md` 精确字节；发布上下文写入与生命周期 `release` 均须在副作用前复核，手填时间版本不得替代取号。
- 登记分支合并得到最终 HEAD 后、创建 tag 前须再次复核版本事实：Harness 的最终 `Version.md` 与取号凭证一致，下游 Cargo 当前版本与受保护周期目标等于上下文版本；后继分支覆盖版本时失败关闭。
- `reviewSelection: enabled` 时，审查输入 `sourceHead` 须包含本周期每条登记分支的当前 HEAD；有尚未纳入的分支，应先在本地普通整合、重新复核和提交源码，再形成审查与发布上下文。生命周期合并后须证明最终 HEAD 相对 `sourceHead` 只改变 `release-notes.json` 和 `.harness/release-context.json`，并复核这两份元数据的冻结字节；允许合并提交身份变化，但拒绝未审查源码或冲突解决差异进入已标记 `passed` 的发布。
- 已发布 tag 绝不移到另一提交；同名 tag 精确命中可幂等复用。不得编造提交、tag、摘要、候选或验证结果。
- 发布准备不运行构建、冒烟或 E2E。Harness 中性资产和验证器测试须在进入发布准备前通过；终端下游真实候选的全量测试、签名与验收在另行请求的候选构建及验收流程执行。
- 发布后动作只授权 `post_release_action` 已选的本地打包或所选渠道分支推送，不授权配置 remote/凭据、force push、历史改写或删除未登记资源。候选验收、上传和渠道分发仍是独立事件；打包路径仍遵守当次候选构建的适用选择与硬要求。
