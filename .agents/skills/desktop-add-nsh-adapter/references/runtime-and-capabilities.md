# NSH 运行时、目标与生态

2026-11-27 核对正式 v0.7.2。Cargo 固定提交 `0c29b5e3351128f489fe53bfb167160801707191`，CLI 的 `nsh --version` 必须返回 `nsh 0.7.2 (0c29b5e)`。采用官方安装器时，设置 `NSH_VERSION=v0.7.2` 选择该发行版，运行时组件由匹配的 CLI 安装。上游声明 Rust 1.97，Harness 新项目声明 Rust 1.98.1。[机器版本策略](../../desktop-implement-change/scripts/nsh_runtime_policy.mjs) · [正式发行](https://github.com/longbridge/nsh/releases/tag/v0.7.2) · [安装与组件](https://github.com/longbridge/nsh/blob/v0.7.2/website/docs/installation.md)

根 Cargo 声明 `interfaces = ["nsh"]`、`nsh-targets` 和具体 `target-platforms`。受管入口检查所有直接 NSH 依赖的版本和提交，以及本机 CLI。旧工程在自己的项目完成迁移后再运行 Harness 开发、工程升级或构建。既有项目的 Cargo、界面和应用身份由下游维护。

## 桌面补丁检查

| 场景 | 上游变化和项目核对项 |
| --- | --- |
| 桌面多窗口 | `titleBar()` 与 `windowState()` 在事件、计时器或异步回调中读取打开的主窗口。未打开主窗口时分别返回零值与 `null`。需要操作发起事件的窗口时，在渲染阶段取得 `currentWindow()`，在回调中使用该引用的 `titleBar()` 或 `state()`。 |
| TSX 控件文本 | Rust 组件接收裸文本子节点时，修复了放置过程中的 `UnknownNode`。可见文字仍通过 `<Text>` 渲染，裸文字放进 `Button` 会产生运行时警告。 |
| macOS | 修复已经到期的计时器反复占用主线程。使用计时器的应用可在空闲窗口和恢复后复核界面响应。 |
| Windows | 修复打开 URL 或发出通知时的中止、通知唤醒可见窗口、应用窗口计数、开发窗口图标、缩放残影和多行输入的鼠标、按键及 IME 定位。使用官方目录替换更新的 Inno Setup 安装包应复核原位更新后的卸载。 |

[0.7.1 到 0.7.2 的源码差异](https://github.com/longbridge/nsh/compare/v0.7.1...v0.7.2) · [桌面 API](https://github.com/longbridge/nsh/blob/v0.7.2/website/modules/nsh-desktop.md) · [TSX 文本规则](../assets/vendor/nsh/references/tsx.md#text)

## Mixed 与官方扩展

所有模板目标共用 TSX UI、窄 Rust native module 和共享 Rust core。`<project-id>_nsh/nsh.json` 保留 `rust: "."`、不设置 `root`，这是 0.7 仍支持的官方 Mixed 入口。桥接 crate 只直接依赖共享 core 和 `nsh-core`；TSX 的 `nsh/base` 由官方 runner 提供，不重复声明未使用的 `nsh-base` 或平台宿主 crate。[官方 Mixed 指南](../assets/vendor/nsh/references/mixed.md)

官方 `nsh init --template mixed` 默认把 Rust 扩展放在 `ext/<name>-native/`，通过 `nsh.json.dependencies` 的 path 接入。Harness 的 workspace 成员布局用于共享 core。增加可复用扩展时使用官方 `nshm` 和 `#[native_module]`。`nsh add`、`nsh upgrade`、`nsh remove` 管理依赖和 `nsh.lock`。CLI 支持读取扩展从 workspace 继承的版本与 `nsh-core` 约束。外部模块按项目依赖准入选择、声明和锁定。[nshm](https://github.com/longbridge/nsh/blob/v0.7.2/website/docs/nshm.md)

`nsh-extra` 的 camera、location、photos、push 和 speech 都是按需启用的官方模块。选用时核对 feature、目标系统和权限，并与 NSH 运行时保持同版。社区扩展也按实际产品需求准入。[官方扩展](https://github.com/longbridge/nsh/blob/v0.7.2/website/docs/nshm.md#nsh-extra)

生成器把同版官方开发与设计 Skills 原样安装到下游 `.agents/skills/`。新建、裁剪和升级保留两套 Skills、完整引用及 Apache 许可证。[nsh Skill](../assets/vendor/nsh/SKILL.md) · [设计指南 Skill](../assets/vendor/nsh-design-guides/SKILL.md)

## 目标与宿主

| `nsh-targets` | `target-platforms` | 官方入口 |
| --- | --- | --- |
| desktop | Windows、macOS、Linux | `nsh run`；对应系统的 `nsh package --target macos\|windows\|linux` |
| mobile | Android、iOS | `nsh run --target android\|ios`；APK/AAB、模拟器或设备 app，IPA 另需明确签名身份和描述文件 |
| web | Web | `nsh run --target web`；`nsh package --target web` 生成完整静态站点 |
| tui | Windows、macOS、Linux 终端 | `nsh run --target tui`、精确测试文件的 `nsh test --target tui`；0.7 无 TUI 打包目标 |

用 `platform.idiom === "terminal"` 区分终端；`platform.os` 仍是系统。TUI 使用共享 core、键盘焦点和 Cell 布局，不加载图形侧栏、Logo、托盘或移动状态栏。[TUI 指南](https://github.com/longbridge/nsh/blob/v0.7.2/website/docs/tui.md)

从 0.7.1 起，官方 CLI 根据 `Sound`、`AudioPlayer`、`Video` 的使用启用媒体支持。Linux 声音后端动态加载 GStreamer，编译和打包无须安装 GStreamer 开发包。媒体功能的运行时依赖按组件和目标系统核对，Windows 由官方 runner 按需启用 Media Foundation。Linux 打包前还要确认由展示名派生的可执行文件名不会与 `nsh/` 资源目录重名。[媒体变更说明](https://github.com/longbridge/nsh/releases/tag/v0.7.1) · [Linux Cargo features](https://github.com/longbridge/nsh/blob/v0.7.2/crates/nsh-platform-linux/Cargo.toml#L63-L69) · [技术债 LIM-032](../../../../docs/TECH_DEBT.md)

## 官方能力优先

| 模板职责 | 官方实现与边界 |
| --- | --- |
| 语义控件 | `nsh/base` 的 Button、Radio/RadioGroup、Collapsible；应用 Token 只负责外观，控件拥有焦点、键盘和可访问性。 |
| 语言与格式化 | `locales/zh.json`、`locales/en.json` 交给 `nsh/i18n` 编入离线 bundle；`t` 查找、回退，`setLocale` 同步当前 surface 的语言与 Intl。选择仍由 NSH Storage 持久化，各窗口订阅共享偏好。 |
| 异步 core 状态 | `resource(() => Scaffold.status())` 管理 loading/value/error、owner 释放与过期结果，不手工维护 Promise 的存活标记。 |
| 主题与偏好 | `colorScheme`、`setColorScheme`、Storage；持久化失败保持可见。页面临时状态由 TSX signal 持有，不移入业务 core。 |
| 桌面窗口、菜单 | `nsh/desktop` 的 Window、WindowRef、Menu、Application；声明 `capabilities.application` 与受限的 windows 权限。 |
| 托盘、单实例、链接 | 选中才使用 Tray、singleInstance、schemes 与 UrlScheme；深链接只接受固定恢复 URL，并恢复聚焦。 |
| 移动导航 | 当前主题底栏基于官方语义 Button 和 safeArea；产品要求系统导航时用 `nsh/mobile` TabBar，验证安全区和选中态。 |
| 在线更新 | 独立授权后用 `nsh/updater`，核对渠道、签名和权限。离线更新日志继续用随包资源，不访问网络。 |

桌面窗口在 0.7 各自独立关闭；关闭主窗口不再隐式关闭其他窗口。模板无托盘时显式设置 `application.quitMode: "lastWindowClosed"`，保证所有系统在最后一窗关闭后退出；有托盘时使用 `"explicit"`，主窗关闭隐藏，菜单明确退出调用 `Application.quit()`。`Application.on("reopen")` 负责再次启动或 Dock 恢复窗口。不要把 `WindowRef.close()` 当应用退出，也不要等待异步 `lastWindowClosed` 事件再设置退出策略。[桌面生命周期](https://github.com/longbridge/nsh/blob/v0.7.2/website/modules/nsh-desktop.md#quitting)

自启、通知和 OS 全局快捷键在中性 profile 固定关闭，后续产品按需求接入官方 Application、Notifications、GlobalShortcut，并在真实宿主验证。移动状态栏使用 `statusBar.foreground: "auto"` 和 `capabilities.statusBar`。组合工程的移动/Web 构建副本移除 `window`、`application`、windows/application 权限、singleInstance 与模板恢复协议，保留产品自有配置；不修改原工程。

## 0.7 迁移检查

- 已采用 0.7.0 或 0.7.1 的顶层 Mixed 项目，在原项目同步升级 CLI、各直接 NSH crate 的 Cargo 版本和 Git revision。启用 nshm 时同步核对扩展兼容范围与 `nsh.lock`。执行类型检查，并按上表选择受影响的用例和真实宿主，再继续 Harness 工程升级。
- 复核上方独立窗口与退出模式；pointer press 在 Apple 平台不再自动移动键盘焦点，必要时显式 focus，键盘和辅助技术 press 的 `clickCount` 为 0。
- `Clipboard.writeText/write` 返回结果，Web Storage 写入可能因配额失败而拒绝；保留可见失败，不能把完成 Promise 当成功写入。
- Speech 按 nsh-extra 迁移；新增 Rust 结构字段使用有依据的默认值；WebView 的可达性分析无法发现动态使用时显式声明 feature。
- 从 0.6 或更早版本迁移时，先对照 0.7.0 兼容性变化，再按两份补丁说明核对原项目实际调用。[0.7.0 兼容性变化](https://github.com/longbridge/nsh/releases/tag/v0.7.0#breaking-changes) · [0.7.1 补丁](https://github.com/longbridge/nsh/releases/tag/v0.7.1) · [0.7.2 补丁](https://github.com/longbridge/nsh/releases/tag/v0.7.2)

## 定向测试与旧脚本迁移

模板脚本先检查 Cargo 与 CLI，并向 NSH 转交 Cargo 实际解析的全局 target。`npm run dev` 使用当前系统已选的 desktop 或 TUI；只有移动/Web 时显式选择 `dev:ios`、`dev:android` 或 `dev:web`。iOS 模拟器可传 `npm run dev:ios -- --device <名称或UDID>`。`nsh:check` 检查 Rust/TSX 类型，`nsh:build` 编译资源与字节码；不代表候选验收。

受管测试入口在启动前拒绝无选择器、无效或零命中选择器。Rust 传 package 和精确用例，NSH 传具体文件及必要 filter：

```text
npm test -- --rust-package <project-id>_core --rust-test <实际查询到的精确用例名>
npm run nsh:test -- --test <project-id>_nsh/App.test.tsx
npm run nsh:test -- --test <project-id>_nsh/App.platform.test.tsx
npm run nsh:test:macos -- --test <project-id>_nsh/App.platform.test.tsx --nsh-filter "official desktop window opens and closes through WindowRef"
npm run nsh:test:tui -- --test <project-id>_nsh/App.test.tsx
```

生成的 `App.platform.test.tsx` 含模拟移动平台、读取应用退出状态和注入 URL Scheme 的 headless 用例。应用有这个文件时，使用不带宿主目标的 `nsh:test` 执行全文件。原生桌面测试通过 `--nsh-filter` 选取实际支持宿主运行的用例。

官方 `nsh test <目录>` 会发现 TSX 测试并可能先运行 Rust 测试，不能把目录当精确文件。开发只运行本次受影响测试；全量仍须当次人类明确授权，显式传 `--scope full --human-authorization <来源>`。平台模拟只证明模拟交互，原生运行、安装、签名与候选 E2E 各自取证。

升级从受管资产传播 `run_scoped_tests.mjs`，项目根的 `package.json` 保留项目所有权。确认原值仍为下表的旧模板命令时，在下游项目定点迁移对应别名。已有自定义命令按本项目范围核对，也可从项目根直接调用新版 helper。

| 别名 | 旧模板值 | 新模板值 |
| --- | --- | --- |
| `test` | `node .agents/skills/desktop-implement-change/scripts/cargo_device_config.mjs && cargo test --workspace --all-targets --all-features --target host-tuple` | `node .agents/skills/desktop-implement-change/scripts/run_scoped_tests.mjs rust` |
| `nsh:test` | `node .agents/skills/desktop-add-nsh-adapter/scripts/check_nsh_toolchain.mjs -- test <id>_nsh` | `node .agents/skills/desktop-implement-change/scripts/run_scoped_tests.mjs nsh --nsh-app <id>_nsh` |
| `nsh:test:<目标>` | `node .agents/skills/desktop-add-nsh-adapter/scripts/check_nsh_toolchain.mjs <目标> -- test <id>_nsh/App.test.tsx --target <目标>` | `node .agents/skills/desktop-implement-change/scripts/run_scoped_tests.mjs nsh --nsh-app <id>_nsh --target <目标>` |

### 自定义原生运行器

既有项目直接编译生成的 runner 时，将 TSX 入口实际导入的原生模块与各目标的 Cargo feature 对照，尤其检查使用 `--no-default-features` 的路径。例如导入 `nsh/base/plot` 时确认实际 runner 含 `plot`。给编译参数加入回归，并依照 [最终产物 E2E](../../desktop-test-final-artifact-e2e/SKILL.md#nsh-场景) 在适用的运行变更中正常启动最终制品，观察页面挂载及已启用的窗口或托盘行为。缺少注册模块时优先查看启动日志。若命令行诊断开关在引擎启动前退出，它只证明开关自身的执行。

已有项目启用后台登录启动和单实例时，按实际安装包验证后台重复启动保持隐藏，正常前台再次启动恢复并聚焦窗口。更换可执行文件名时固定原安装标识和数据归属，只迁移本安装拥有的快捷方式和登录项并保留原参数，在真实宿主验证新装、原位升级和卸载。项目保留原生补丁时，见 [依赖补丁校验](../../desktop-manage-dependencies/references/compatibility-feedback.md#原生依赖补丁)。

## 初始化身份与 iOS 头文件

若 iOS 模拟器开发首次因 QuickJS bindgen 找不到 SDK 头文件失败，用 `xcrun --sdk iphonesimulator --show-sdk-path` 查找 SDK，在当前命令环境为 `BINDGEN_EXTRA_CLANG_ARGS_aarch64_apple_ios_sim` 设置 `-isysroot '<SDK 路径>'` 后重试。受管 iOS 打包入口会按目标补充该参数。

初始化派生的应用 ID 供工程试用。产品明确发布身份后，在 `nsh.json` 登记受控的反向域名 ID、应用图标和渠道 build 编号。项目版本门禁同步 Cargo 和 `nsh.json` 的版本。关于页通过 `appInfo().version` 读取运行时版本。

源码与 headless 回归只证明各自范围。实际窗口、托盘、OS 事件、设备和签名按真实宿主分别取证。
