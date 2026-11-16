---
name: desktop-add-gui-adapter
description: 为已初始化的共享核心增加可选 Tauri 2 GUI，采用固定前端技术栈，并按九项初始化配置建立桌面能力、支持页及精简或详细侧栏。
---

# 增加 GUI 适配器

直接在共享核心之上增加最小的已批准 Tauri 2 桌面接口。固定 React/Mantine/Tabler/Router/Query/Jotai/i18n 技术栈是 GUI 硬规则；GUI 与 CLI 和 MCP 相互独立，业务效果回到 core。

DESKTOP 固定使用 Tauri。既有 GUI 缺失 `gui-framework` 时兼容 Tauri；显式不受支持的框架值须停止。NSH 走独立适配器。

目标包含 Linux 且当前工作涉及用户目录、卷扫描、托盘恢复、登录启动或 WebView/IPC 时，按问题读取 [Linux 运行时与测试边界](references/linux-runtime.md)；本地 deb/AppImage 打包仍由 `$desktop-build-tauri-local-install` 负责。阅读知识不触发能力启用、依赖安装或候选验收。

## 固定图标契约

- `package.json` 必须把 `@tabler/icons-react` 声明为直接生产依赖，使用经过最低直接版本验证的完整三段 caret 下界；所有图标使用命名导入，保留 tree-shaking。
- 菜单、操作、状态、空态及图表周边控件存在适用 Tabler 图标时，必须优先从该包选择；不得另装图标库，也不得改用手写 SVG、字符或 emoji。数据可视化图表本身仍按真实产品需求选择图表库。
- 功能菜单项以 `TablerIcon` 组件类型注入，设置与已选赞助、关于图标由支持界面模板提供。
- 偏离上述包或图标来源属于固定技术栈硬规则例外，必须先记录 ADR。

## 工作流程

