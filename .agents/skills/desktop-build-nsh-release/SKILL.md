---
name: desktop-build-nsh-release
description: 独立构建 NSH 桌面、Android、iOS、Web 包；区分本地工程试包与 clean 已发布源码候选。
---

# 构建 NSH 包

仅适用顶层 `interfaces = ["nsh"]`，并读取 `nsh-targets` 与具体 `target-platforms`。先读 [候选共用流程](../../../docs/RELEASE.md#git-发布后构建与完整验收)、[Agent Policy 构建段](../../../docs/AGENT_POLICY.md#开发与构建) 与 [NSH 运行时合同](../desktop-add-nsh-adapter/references/runtime-and-capabilities.md)。仅打包 desktop/mobile/web 对应的已选平台；TUI 没有官方打包目标。全局 `nsh` CLI 与项目根 Cargo 的 `nsh-core` 与所有已声明的 NSH Git 依赖须使用运行时引用列出的同一正式版本及提交，`nsh --version` 须显示相同版本及短 SHA；不自动下载工具，不运行原移动客户端脚本。旧版或旧 GUI/NSH 工程须先按运行时合同迁移。

- `local`：允许未发布源码，在当前宿主执行非空 workspace 测试、NSH 检查与 headless 渲染测试后，把试包写入忽略的 `.nsh/packages/`。此流程不安装应用或执行候选 E2E。
- `candidate`：`$desktop-manage-version check --phase build`（构建不得提升版本）、clean 已发布默认主分支/tag/上下文及双语日志。按候选共用流程在构建前解析本次 E2E 选择。候选形成后，将 `target` 和 `buildRun` 交给 [$desktop-verify-delivery](../desktop-verify-delivery/SKILL.md) 执行已选 E2E、硬性验收或用户明确要求的完整验收。单独构建且 E2E 关闭时记录 `Not run`、原因和剩余风险，候选保持 `pending`。

本地试包将 `HARNESS_RELEASE_CHANNEL` 设为 `dev`。候选将已验证的 `releaseChannel` 传给测试与打包进程并写入 manifest。Beta 在打包副本给展示名和启动标题加 ` Beta`，给应用 ID 加 `.beta`；程序文件名由官方打包器按平台从名称派生。生成的应用使用 `appInfo()` 的实际名称与 ID 为双语标题保留 Beta 后缀。已有下游若自行设置窗口标题，在准备发布的开发提交中先把动态标题迁移到这一路径。

```sh
node .agents/skills/desktop-build-nsh-release/scripts/build_nsh_release.mjs --root . --mode local
node .agents/skills/desktop-build-nsh-release/scripts/build_nsh_release.mjs --root . --mode candidate --target web --e2e enabled
```

helper 接受 `--root <根> --mode local|candidate [--target macos|windows|linux|android|ios|ios-simulator|web] [--e2e enabled|disabled]`。省略目标时，仅构建当前宿主已选的桌面平台及本机架构，缺少适用目标就停止。Android、iOS、Web 和非本机 macOS 架构必须由用户明确提出，分别通过 `--target` 或 `--arch` 选择。目标必须属于持久平台及对应 desktop/mobile/web 分类，iOS 模拟器属于 ios。桌面构建只在对应宿主，iOS 构建只在 macOS。移动 SDK、Rust wasm target、LLVM、JDK/Android SDK/NDK 均由实际失败后按环境流程恢复。

用 Cargo 元数据核对本次工作区与系统配置解析到同一全局目标目录。Rust workspace 测试直接沿用该配置，并通过 `--target host-tuple` 选择本机。NSH 0.6.1 的 Mixed 运行器通过 `CARGO_TARGET_DIR` 获取目录，缺省时会写到应用内。如果只有 Cargo 全局文件设置了 `build.target-dir`，受管入口把 Cargo 已解析的同一目录转交给 NSH 子进程。NSH 内部 Cargo 调用要求 `build.target` 和 `CARGO_BUILD_TARGET` 保持宿主默认。试包存放于 `.nsh/packages/`，Rust 编译缓存沿用全局目标目录。

新 NSH 的 desktop、mobile、Web 均走官方 `nsh package`；TUI 只支持官方运行与测试，0.6.1 没有 TUI 打包目标。组合工程先复制工作区布局，保留 Mixed 入口、Cargo 相对路径、图标与静态资源，然后从副本中移除桌面窗口配置、桌面权限、单实例和模板恢复协议。macOS 形成 ad-hoc 签名 `.app` 和 `application.tar.gz`；Windows 形成应用目录及 zip；Linux 形成应用目录及 tar.gz。深链接使用官方包声明或应用注册。Android APK 默认开发签名；iOS 模拟器 ad-hoc app、设备未签名 app；Web 输出完整静态目录。Android AAB、iOS IPA 与渠道签名使用官方打包参数。渠道上传单独执行。

生成到唯一暂存目录，测试后、打包后复核源码与资源快照，拒绝中途漂移与覆盖旧批次。完整 `buildRun` 为 `nsh-<target>-<uuid>`。macOS 和 Windows 正式候选将最终包和各自的 `.sha256` 放在 `release/` 根，文件名含应用名、版本和 buildRun，过长的名称前缀按文件系统上限预留空间。清单、`release-notes.json`、双语许可证和 JUnit 保存在 `release/.nsh-evidence/<buildRun>/`。同盘独占落位后重算实际制品与摘要，最后原子提交该证据目录；中途失败只撤回本次已落位文件。构建展开目录在保全最终包和证据后移除。其他 NSH 正式目标沿用 `release/<buildRun>/`，本地试包沿用 `.nsh/packages/`。

关于页的“更新日志”按钮展示编译进应用的双语内容。helper 先从已校验的 schema v2 根日志按最新在前、两类各最多十条渲染到暂存文本，再用 `HARNESS_RELEASE_NOTES_ZH_PATH` 与 `HARNESS_RELEASE_NOTES_EN_PATH` 两个短路径通知 NSH 适配器的标准库 `build.rs` 复制到 `OUT_DIR`，Rust 通过 `include_str!` 嵌入。本地试包写入无已发布日志占位。外层 sidecar 按实际字节绑定根日志。实际窗口内的展示由适用的最终 E2E 取证。manifest 记录文件摘要、源码、工具版本、目标、签名边界和 E2E 选择，正式候选初始 `milestoneAcceptance: pending`、`runtimeVerification: Unverified`。

通用 Git 发布由 [$desktop-prepare-release](../desktop-prepare-release/SKILL.md) 完成本地 merge/tag。因冻结的 `local_package` 调用时，先通过 [$desktop-switch-post-release-action 的已发布快照路由](../desktop-switch-post-release-action/SKILL.md#按已发布快照路由)，以返回的 `target` 调用 `candidate`。远程构建须另行复核已推送的渠道分支和 tag。

NSH 正式 0.6.1 生成的 runtime workspace 尚未验证可传递 `--locked`；当前 helper 对 dependency-lock-policy=tracked 在任何编译前失败关闭。默认 ignored 保持正常解析；不得私自修改项目锁策略。

打包返回 `target`、`buildRun`、`bundleFormat` 和 manifest 路径，平铺候选还返回 `deliveryFiles`。验收按同一目标与批次取件。macOS 支持 `--arch arm64|x86_64|universal`。Windows 主包为官方 ZIP。官方打包器生成 Inno 安装器时，同批 `-setup.exe` 及其摘要也直接落在 `release/`。Linux 主包为官方 tar.gz。Android 支持重复 `--abi` 与 `--format apk|aab`，未提供签名材料时使用调试密钥。经本次签名授权后，可传 `--keystore` 与 `--key-alias`，密码从 `NSH_KEYSTORE_PASSWORD` 注入。iOS 经本次签名授权后传 `--sign` 和 `--profile` 生成 IPA，模拟器独立使用 `--target ios-simulator`。Web 支持 `--asset-url` 指定静态资源地址。manifest 记录实际签名类型、Android ABI 和应用 build 编号。

已有项目自行编译或替换 runner 时，按[自定义原生运行器](../desktop-add-nsh-adapter/references/runtime-and-capabilities.md#自定义原生运行器)核对 TSX 模块所需 feature 和最终包的正常启动。

候选显式关闭 E2E 时同时传 --e2e-reason 与 --e2e-risk，分别记录本次原因和剩余风险。即使明确指定跨目标产物，构建前的 Rust 与 NSH headless 测试均从当前宿主执行，且不传打包目标给测试。打包要求官方 JUnit 中至少有一项实际通过的 TSX 测试。headless 平台输入属于共享 UI 回归，目标系统运行验收须另在实际运行环境取证。

iOS 展示名兼容：官方 CLI 将展示名过滤成 ASCII 执行文件名；结果忽略大小写等于 nsh 时，会与包内 nsh 资源目录冲突。helper 只为该情形使用临时内部名称，恢复原始 CFBundleName/CFBundleDisplayName 与 app 目录后，模拟器重新 ad-hoc 签名并严格验证；未签名设备 app 同样恢复展示名。需要签名 IPA 时使用不触发上游名称冲突的展示名。

iOS Mixed 打包时，helper 用 `xcrun` 解析对应 Xcode SDK，为 QuickJS bindgen 补充该 Rust 目标的 sysroot。显式 sysroot 优先，宿主测试与其他打包目标使用各自的环境。
