/** GUI 框架选择、候选传播与受保护事实的升级回归。 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { inapplicableGuiCandidate, parseInterfaceSelection } from "./harness_upgrade_interfaces.mjs";
import { snapshotFile } from "./harness_upgrade_safety.mjs";
import { HarnessUpgradeFixture, MANAGED } from "./harness_upgrade_test_support.mjs";
import { REQUIRED_NSH_SOURCE_PATHS } from "./harness_upgrade_policy.mjs";

const METADATA = "[workspace.metadata.agent-first-harness]\n";
const CURRENT_PIN = '[workspace.dependencies]\nnsh-core = { version = "0.7.2", git = "https://github.com/longbridge/nsh.git", rev = "0c29b5e3351128f489fe53bfb167160801707191" }\n';
const TAURI = ".agents/skills/desktop-add-gui-adapter/SKILL.md";

test("desktop_upgrade_rejects_retired_framework_without_mutation", (t) => {
  const source = `${METADATA}interfaces = ["gui"]\n`;
  assert.deepEqual(parseInterfaceSelection(source), { interfaces: ["gui"], guiFramework: "tauri" });
  const explicit = `${source}gui-framework = "gpui"\n`;
  assert.throws(() => parseInterfaceSelection(explicit), /DESKTOP 仅支持 Tauri/u);
  const f = new HarnessUpgradeFixture(t);
  f.write(f.target, "Cargo.toml", explicit);
  f.write(f.candidate, TAURI, "tauri engineering skill\n");
  assert.match(f.plan(2).error, /DESKTOP 仅支持 Tauri/u);
  assert.equal(fs.readFileSync(path.join(f.target, "Cargo.toml"), "utf8"), explicit);
  assert.equal(fs.existsSync(path.join(f.target, TAURI)), false);
});

/** 顶层 NSH 必须显式声明目标和当前运行时。 */
test("top_level_nsh_targets_are_parsed_without_gui_framework", () => {
  const nsh = METADATA + 'interfaces = ["nsh"]\n';
  assert.deepEqual(parseInterfaceSelection(nsh + 'nsh-targets = ["desktop", "mobile", "web"]\n' + CURRENT_PIN), { interfaces: ["nsh"], guiFramework: null, nshTargets: ["desktop", "mobile", "web"] });
  assert.deepEqual(parseInterfaceSelection(nsh + 'nsh-targets = ["tui"]\n' + CURRENT_PIN).nshTargets, ["tui"]);
  for (const suffix of ['nsh-targets = []', 'nsh-targets = ["desktop", "desktop"]', 'nsh-targets = ["unknown"]']) {
    assert.throws(() => parseInterfaceSelection(nsh + suffix + '\n'), /Cargo nsh-targets/u);
  }
  assert.throws(() => parseInterfaceSelection(METADATA + 'interfaces = ["gui"]\ngui-framework = "nsh"\n'), /DESKTOP 仅支持 Tauri/u);
  assert.throws(() => parseInterfaceSelection(METADATA + 'interfaces = ["gui"]\nnsh-targets = ["desktop"]\n'), /只适用于顶层 NSH/u);
  assert.throws(() => parseInterfaceSelection(nsh), /nsh-targets/u);
  assert.throws(() => parseInterfaceSelection(METADATA + 'interfaces = ["cli", "nsh"]\nnsh-targets = ["desktop"]\n'), /独立顶层接口/u);
});

/** 旧版、无 pin、提交错配和别名混装均不能进入升级。 */
test("nsh_upgrade_rejects_retired_and_missing_runtime_pins", () => {
  const metadata = METADATA + 'interfaces = ["nsh"]\nnsh-targets = ["desktop"]\n';
  const current = "0c29b5e3351128f489fe53bfb167160801707191";
  const old = "224d9a795c7ac9d10d75750de9351adac5549675";
  const earlier = "f4d68f7f9f31eb7b3ecc8a4cbc31096d5c6238a1";
  const expanded = CURRENT_PIN.replace(
    /^\[workspace.dependencies\]\nnsh-core = \{ (.*) \}\n$/u,
    (_, fields) => "[workspace.dependencies.nsh-core]\n" + fields.replaceAll(", ", "\n") + "\n",
  );
  assert.deepEqual(parseInterfaceSelection(metadata + expanded).nshTargets, ["desktop"]);
  for (const declarations of [
    "",
    CURRENT_PIN.replace("0.7.2", "0.7.1").replace(current, "f78eace7af23a9c1c72605c7ee46204f57f3e8e6"),
    CURRENT_PIN.replace("0.7.2", "0.7.0").replace(current, "3f8ecd8b3c55ad6274c6babbf7ee55c4cd4ae359"),
    CURRENT_PIN.replace("0.7.2", "0.5.0").replace(current, earlier),
    expanded.replace("0.7.2", "0.5.1").replace(current, old),
    CURRENT_PIN.replace("0.7.2", "0.6.0").replace(current, "554163758e30d2f62f814096a6327937dcb4fe49"),
    CURRENT_PIN.replace(current, old),
    CURRENT_PIN + 'old_base = { package = "nsh-base", version = "0.5.1", git = "https://github.com/longbridge/nsh.git", rev = "' + old + '" }\n',
  ]) assert.throws(() => parseInterfaceSelection(metadata + declarations), /仅支持官方 v0\.7\.2/u);
});