1. 先判断调用模式。由 `$desktop-initialize-rust-project` 分派时沿用中性初始化的表单、初始版本和工程范围。初始化后新增 GUI 进入 [$desktop-implement-change](../desktop-implement-change/SKILL.md) 的开发闭环，由其处理范围、feature 版本、相关测试和提交。已从通用流程进入时复用当前变更的分类和状态。
2. 确认当前工作目录是真实下游 Rust 工作区，具有共享核心，且初始化选择或已批准产品范围中记录了 GUI。`Draft` 项目只能获得不含业务操作的中性脚手架状态 GUI。若当前目录只是文档 Harness，或缺少核心，则停止。不得要求另选目标目录，也不得要求 CLI。
3. 选择依赖或设计页面前，先从 [`docs/design_standards/README.md`](../../../docs/design_standards/README.md) 精确匹配设计标准，再完整阅读 [references/gui-baseline.md](references/gui-baseline.md)、[references/react-frontend-baseline.md](references/react-frontend-baseline.md) 和 [references/mantine-ui-guidelines.md](references/mantine-ui-guidelines.md)。当前基座是唯一视觉依据；旧专项风格不再覆盖它，新的产品设计方向或信息架构变化才确认并同步 profile/ADR。
4. 中性初始化先由 [$desktop-prepare-gui-app-identity](../desktop-prepare-gui-app-identity/SKILL.md) 交付所选 Logo、平台图标与 `docs/GUI_APP_PROFILE.md`。从该资料读取唯一 `gui-initialization-config` 代码块，按 [Tauri 基线](references/gui-baseline.md) 核对九字段及全局快捷键的条件 contract。复用已确认的侧栏模式与宿主能力。
5. 调用 [$desktop-prepare-gui-support-surfaces](../desktop-prepare-gui-support-surfaces/SKILL.md) 按 profile 接入标题、侧栏、设置、主题、i18n、条件支持页和发布资源映射。设置页、条件控件、本地更新日志与赞助资产按该 Skill 的界面和品牌合同实施。
6. 识别已批准的人类使用场景、产品功能菜单项、状态与错误展示、键盘与无障碍要求、刷新/并发语义、平台集成、隐私边界、预期分发格式和 i18n 接入范围（默认语言探测、设置页语言切换和需要覆盖的原生文案）。只询问会实质改变范围的缺失选择。
7. 中性初始化直接按接口选择建立无业务 GUI；初始化后新增真实 GUI 也直接实施。GUI 适配器必须与 CLI 解析和 MCP 协议代码相互独立。
8. 依赖准入由 [$desktop-manage-dependencies](../desktop-manage-dependencies/SKILL.md) 执行。为 Tauri、前端和宿主能力选择 Rust MSRV、Node.js/pnpm、WebView 与目标平台共同支持的最低兼容稳定范围。根 `[workspace.dependencies]` 统一声明 Rust 版本、来源与 feature，成员用 `workspace = true` 继承。Rust 复用满足下限的已安装 stable 正常解析并运行相关测试，前端按 [React 基线](references/react-frontend-baseline.md) 验证。固定能力无条件调用 [$desktop-add-gui-system-locale](../desktop-add-gui-system-locale/SKILL.md)、[$desktop-add-gui-window-state](../desktop-add-gui-window-state/SKILL.md) 与 [$desktop-add-gui-dialog](../desktop-add-gui-dialog/SKILL.md)。再按 profile 分派 [$desktop-add-gui-system-tray](../desktop-add-gui-system-tray/SKILL.md)、[$desktop-add-gui-system-notifications](../desktop-add-gui-system-notifications/SKILL.md)、[$desktop-add-gui-autostart](../desktop-add-gui-autostart/SKILL.md)、[$desktop-add-gui-single-instance](../desktop-add-gui-single-instance/SKILL.md)、[$desktop-add-gui-deep-link](../desktop-add-gui-deep-link/SKILL.md) 与 [$desktop-add-gui-global-shortcut](../desktop-add-gui-global-shortcut/SKILL.md)。各能力 Skill 拥有具体适用条件、依赖、接线与回归。选择关于页时按 Tauri 与 React 基线接入条件 Rust/React 依赖和资源读取。
9. 在 `<project-id>_gui` 中增加桌面应用边界，该标识用于 Cargo 包、Rust crate 与真实应用二进制。面向用户名称来自 GUI 资料。主应用窗口回退和安装卷布局按 [Tauri 基线](references/gui-baseline.md) 接入。Tauri Builder 集中注册各插件且每项恰好一次，顺序为启用时的 single-instance、启用时的 deep-link、固定 os、固定 window-state、固定 dialog、启用时的 notification、autostart、global-shortcut。托盘走 `.setup(...)` 和 `.on_window_event(...)`。复用 Tauri 的 Tokio-backed runtime，保持 core 与 GUI 技术栈独立。
10. 公开窄而有类型的普通 `async fn` Tauri 命令，解析协议、调用一个异步 core 用例并映射结果。由 `get_app_metadata` 返回权威打包名称（含适用的 Beta 后缀）、版本、标题联系人和中性产品定义状态。把固定命令及选中能力的自有命令注册到唯一合并的 `invoke_handler`，dialog 使用独立 guest plugin 命令和该 Skill 的 ACL 合同。每条真实业务路径记录“GUI 事件/命令 → core API → core 测试”，平台机制本身无需 core-first 例外 ADR。选择关于页时将其窄异步命令接到同一个 handler，资源协议按 [关于与赞助页](../desktop-prepare-gui-support-surfaces/references/about-and-sponsor-pages.md) 核对。I/O、等待、计时器和进程调用保持异步。仅测量确认的 CPU 密集工作可使用有边界的线程隔离，记录所有权、取消、并发上限、资源预算和测试。仅支持阻塞调用的依赖应替换为异步能力，否则进入适用范围或硬规则例外流程。为命名窗口与 WebView 保持明确 CSP 和最小能力、权限与作用域，默认加载打包的本地内容。
11. 按 [React 基线](references/react-frontend-baseline.md) 使用 Mantine UI、TanStack Router、TanStack Query 与应用根 Jotai store，核对控件事件归属与普通页面会话状态。列表页及已有列表审查必须调用 `$mantine-list-view`，按其状态、数据与分页合同实施。只在实际生成列表页时引入并验证 `@dnd-kit/core` 和 `@dnd-kit/sortable`。
12. 稳定资源 ID 必须与视图位置分离，选择范围和批处理范围必须明确，真实展示空/加载/错误状态，并从共享核心/存储获取全部持久状态。
13. 在 GUI 前端项目自有工具目录复制 [TypeScript Compiler AST 中文注释检查器](references/check-typescript-chinese-comments.cjs) 与 [专项测试](references/check-typescript-chinese-comments.test.ts)，调整相对导入后同时接入 `pnpm lint` 和项目 validator。检查器必须识别直接及后置命名/默认导出的箭头组件与 hook，只在测试文件或显式 `vitest` 导入中识别 `test`/`it` 场景；精确排除 `src/routeTree.gen.ts`，对解析错误/非法 UTF-8/NUL/源码符号链接/空扫描失败关闭；禁止扩张到所有局部变量或普通匿名回调，禁止加入自动批量注释。
14. 运行本次相关单元与回归测试。中性初始化按 [Tauri 生命周期验证合同](references/gui-baseline.md) 核对 profile、能力接线与未选项缺席，按各能力 Skill 和支持界面合同运行非空回归。集成边界覆盖错误 target、单实例漏注册、重复 handler、禁用依赖残留及空洞断言。
15. 只有真实下游需要前端公开配置时，才建立 `development/test/release` 逻辑 profile 和类型化冻结配置对象；全部 Vite 变量视为用户可读，禁止凭据且产品模块不得散落读取 `import.meta.env`。真实需要前端日志时使用稳定、脱敏的结构化事件，优先通过窄 Tauri 命令汇入 Rust `tracing`；Release Vite `dist` 必须静态拒绝 source map、开发/测试 endpoint、debug/info 哨兵、本机路径和未经批准的 console 输出。
16. 中性初始化把相关单元与回归结果交回初始化器，由其在通过后调用 [$desktop-test-gui-initialization-e2e](../desktop-test-gui-initialization-e2e/SKILL.md) 完成本机初始化验证。
17. 独立候选构建交给 [$desktop-build-tauri-release](../desktop-build-tauri-release/SKILL.md) 处理产物及适用的签名和渠道门禁。
18. 只按 `docs/ENGINEERING_RULES.md` 的独立事件触发规则更新产品、状态、计划、决定、验证、发布说明和变更记录；普通缺陷修复、纯重构和内部清理本身不触发项目记忆。只有另行授权发布工作后才能增加发布自动化；不得声称已获人工批准。

