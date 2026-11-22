# NSH 0.6.1：运行时、目标与能力

Harness 受管 NSH 入口仅支持 [官方 v0.6.1](https://github.com/longbridge/nsh/releases/tag/v0.6.1)。Cargo 依赖固定 Git 提交 `2f51d8611677c8a6bbad937b39756e8d0cc45350`，匹配 CLI 为 `nsh 0.6.1 (2f51d86)`。官方安装器支持 `NSH_VERSION=v0.6.1`，平台运行时按 CLI 同版本安装组件。详见[安装](https://github.com/longbridge/nsh/blob/v0.6.1/website/docs/installation.md)。

旧版工程须先在原项目迁移，再使用当前 Harness 的受管开发、工程升级或构建。根 Cargo 须声明 `interfaces = ["nsh"]`、`nsh-targets` 和具体 `target-platforms`，使用 `<project-id>_nsh` Mixed 成员。工作区声明及成员使用的 NSH 依赖都须匹配官方固定版本与提交。

| `nsh-targets` | `target-platforms` | 官方运行与打包 |
| --- | --- | --- |
| desktop | Windows、macOS、Linux | `nsh run`；对应平台上的 `nsh package --target macos\|windows\|linux` |
| mobile | Android、iOS | `nsh run --target android\|ios`；Android APK/AAB，iOS 模拟器或设备 app；正式 IPA 使用显式签名身份与描述文件 |
| web | Web | `nsh run --target web`；`nsh package --target web` 输出静态站点 |
| tui | Windows、macOS、Linux 的终端 | `nsh run --target tui`、`nsh test --target tui`；0.6.1 没有 TUI 打包目标 |

TUI 和 desktop 并选时系统集合去重；仅 TUI 不询问桌面 profile 或 Logo。TUI 是 NSH 子目标，使用同一 Mixed UI、共享 core、键盘焦点及终端 Cell 布局。用 `platform.idiom === "terminal"` 区分终端；`platform.os` 仍是宿主系统。图形侧栏、托盘、窗口和移动状态栏不用于终端。用 [TUI 指南](https://github.com/longbridge/nsh/blob/v0.6.1/website/docs/tui.md) 验证窄终端、Tab/Enter、退出与终端恢复。各目标脚本按实际平台选择 `App.test.tsx` 运行共享回归；`App.platform.test.tsx` 中的宿主模拟由无目标参数的 headless 套件执行。专属测试可以直接将测试文件路径传给 `nsh test`。

Mixed 成员的 `nsh.json` 设置 `rust: "."`，不设置 `root`。Rust 桥接只依赖共享 core 和 `nsh-core`，官方 CLI 生成的运行器为 TSX 提供 `nsh/base`。Rust 后续直接使用 `nsh_base` 组件时，再按相同 Git 提交声明该依赖并选择所需 feature。[Mixed 运行器源码](https://github.com/longbridge/nsh/blob/v0.6.1/crates/nsh-cli/src/rust_app.rs)

生成新项目时，适配器把官方 v0.6.1 的 [NSH 开发 Skill](../assets/vendor/nsh/SKILL.md) 和 [NSH 设计指南 Skill](../assets/vendor/nsh-design-guides/SKILL.md) 原样安装到项目的 `.agents/skills/`，保留引用与 Apache 许可证。初始化使用模板随附副本，不依赖 npm 或用户目录的全局 Skill。下游开发读取匹配当前运行时版本的 `.agents/skills/nsh/SKILL.md`，界面设计读取 `.agents/skills/nsh-design-guides/SKILL.md`。

| 桌面能力 | 0.6.1 模板接线 |
| --- | --- |
| 多窗口与应用菜单 | `nsh/desktop` 的 `Window.open`、`currentWindow`、`windows`、`Menu`、`Application.quit`。桌面声明 `capabilities.application: true`，`windows` 只授予普通窗口和层级。主窗口拥有应用菜单，各窗口拥有独立页面状态。 |
| 托盘 | 选中才调用 `Tray.set`，主窗口关闭请求改为隐藏，托盘恢复或新建窗口，显式退出走 `Application.quit`。 |
| 单实例 | 选中才在 `nsh.json` 声明 `singleInstance: true`；Windows/Linux 打包应用由 NSH 处理再次启动；macOS 复用 Launch Services 的应用包行为。 |
| 深链接 | 仅 desktop 且启用单实例时声明 `schemes`，通过 `UrlScheme.on("open")` 处理；本模板只消费固定恢复 URL，无业务导航。 |
| 自启、通知、全局快捷键 | 中性模板的三项固定关闭。官方 `Application.launchAtLogin()` / `setLaunchAtLogin()` 用于可独立安装的应用，验证登录项时使用真实打包宿主。通知和全局快捷键也按产品需求及平台能力接入。 |

桌面以[官方桌面模块](https://github.com/longbridge/nsh/blob/v0.6.1/website/modules/nsh-desktop.md)和 [URL Scheme](https://github.com/longbridge/nsh/blob/v0.6.1/website/modules/nsh.md#urlscheme)为准。由官方打包器产生声明，Windows/Linux 由官方应用注册；真实冷/热启动另在相应 OS 验证。移动的状态栏使用 `statusBar.foreground = "auto"` 和 `capabilities.statusBar = true`。组合工程打移动/Web 包时复制临时工作区布局及应用资源，移除桌面窗口配置、`windows` / `application` 权限、单实例和模板生成的恢复协议，保留显式权限对象与产品自有协议。

## 自行迁移到 0.6.1 时

从 0.5.x 或更早版本迁移时，显式声明 `capabilities` 的应用须复核 0.6.0 增加的两项权限。拥有桌面主窗口、应用菜单、托盘或退出等能力时授权 `application`，确实读取 `os.homedir()` 时授权 `homeDir`。同时检查 `maxLength` 字符计数、iOS 剪贴板拒绝、WebView 下载事件等变化。0.6.1 修正 Apple 平台的最低部署版本和 iOS 嵌入链接，并对使用 Rust 资产宏却缺少对应 SVG feature 的工程提供编译诊断。模板的托盘 SVG 由 TSX 导入，由官方打包器按可达资源选取 feature。[权限参考](https://github.com/longbridge/nsh/blob/v0.6.1/website/docs/sandbox-and-capabilities.md) · [0.6.0 迁移说明](https://github.com/longbridge/nsh/releases/tag/v0.6.0#breaking-changes) · [0.6.1 发行说明](https://github.com/longbridge/nsh/releases/tag/v0.6.1)

模板仅依赖项目 Rust core、官方 `nsh-core` 和 CLI 提供的官方 TSX 模块。移动端保留现有主题化底栏；产品想采用 iOS 和 Android 各自的原生顶层导航时，可选择 `nsh/mobile` 的 `TabBar`，在对应系统验证挤压、语言、主题和安全区。关于页使用 `nsh/base` 的 `Collapsible` 展示随应用嵌入的离线双语日志。远程更新由产品独立选用官方 updater，并明确配置渠道和权限。[移动模块](https://github.com/longbridge/nsh/blob/v0.6.1/website/modules/nsh-mobile.md#tabbar) · [更新器](https://github.com/longbridge/nsh/blob/v0.6.1/website/modules/nsh-updater.md)

模板脚本校验 Cargo 依赖与 CLI 版本，并把 Cargo 实际解析的全局构建目录用于 Mixed 运行器。项目根的 `npm run dev` 默认使用当前系统已选的 desktop 或 TUI，只有移动/Web 的项目须显式执行对应的 `dev:android`、`dev:ios` 或 `dev:web`。通过 `npm run dev:ios -- --device <名称或 UDID>` 选择 iOS 模拟器。用 `npm run test` 执行当前系统的 Rust 测试，`npm run nsh:check` 检查类型，`npm run nsh:build` 编译应用资源与字节码，`npm run nsh:test` 在当前系统执行 headless 渲染测试。模板的 `nsh:test:<目标>` 适用于桌面和终端，先核对当前系统与项目选择。移动和 Web 验收使用实际目标运行环境。既有项目若仍使用 `check_nsh_toolchain.mjs && nsh …`，可改用 `check_nsh_toolchain.mjs -- <NSH 命令和参数>` 支持仅从 Cargo 配置文件解析目标目录，原有的桌面或 TUI 选择器放在 `--` 前。

若 iOS 模拟器开发首次因 QuickJS bindgen 找不到 SDK 头文件失败，用 `xcrun --sdk iphonesimulator --show-sdk-path` 查找 SDK，在当前命令环境为 `BINDGEN_EXTRA_CLANG_ARGS_aarch64_apple_ios_sim` 设置 `-isysroot '<SDK 路径>'` 后重试。受管 iOS 打包入口会按目标补充该参数。

初始化派生的应用 ID 供工程试用。产品明确发布身份后，在 `nsh.json` 登记受控的反向域名 ID、应用图标和渠道 build 编号。项目版本门禁同步 Cargo 和 `nsh.json` 的版本。关于页通过 `appInfo().version` 读取运行时版本。

检查 Rust、`nsh check` 和非空 `nsh test`；TUI 另走官方终端渲染测试。源码与 headless 回归只证明各自范围，实际窗口、托盘、OS 事件、设备和签名按真实宿主分别取证。
