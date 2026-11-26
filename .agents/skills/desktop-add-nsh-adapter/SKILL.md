---
name: desktop-add-nsh-adapter
description: 为顶层 NSH 类型生成调用共享 Rust core 的官方 Mixed 适配器，支持桌面、移动、Web 和 TUI。
---

# 接入 NSH 适配器

仅用于顶层 `interfaces = ["nsh"]`。先读[运行时与能力](references/runtime-and-capabilities.md)；有图形目标再读 [NSH 图形标准](../../../docs/design_standards/nsh_gui.md)。受管入口仅支持正式 0.7.1，旧版与旧 GUI/NSH 须先在原项目迁移。

1. 从已确认表单读取身份、目标系统和 `nsh-targets`。仅 desktop 读取九字段 profile、选择 Logo；托盘、单实例、深链接按选择接入，深链接依赖单实例。自启、系统通知、OS 全局快捷键在本中性模板固定关闭，其他目标不创建桌面资产。
2. 新建流程先建立共享 Rust core，再调用 `node .agents/skills/desktop-add-nsh-adapter/scripts/add_nsh_adapter.mjs --root <项目根> --options <已确认 JSON>`。选项为 `projectId/nameZh/nameEn/owner/targetPlatforms/nshTargets` 与仅桌面可用的 `profile/logo`。helper 只接入无接口的匹配 core workspace，拒绝已有文件、符号链接、未知字段和 core API 不匹配；源专用 `create_nsh_workspace.mjs` 只用于临时回归。
3. 生成 Mixed `App.tsx`、窄 native module 和共享 core 接线；桌面使用 NSH 官方多窗口、托盘和 URL Scheme，终端使用紧凑键盘导航。关于页和赞助页只按 desktop 选择生成，移动底栏安全区与 Web 回流按各目标的图形规范。官方 `nsh` 与 `nsh-design-guides` 随同一次写入安装到项目 `.agents/skills/`，保留官方引用、许可证与原始内容。
4. 在当前宿主复核正式 CLI 与 Cargo revision。按[定向测试](references/runtime-and-capabilities.md#定向测试与旧脚本迁移)传入相关 Rust 包和精确用例、NSH 测试文件和适用宿主，再运行本次需要的类型检查。模板脚本复用 Cargo 实际解析的全局目标目录，支持用户级 Cargo 文件与系统环境。初始化裁剪和唯一基线前执行 `$desktop-test-nsh-initialization-e2e`。打包由 [$desktop-build-nsh-release](../desktop-build-nsh-release/SKILL.md) 独立执行。

生成器不写 Git、产品记忆、发布上下文或下游派生能力。只报告实际验证的目标。
