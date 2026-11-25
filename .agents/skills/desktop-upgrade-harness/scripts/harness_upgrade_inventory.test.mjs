/** 验证升级覆盖当前源的全部适用工程资产，并如实报告自有 NSH 入口的兼容缺口。 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { HarnessUpgradeFixture } from "./harness_upgrade_test_support.mjs";

/** 把本例的上游资产冻结为真实提交，避免用未提交目录冒充升级来源。 */
function commitSource(f, files) {
  for (const [relative, content] of Object.entries(files)) f.write(f.source, relative, content);
  f.git(f.source, "add", ".");
  f.git(f.source, "-c", "user.name=Harness Fixture", "-c", "user.email=harness-fixture@example.invalid", "commit", "-m", "更新适用工程资产");
  f.sourceCommit = f.git(f.source, "rev-parse", "HEAD").stdout.trim();
}

/** 旧硬编码列表以外的 Skill、混合规范、条件入口和升级器模块也不能遗漏。 */
test("source_inventory_blocks_omissions", (t) => {
  const f = new HarnessUpgradeFixture(t);
  f.write(f.target, "Cargo.toml", '[workspace.metadata.agent-first-harness]\ninterfaces = ["gui"]\n');
  const files = {
    ".agents/skills/desktop-manage-version/references/new-contract.md": "当前版本合同\n",
    ".agents/skills/desktop-build-tauri-release/SKILL.md": "当前打包合同\n",
    ".agents/skills/desktop-upgrade-harness/scripts/new_module.mjs": "export const current = true;\n",
    "docs/RELEASE.md": "当前交付规范\n",
  };
  commitSource(f, files);
  const { plan, planPath } = f.createPlan(2);
  for (const relative of Object.keys(files)) assert.ok(plan.problems.some(item => item.includes(relative) && item.includes("候选缺少")), relative);
  f.runTool(["record", "--plan", planPath, "--source-version", f.sourceVersion, "--source-commit", f.sourceCommit, "--bootstrap", "--approval", "bootstrap-verified-baseline"], 2);
  assert.equal(fs.existsSync(f.lock), false);
  for (const [relative, content] of Object.entries(files)) f.write(f.candidate, relative, content);
  assert.equal(f.plan().blocked, false);
  f.write(f.candidate, ".agents/skills/desktop-upgrade-harness/scripts/new_module.mjs", "export const current = false;\n");
  assert.ok(f.plan(2).problems.some(item => item.includes("new_module.mjs") && item.includes("内容不匹配")));
});

/** 手工候选漏放仍在上游维护的文件时，不得误报删除并记录为新版共同基线。 */
test("source_inventory_prevents_false_deletion", (t) => {
  const f = new HarnessUpgradeFixture(t);
  const relative = ".agents/skills/desktop-manage-version/references/release-contract.md";
  commitSource(f, { [relative]: "上游继续维护的合同\n" });
  for (const root of [f.candidate, f.target]) f.write(root, relative, "上游继续维护的合同\n");
  f.bootstrap();
  fs.unlinkSync(path.join(f.candidate, relative));
  const { plan, planPath } = f.createPlan(2);
  assert.ok(plan.problems.some(item => item.includes(relative) && item.includes("候选缺少")));
  const before = fs.readFileSync(f.lock);
  f.runTool(["record", "--plan", planPath, "--source-version", f.sourceVersion, "--source-commit", f.sourceCommit, "--approval", "record-verified-baseline"], 2);
  assert.deepEqual(fs.readFileSync(f.lock), before);
  assert.equal(fs.readFileSync(path.join(f.target, relative), "utf8"), "上游继续维护的合同\n");
});

/** 盘点不需要已有清单或来源锁，运行时不兼容也须列出全部适用工程项而不改项目。 */
test("source_inventory_reports_custom_nsh_without_mutation", (t) => {
  const f = new HarnessUpgradeFixture(t);
  f.write(f.target, "Cargo.toml", '[workspace.metadata.agent-first-harness]\nproject-id = "existing"\ninterfaces = ["nsh"]\nnsh-targets = ["desktop"]\n[workspace.dependencies]\nnsh-core = "=0.7.0"\n');
  const required = ".agents/skills/desktop-build-nsh-release/SKILL.md";
  const official = ".agents/skills/desktop-add-nsh-adapter/assets/vendor/nsh/SKILL.md";
  commitSource(f, { [required]: "NSH 构建规范\n", [official]: "当前官方 NSH Skill\n", ".agents/skills/desktop-add-cli-adapter/SKILL.md": "不适用的 CLI\n" });
  fs.rmSync(path.join(f.target, ".agents"), { recursive: true });
  const before = fs.readFileSync(path.join(f.target, "Cargo.toml"));
  const inventory = f.runTool(["inventory", "--source-root", f.source, "--source-version", f.sourceVersion, "--source-commit", f.sourceCommit, "--target-root", f.target]);
  assert.equal(inventory.runtime.status, "unsupported");
  assert.equal(inventory.engineering_baseline, "not_verified");
  assert.ok(inventory.files.some(item => item.path === required && item.status === "missing"));
  assert.ok(inventory.files.some(item => item.path === ".agents/skills/nsh/SKILL.md" && item.source_path === official && item.status === "missing"));
  assert.equal(inventory.files.some(item => item.path.includes("desktop-add-cli-adapter")), false);
  assert.equal(fs.existsSync(path.join(f.target, ".agents")), false);
  assert.equal(fs.existsSync(path.join(f.target, ".harness")), false);
  assert.deepEqual(fs.readFileSync(path.join(f.target, "Cargo.toml")), before);
});

/** 盘点使用已提交源和接口事实，永久保护与初始化裁剪边界不因全量工程盘点放宽。 */
test("source_inventory_excludes_protected_retired_and_unselected_paths", (t) => {
  const f = new HarnessUpgradeFixture(t);
  f.write(f.target, "Cargo.toml", '[workspace.metadata.agent-first-harness]\ninterfaces = ["cli"]\n');
  const required = ".agents/skills/desktop-add-cli-adapter/SKILL.md";
  const excluded = [
    "docs/AGENT_POLICY.md", "docs/product_spec/current.md", ".agents/skills/README.md",
    ".agents/skills/desktop-initialize-rust-project/SKILL.md", ".agents/skills/desktop-curate-harness-memory/SKILL.md",
    ".agents/skills/desktop-build-tauri-release/SKILL.md", ".agents/skills/desktop-add-gui-updater/SKILL.md",
    ".agents/skills/desktop-implement-change/scripts/check_no_python.mjs",
  ];
  commitSource(f, Object.fromEntries([required, ...excluded].map(relative => [relative, "上游文件\n"])));
  const inventory = f.runTool(["inventory", "--source-root", f.source, "--source-version", f.sourceVersion, "--source-commit", f.sourceCommit, "--target-root", f.target]);
  assert.ok(inventory.files.some(item => item.path === required));
  for (const relative of excluded) assert.equal(inventory.files.some(item => item.path === relative), false, relative);
  assert.equal(inventory.files.some(item => item.path === "Version.md"), false);
});