## 硬边界

- GUI 必须保持独立，并通过相同核心和错误模型与每个已选适配器保持行为一致。
- GUI 初始化始终接入 `i18next`/`react-i18next` 与 `rust-i18n`；托盘原生文案只在托盘能力启用时接入运行时。默认语言、回退和可发现语言切换保持硬规则。
- React 事件、Tauri command 和平台回调不得承载业务规则、领域校验、权威状态或跨 core 调用编排；当前只有 GUI 也不是例外。
- 绝不能从 GUI 自动操作 CLI 或解析 CLI 输出。
- 绝不能把业务规则、持久状态、迁移或平台无关验证放入 React 组件、路由、查询、atom 或事件处理器。
- 不得创建第二套存储或由前端拥有的权威数据副本。
- 不得仅因 GUI 较小或熟悉其他技术栈就替换任何固定 React 前端库。偏离必须形成硬规则例外 ADR。
- `@tabler/icons-react` 是固定图标库；适用图标不得由其他库、手写 SVG、字符或 emoji 替代。图表相关控件优先使用 Tabler 图标，但该包不承担图表绘制。
- 远程能力遵循支持界面的授权与运行时合同。os/window-state 保持 Rust-only，固定 dialog guest plugin 只授予精确 `dialog:default`。条件宿主能力按 profile 接线，未选托盘时按 Tauri 基线验证关闭最后窗口退出。
- 没有真实项目需求时，不得增加其他路由器、服务器状态缓存、通用全局存储或可选前端包。
- 不得用宽泛目录名排除人工 TypeScript 源码，不得用自动生成套话代替业务注释；非 GUI 下游不适用 TypeScript 门禁，也不得因此额外要求 pnpm、TypeScript 或前端依赖，但仍复用所有接口固定具备的 Node.js 工程运行时。
- 不得用同步 I/O、休眠、进程等待或 CPU 密集命令阻塞 Tauri 的 Tokio 运行时，也不得创建嵌套运行时。
- 除应用 Logo、标题、所选侧栏、设置页和明确启用的八项能力外，不得捆绑其他页面、业务操作或产品状态。

## 完成输出

报告九项 GUI 配置、system-locale/window-state 两项 Rust-only 固定基线、dialog 固定 WebView 基线及精确 `dialog:default`、所选侧栏、Logo/标题/设置/主题，以及六个条件宿主能力各自的启用实现或禁用缺席。E2E 汇总报告真实执行场景、自启恢复、快捷键注销和需要打包后验证的深链边界；中性初始化不报告版本分类。