/** 未知值、错类型、重复键和非法接口不能降级到默认值。 */
test("framework_selection_rejects_unknown_duplicate_and_malformed_metadata", () => {
  for (const suffix of [
    'gui-framework = "unknown"', 'gui-framework = false', 'gui-framework = 1',
    'gui-framework = "gpui"\ngui-framework = "tauri"',
    'interfaces = ["gui"]', '[workspace.metadata.agent-first-harness]\ngui-framework = "gpui"',
    '[workspace.metadata.agent-first-harness.gui-framework]',
  ]) assert.throws(() => parseInterfaceSelection(`${METADATA}interfaces = ["gui"]\n${suffix}\n`), /Cargo/u);
  for (const interfaces of ['"gui"', '["gui", "gui"]', '["tui"]', '["cli", "tui"]', '["unknown"]', '[false]']) {
    assert.throws(() => parseInterfaceSelection(`${METADATA}interfaces = ${interfaces}\n`), /Cargo/u);
  }
  assert.throws(() => parseInterfaceSelection(`${METADATA}interfaces = ["cli"]\ngui-framework = "tauri"\n`), /只适用于已选择 GUI/u);
  assert.throws(() => parseInterfaceSelection('workspace.metadata.agent-first-harness = { interfaces = ["gui"], gui-framework = "gpui" }\n'), /内联表/u);
  assert.throws(() => parseInterfaceSelection('gui-framework = "gpui"\n'), /必须位于 workspace.metadata/u);
});

/** GUI 工程目录按持久框架选择，不从候选中的技能反推接口。 */
test("gui_candidate_selection_excludes_the_other_framework_and_non_gui_projects", () => {
  assert.equal(inapplicableGuiCandidate("docs/GUI_ENGINEERING.md", { interfaces: ["cli"], guiFramework: null }), true);
  const topLevelNsh = { interfaces: ["nsh"], guiFramework: null, nshTargets: ["mobile", "web"] };
  assert.equal(inapplicableGuiCandidate(".agents/skills/desktop-build-nsh-release/SKILL.md", topLevelNsh), false);
  assert.equal(inapplicableGuiCandidate(".agents/skills/desktop-add-gui-adapter/SKILL.md", topLevelNsh), true);
  assert.equal(inapplicableGuiCandidate(".agents/skills/desktop-prepare-gui-support-surfaces/SKILL.md", topLevelNsh), true);
  assert.equal(inapplicableGuiCandidate(".agents/skills/desktop-prepare-gui-app-identity/SKILL.md", topLevelNsh), true);
});

