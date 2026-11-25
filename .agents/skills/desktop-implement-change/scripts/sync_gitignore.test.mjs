/** 测试开发生成物自动识别与 `.gitignore` 安全增量同步。 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  MANAGED_BLOCK_END,
  MANAGED_BLOCK_START,
  inspectGitignore,
  syncGitignore,
} from "./sync_gitignore.mjs";

function makeTempRepo(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "sync-gitignore-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => {
    const res = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    return res.stdout;
  };
  git("init", "--initial-branch=main");
  git("config", "--local", "user.name", "Test User");
  git("config", "--local", "user.email", "test@example.invalid");
  fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
  git("add", "README.md");
  git("commit", "-m", "chore: 初始化夹具");
  return { root, git };
}

test("detects_untracked_dev_generated_files_and_appends_to_gitignore_idempotently", (t) => {
  const { root } = makeTempRepo(t);
  fs.writeFileSync(path.join(root, ".gitignore"), "# 用户自定义规则\nmy-secret.txt\n");
  fs.mkdirSync(path.join(root, "target", "debug"), { recursive: true });
  fs.writeFileSync(path.join(root, "target", "debug", "app"), "bin");
  fs.writeFileSync(path.join(root, "coverage.lcov"), "SF:src/lib.rs\n");
  fs.writeFileSync(path.join(root, "app.log"), "debug\n");
  fs.writeFileSync(path.join(root, "index.scip"), "scip");
  fs.writeFileSync(path.join(root, "notes.md"), "user doc\n");

  const dry = syncGitignore(root, { dryRun: true });
  assert.equal(dry.status, "dry-run");
  assert.equal(dry.updated, false);
  assert.deepEqual([...dry.addedRules].sort(), ["**/target/", "*.lcov", "*.log", "*.scip"]);

  const applied = syncGitignore(root);
  assert.equal(applied.status, "updated");
  assert.equal(applied.updated, true);
  assert.equal(applied.verifiedIgnoredPaths.length, 4);

  const content = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  assert.ok(content.includes("# 用户自定义规则\nmy-secret.txt\n"));
  assert.ok(content.includes(MANAGED_BLOCK_START));
  assert.ok(content.includes(MANAGED_BLOCK_END));
  assert.ok(!content.includes("notes.md"));

  // 再次运行应保持幂等无写入
  const second = syncGitignore(root);
  assert.equal(second.status, "up-to-date");
  assert.equal(second.updated, false);
});

test("respects_tracked_dependency_lock_policy_and_never_ignores_cargo_lock", (t) => {
  const { root, git } = makeTempRepo(t);
  fs.writeFileSync(
    path.join(root, "Cargo.toml"),
    "[workspace]\nmembers = []\n\n[workspace.metadata.agent-first-harness]\ndependency-lock-policy = \"tracked\"\n",
  );
  git("add", "Cargo.toml");
  git("commit", "-m", "chore: 启用 tracked 锁策略");

  fs.writeFileSync(path.join(root, "Cargo.lock"), "# lock\n");
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: 9\n");
  fs.writeFileSync(path.join(root, "debug.tmp"), "tmp\n");

  const result = syncGitignore(root, { includeBaseline: true, extraPatterns: ["Cargo.lock"] });
  assert.equal(result.lockPolicy, "tracked");
  assert.ok(!result.addedRules.includes("Cargo.lock"));
  assert.ok(!result.addedRules.includes("pnpm-lock.yaml"));
  assert.ok(result.addedRules.includes("*.tmp"));
  assert.ok(result.lockPolicyWarnings.some((w) => w.includes("Cargo.lock")));
});

test("skips_patterns_that_would_conflict_with_already_tracked_files", (t) => {
  const { root, git } = makeTempRepo(t);
  fs.mkdirSync(path.join(root, "fixtures"), { recursive: true });
  fs.writeFileSync(path.join(root, "fixtures", "sample.log"), "tracked fixture\n");
  git("add", "fixtures/sample.log");
  git("commit", "-m", "chore: 跟踪日志夹具");

  fs.writeFileSync(path.join(root, "runtime.log"), "untracked log\n");
  const inspection = inspectGitignore(root);
  assert.equal(inspection.rulesToAdd.length, 0);
  assert.equal(inspection.skippedTrackedConflicts.length, 1);
  assert.equal(inspection.skippedTrackedConflicts[0].pattern, "*.log");
  assert.deepEqual(inspection.skippedTrackedConflicts[0].trackedPaths, ["fixtures/sample.log"]);
});

test("rejects_symlinked_gitignore_and_non_git_root", (t) => {
  const { root } = makeTempRepo(t);
  const sub = path.join(root, "nested");
  fs.mkdirSync(sub);
  assert.throws(() => inspectGitignore(sub), /独立 Git 仓库顶层/u);

  const outside = path.join(root, "real-ignore");
  fs.writeFileSync(outside, "/target/\n");
  try {
    fs.symlinkSync(outside, path.join(root, ".gitignore"));
  } catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") { t.skip("无符号链接权限"); return; }
    throw error;
  }
  assert.throws(() => syncGitignore(root), /普通非符号链接文件/u);
});
