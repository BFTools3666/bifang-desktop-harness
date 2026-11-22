---
name: desktop-run-parallel-worktrees
description: 内部 Subagent Worktree 的兼容入口；统一委托 desktop-task-workflow 继承授权、按所有权并行创建和执行，保留原 helper 路径。
---

# 内部并行工作树兼容入口

本入口仅为既有调用保留。完整读取并调用 [$desktop-task-workflow](../desktop-task-workflow/SKILL.md)，按其 [工作树执行](../desktop-task-workflow/references/worktree-execution.md) 处理内部并行单元、自动 guard/postflight、整合和资源保留。

继续使用原 [并行工作树 helper](scripts/parallel_worktrees.mjs) 路径。默认禁止创建，`create` 须同时有项目开关和本次已确认的 Worktree 请求。
