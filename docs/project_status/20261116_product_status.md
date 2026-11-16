# 项目状态

> 记忆日期：2026-11-16
>
> 更新事件：`v202611142116-20261114` 发布后的受管开发周期核对 NSH 知识。

## 当前阶段

- Harness 源维护规则、Skills、工程工具和中性资产。下游可组合 CLI、MCP、DESKTOP，也可独立选择 NSH。DESKTOP 固定使用 Tauri。新 NSH 项目固定官方 0.5.1 和匹配 CLI，支持桌面、移动、Web 和 TUI。[产品规格](../product_spec/README.md) · [NSH 运行时](../../.agents/skills/desktop-add-nsh-adapter/references/runtime-and-capabilities.md)
- 上次本地 Git 发布的 `master` 和 tag `v202611142116-20261114` 均已复核指向 `a968e0438da204b3f2ce944ed59a3180dde80627`。[Harness 时间版本](../../Version.md)
- 当前开发周期已调整更新日志的写作规则，并在本次工作中核对 NSH 文档和两套官方 Skills 的版本。[变更记录](../changelog/README.md)

## 工程入口

- [项目创建](../PROJECT_CREATION.md) 连接表单、环境门禁、工程准备、中性初始化、真实脚手架检查、裁剪和独立基线。产品定义随后在终端下游进行。
- [Skills 索引](../../.agents/skills/README.md) 按职责定位执行入口。[知识索引](../README.md) 指向当前规范、接口资料及原始记忆。工作区的 `knowledge/` 保存带源码身份的本地技术快照。
- [升级 Skill](../../.agents/skills/desktop-upgrade-harness/SKILL.md) 按目标 Cargo 选择和所有权清单检查候选。新下游的 schema 5 可以保留 `post_release_action: pending` 至首次发布。

## 待补证据

- 创建和升级已有隔离回归，真实下游的完整原生创建、跨平台运行和真实项目升级证据仍按 [技术债](../TECH_DEBT.md) 各项追踪。
- 下游候选按实际接口、目标、版本和最终制品取证。下一次 Harness Git 发布须独立触发，以当次默认主分支、发布上下文和 tag 复核。