/** 官方 NSH Skill 的安装路径与适配器遵守相同的接口裁剪。 */
test("upgrade_plans_route_installed_official_skills_only_to_nsh_targets", (t) => {
  const f = new HarnessUpgradeFixture(t);
  for (const relative of REQUIRED_NSH_SOURCE_PATHS) f.write(f.source, relative, `current:${relative}\n`);
  f.git(f.source, "add", ...REQUIRED_NSH_SOURCE_PATHS);
  f.git(f.source, "-c", "user.name=Harness Fixture", "-c", "user.email=harness-fixture@example.invalid", "commit", "-m", "Add NSH release helpers");
  f.sourceCommit = f.git(f.source, "rev-parse", "HEAD").stdout.trim();
  const vendorEntries = ["nsh", "nsh-design-guides"].map(name => ".agents/skills/" + name + "/SKILL.md");
  for (const entry of vendorEntries) f.write(f.candidate, entry, "official NSH skill\n");
  f.write(f.target, "Cargo.toml", METADATA + 'interfaces = ["cli"]\n');
  const cliPlan = f.plan(2);
  for (const entry of vendorEntries) {
    assert.ok(cliPlan.problems.some(problem => problem.includes(entry)), entry);
  }
  assert.ok(REQUIRED_NSH_SOURCE_PATHS.every(relative => !cliPlan.problems.some(problem => problem.includes(relative))));
  const cargo = '[workspace]\nmembers = ["sample_tool_nsh"]\n' + CURRENT_PIN + METADATA
    + 'project-id = "sample_tool"\ninterfaces = ["nsh"]\nnsh-targets = ["mobile"]\ntarget-platforms = ["ios"]\n';
  f.write(f.target, "Cargo.toml", cargo);
  f.write(f.target, "sample_tool_nsh/Cargo.toml", '[package]\nname = "sample_tool_nsh"\nversion = "0.1.0"\nedition = "2024"\n[dependencies]\nnsh-core.workspace = true\n');
  f.write(f.target, "sample_tool_nsh/src/lib.rs", 'pub fn fixture() {}\n');
  f.write(f.target, "sample_tool_nsh/nsh.json", '{"rust":"."}\n');
  f.write(f.target, "sample_tool_nsh/App.tsx", 'import { mount } from "nsh";\nmount(() => null);\n');
  const missing = f.plan(2);
  for (const relative of REQUIRED_NSH_SOURCE_PATHS) {
    assert.ok(missing.problems.some(problem => problem.includes("候选缺少") && problem.includes(relative)));
    f.write(f.candidate, relative, `stale:${relative}\n`);
  }
  const stale = f.plan(2);
  for (const relative of REQUIRED_NSH_SOURCE_PATHS) {
    assert.ok(stale.problems.some(problem => problem.includes("内容不匹配") && problem.includes(relative)));
    f.write(f.candidate, relative, `current:${relative}\n`);
  }
  const nshPlan = f.plan();
  for (const entry of vendorEntries) assert.equal(f.classification(nshPlan, entry), "add");

  f.write(f.target, "sample_tool_nsh/nsh.json", '{"rust":".","root":"App"}\n');
  assert.match(f.plan(2).error, /Mixed\/Rust 入口/u);
  f.write(f.target, "sample_tool_nsh/nsh.json", '{"rust":"."}\n');
  f.write(f.target, "sample_tool_nsh/Cargo.toml", '[package]\nname = "sample_tool_nsh"\nversion = "0.1.0"\nedition = "2024"\n[dependencies]\nnsh-core = { version = "0.5.1", git = "https://github.com/longbridge/nsh.git", rev = "224d9a795c7ac9d10d75750de9351adac5549675" }\n');
  assert.match(f.plan(2).error, /仅支持官方 v0\.7\.2/u);
});

/** 实际接口决定文档与发布 Skill 的保留范围；NSH 批次证据不走扁平收集器。 */
test("interface_candidate_selection_prunes_unused_cli_mcp_i18n_and_collection_paths", () => {
  const cases = [
    { selection: { interfaces: ["cli"], guiFramework: null }, kept: ["desktop-add-cli-adapter", "desktop-build-rust-release", "desktop-prepare-cross-platform-release", "desktop-collect-release-artifacts"], removed: ["desktop-add-mcp-adapter", "desktop-extract-i18n-strings"] },
    { selection: { interfaces: ["mcp"], guiFramework: null }, kept: ["desktop-add-mcp-adapter"], removed: ["desktop-add-cli-adapter", "desktop-build-rust-release", "desktop-prepare-cross-platform-release", "desktop-extract-i18n-strings", "desktop-collect-release-artifacts"] },
    { selection: { interfaces: ["gui"], guiFramework: "tauri" }, kept: ["desktop-extract-i18n-strings", "desktop-collect-release-artifacts"], removed: ["desktop-add-cli-adapter", "desktop-add-mcp-adapter", "desktop-build-rust-release", "desktop-prepare-cross-platform-release"] },
    { selection: { interfaces: ["nsh"], guiFramework: null, nshTargets: ["desktop", "mobile", "web"] }, kept: [], removed: ["desktop-add-cli-adapter", "desktop-add-mcp-adapter", "desktop-build-rust-release", "desktop-prepare-cross-platform-release", "desktop-extract-i18n-strings", "desktop-collect-release-artifacts"] },
  ];
  for (const { selection, kept, removed } of cases) {
    for (const name of kept) assert.equal(inapplicableGuiCandidate(`.agents/skills/${name}/SKILL.md`, selection), false, name);
    for (const name of removed) assert.equal(inapplicableGuiCandidate(`.agents/skills/${name}/SKILL.md`, selection), true, name);
    assert.equal(inapplicableGuiCandidate("docs/CLI_CONTRACT.md", selection), !selection.interfaces.includes("cli"));
  }
});

