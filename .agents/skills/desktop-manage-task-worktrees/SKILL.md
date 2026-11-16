---
name: desktop-manage-task-worktrees
description: Task 独立工作树的兼容入口；统一委托 desktop-task-workflow 按冻结项目选择分配环境、并行创建与恢复。
---

# Task 工作树兼容入口

本入口仅为既有调用保留。完整读取并调用 [$desktop-task-workflow](../desktop-task-workflow/SKILL.md)，由其 [工作树执行](../desktop-task-workflow/references/worktree-execution.md) 处理已启用或冻结的 `task_worktrees` 环境。
