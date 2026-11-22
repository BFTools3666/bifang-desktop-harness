---
name: desktop-test-nsh-initialization-e2e
description: 在 NSH 中性下游基线前执行非空 Rust/NSH 测试与已选目标的实际运行检查，完成后删除本入口。
---

# NSH 初始化真实检查

仅用于尚未裁剪或创建唯一基线的顶层 NSH 下游。先读 Cargo `nsh-targets`、具体目标平台和 [$desktop-add-nsh-adapter](../desktop-add-nsh-adapter/SKILL.md) 的运行时引用；只有选择 desktop 才读生成的 `docs/GUI_APP_PROFILE.md`。此门禁独立于候选 E2E 偏好，不作产品验收结论。

1. 复核 CLI `nsh 0.6.1 (2f51d86)` 与 Cargo 固定提交、项目本地两份官方 Skill 和 Cargo 实际解析的全局目标目录。用受管 npm 入口在当前系统运行非空 Rust workspace 测试（`npm run test`）、`npm run nsh:check` 和 `npm run nsh:test`。启用深链接时覆盖官方事件的启动与运行中交付。OS 注册另在目标系统实际验证。
2. desktop 仅对当前宿主已选的平台，用 `$desktop-build-nsh-release` 的 `local` 模式生成官方本机包，启动该次应用并通过 Computer Use 检查多窗口、新建/显示全部/关闭与最后窗口生命周期、应用菜单、双语、三态主题、窄屏、侧栏及条件支持页。已选托盘验证关窗隐藏、菜单恢复与退出；单实例验证二次启动；深链接在官方声明或注册后分别验证冷/热启动。不验证或启用中性模板未接入的自启、通知和 OS 全局快捷键。
3. TUI 运行项目 `nsh:test:tui`，在真实终端通过 `dev:tui` 确认可见内容、窄终端、Tab/Enter 进入设置、切换语言或主题、退出和终端恢复。无需伪造打包步骤。
4. 构建非本机目标前，确认用户明确指定本次的 Web、Android、iOS 或 iOS 模拟器产物。持久目标声明只提供支持范围。Web 通过 `local --target web` 构建官方静态站点，在本机浏览器检查实际包、窄屏、设置及主题。移动在实际运行目标系统的模拟器或设备中检查导航、安全区、语言和主题，注明真实设备与运行环境。组合项目通过受管打包入口隔离桌面窗口和协议声明。
5. 还原本次验证改动的偏好与宿主注册。精确报告已测与未测宿主、可观察结果及不能完成的门禁；未执行的桌面能力、设备或终端行为不能记作通过。

裁剪预览所需的 `unitTests` 引用绑定非空 Rust 与 NSH headless 结果。desktop 提供 `nshDesktopPackage` 和 `nshDesktopRun`，mobile 提供 `nshMobileRun` 并注明本次真实运行的移动平台和设备类型，Web 提供 `nshWebPackage` 和 `nshWebRun`，TUI 提供 `nshTuiTests` 和 `nshTuiRun`。缺少适用系统或必需运行环境时，在对应系统完成检查后再提交证据。同一工作区摘要绑定所有引用。