/** 缺省旧 GUI 可接收 Tauri，纯 CLI 不可接收任一种 GUI 技能。 */
test("legacy_tauri_and_non_gui_plans_enforce_gui_applicability", (t) => {
  const f = new HarnessUpgradeFixture(t);
  f.write(f.target, "Cargo.toml", `${METADATA}interfaces = ["gui"]\n`);
  f.write(f.candidate, TAURI, "tauri engineering skill\n");
  assert.equal(f.plan().gui_framework, "tauri");
  const retired = [
    ".agents/skills/desktop-add-gpui-adapter/SKILL.md",
    ".agents/skills/desktop-add-tui-adapter/SKILL.md",
    ".agents/skills/desktop-check-development-environment/scripts/linux-gpui-dependencies.sh",
    ".agents/skills/desktop-check-development-environment/scripts/linux_gpui_dependencies.test.mjs",
    ".agents/skills/desktop-upgrade-harness/references/gpui-ownership.md",
    ".agents/skills/desktop-add-nsh-adapter/scripts/run_nsh_tui.mjs",
    ".agents/skills/desktop-add-nsh-adapter/scripts/nsh_tui_adapter.test.mjs",
  ];
  for (const relative of retired) f.write(f.candidate, relative, "retired engineering asset\n");
  const problems = f.plan(2).problems;
  for (const relative of retired) {
    assert.ok(problems.some(problem => problem.includes(relative)), relative);
    fs.rmSync(path.join(f.candidate, relative));
  }
  f.write(f.target, "Cargo.toml", `${METADATA}interfaces = ["cli"]\n`);
  assert.ok(f.plan(2).problems.some((problem) => problem.includes(TAURI)));
});

/** 退役资产旧基线退出 Harness 管理，已有文件字节及其他工程基线仍保留。 */
test("upgrade_forgets_retired_ownership_without_deleting_target_files", (t) => {
  const f = new HarnessUpgradeFixture(t);
  f.write(f.target, "Cargo.toml", `${METADATA}interfaces = ["cli"]\n`);
  f.write(f.candidate, MANAGED, "current engineering skill\n");
  f.write(f.target, MANAGED, "current engineering skill\n");
  f.bootstrap();
  const lock = JSON.parse(fs.readFileSync(f.lock, "utf8"));
  const retired = ".agents/skills/desktop-add-tui-adapter/SKILL.md";
  const file = path.join(f.target, retired);
  f.write(f.target, retired, "old harness bytes\n");
  const baseline = snapshotFile(file);
  lock.entries[retired] = { mode: "conditional", candidate: baseline, target: baseline };
  fs.writeFileSync(f.lock, JSON.stringify(lock));
  f.write(f.target, retired, "user maintained local copy\n");
  const { plan, planPath } = f.createPlan();
  assert.equal(plan.blocked, false);
  assert.equal(plan.actions.some(item => item.path === retired), false);
  f.record(planPath);
  const recorded = JSON.parse(fs.readFileSync(f.lock, "utf8"));
  assert.equal(Object.hasOwn(recorded.entries, retired), false);
  assert.deepEqual(recorded.entries[MANAGED], lock.entries[MANAGED]);
  assert.equal(fs.readFileSync(file, "utf8"), "user maintained local copy\n");
});

/** 框架事实在计划后改变，即使 Git 脏状态相同也禁止应用其他受管更新。 */
test("framework_metadata_drift_blocks_reviewed_managed_application", (t) => {
  const f = new HarnessUpgradeFixture(t);
  f.write(f.target, "Cargo.toml", `${METADATA}interfaces = ["gui"]\ngui-framework = "tauri"\n`);
  f.write(f.candidate, MANAGED, "v1");
  f.write(f.target, MANAGED, "v1");
  f.bootstrap();
  f.write(f.candidate, MANAGED, "v2");
  const { planPath } = f.createPlan();
  f.write(f.target, "Cargo.toml", `${METADATA}interfaces = ["gui"]\ngui-framework = "nsh"\n`);
  const result = f.runTool(["apply", "--plan", planPath, "--approval", "apply-managed-changes", "--path", MANAGED], 2);
  assert.match(result.error, /DESKTOP 仅支持 Tauri|已复核 plan 不再匹配/u);
  assert.equal(fs.readFileSync(path.join(f.target, MANAGED), "utf8"), "v1");
});

/** 初始化 E2E 永久禁止通过 Harness 升级恢复。 */
test("initialization_e2e_retains_tombstone_ownership", t => {
  const f = new HarnessUpgradeFixture(t);
  const initial = ".agents/skills/desktop-test-gui-initialization-e2e/SKILL.md";
  f.write(f.target, "Cargo.toml", METADATA + 'interfaces = ["gui"]\ngui-framework = "tauri"\n');
  f.write(f.candidate, initial, "initialization-only E2E\n");
  assert.equal(f.classification(f.plan(2), initial), "tombstone_candidate");
  fs.rmSync(path.join(f.candidate, initial));
  f.write(f.target, initial, "stale E2E\n");
  assert.equal(f.classification(f.plan(2), initial), "tombstone_present");
});
