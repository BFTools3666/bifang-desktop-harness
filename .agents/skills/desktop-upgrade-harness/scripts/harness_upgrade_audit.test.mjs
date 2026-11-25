/** 测试 Harness 升级后置审计：依赖与遗留清理盘点、项目结构检测、综合验证及跨版本自动失效豁免。 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  auditDependenciesAndLegacy,
  recordExemptions,
  verifyPostUpgrade,
} from "./harness_upgrade_audit.mjs";
import { inspectProjectStructure } from "./harness_upgrade_structure.mjs";

const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

function createDownstreamFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-audit-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => {
    const res = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr || res.stdout);
  };
  git("init", "--initial-branch=main");
  git("config", "--local", "user.name", "Test User");
  git("config", "--local", "user.email", "test@example.invalid");
  return { root, git };
}

function writeFile(root, rel, content) {
  const full = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}

function writeUpstreamLock(root, version, commit) {
  writeFile(root, ".harness/upstream-lock.json", JSON.stringify({
    schema_version: 2,
    recorded_at: "2026-11-25T20:00:00+00:00",
    harness_source: { version, commit },
    entries: {},
  }, null, 2));
}

test("deps_audit_detects_outdated_crates_npm_unused_deps_and_legacy_signals", (t) => {
  const { root } = createDownstreamFixture(t);
  writeFile(root, "Cargo.toml", [
    "[workspace]",
    'members = ["crates/demo_core"]',
    "",
    "[workspace.package]",
    'rust-version = "1.90.0"',
    "",
    "[workspace.dependencies]",
    'serde = "1.0.200"',
    'tauri-plugin-updater = "2.5.0"',
    'anyhow = "1.0.80"',
    "",
  ].join("\n"));
  writeFile(root, "crates/demo_core/Cargo.toml", [
    "[package]",
    'name = "demo_core"',
    'version = "0.1.0"',
    'edition = "2024"',
    "",
    "[dependencies]",
    "serde = { workspace = true }",
    "",
  ].join("\n"));
  writeFile(root, "apps/desktop/package.json", JSON.stringify({
    name: "demo-desktop",
    dependencies: {
      "@tauri-apps/api": "^2.9.0",
      "@tauri-apps/plugin-updater": "^2.5.0",
    },
  }, null, 2));
  writeFile(root, "apps/desktop/src-tauri/src/notifications.rs", '/// 通知\nfn open() { let _ = "/usr/bin/open"; }\n');
  writeFile(root, "README.md", "旧入口：$desktop-add-gui-updater 与 check_no_python.mjs\n");

  const report = auditDependenciesAndLegacy(root, { sourceRoot: HARNESS_ROOT });
  assert.equal(report.status, "upgrades-or-cleanup-available");
  assert.equal(report.hasUpgradeCandidates, true);
  assert.equal(report.hasLegacySignals, true);
  assert.ok(report.rustUpgrades.some((item) => item.name === "serde"));
  assert.ok(report.npmUpgrades.some((item) => item.name === "@tauri-apps/api"));
  assert.ok(report.toolchainDrift.some((item) => item.tool === "rust-version"));
  assert.ok(report.legacyCleanupSignals.some((item) => item.kind === "retired-dependency" && item.detail.includes("tauri-plugin-updater")));
  assert.ok(report.legacyCleanupSignals.some((item) => item.kind === "unused-workspace-dependency" && item.detail.includes("anyhow")));
  assert.ok(report.legacyCleanupSignals.some((item) => item.kind === "legacy-code-replaceable-by-official"));
  assert.ok(report.legacyCleanupSignals.some((item) => item.kind === "legacy-doc-reference"));
});

test("structure_detector_flags_dual_rust_modules_catchall_naming_barrels_and_uncentralized_deps", (t) => {
  const { root, git } = createDownstreamFixture(t);
  writeFile(root, ".gitignore", "/target/\n/release/\n/.release-clean.*\n");
  writeFile(root, "Cargo.toml", '[workspace]\nmembers = ["crates/demo_core"]\n');
  writeFile(root, "crates/demo_core/Cargo.toml", [
    "[package]",
    'name = "demo_core"',
    'version = "0.1.0"',
    'edition = "2024"',
    "",
    "[dependencies]",
    'serde = "1.0.229"',
    "",
  ].join("\n"));
  writeFile(root, "crates/demo_core/src/lib.rs", "/// 核心入口\npub mod domain;\npub mod utils;\n");
  writeFile(root, "crates/demo_core/src/domain.rs", "/// 双重布局\npub mod item;\n");
  writeFile(root, "crates/demo_core/src/domain/item.rs", "/// 子项\npub struct Item;\n");
  writeFile(root, "crates/demo_core/src/utils.rs", "/// 兜底模块\npub fn run() {}\n");
  writeFile(root, "apps/desktop/src/features/index.ts", `${["export *", "from", '"./list";'].join(" ")}\n`);
  writeFile(root, ".cargo/config.toml", '[build]\ntarget-dir = "local-target"\n');
  git("add", ".");
  git("commit", "-m", "chore: 初始化结构夹具");

  const report = inspectProjectStructure(root);
  const ids = new Set(report.findings.map((item) => item.id));
  assert.ok(ids.has("structure.workspace-deps-not-centralized:crates/demo_core/Cargo.toml"));
  assert.ok(ids.has("structure.rust-dual-module-layout:crates/demo_core/src/domain.rs"));
  assert.ok(ids.has("structure.catchall-naming:crates/demo_core/src/utils.rs"));
  assert.ok(ids.has("structure.frontend-barrel-export-star:apps/desktop/src/features/index.ts"));
  assert.ok(ids.has("constraint.cargo-target-redirect:.cargo/config.toml"));
});

test("version_scoped_exemptions_apply_to_current_version_and_auto_expire_on_next_upgrade", (t) => {
  const { root, git } = createDownstreamFixture(t);
  writeFile(root, ".gitignore", "/target/\n/release/\n/.release-clean.*\n");
  writeFile(root, "Cargo.toml", '[workspace]\nmembers = ["crates/demo_core"]\n');
  writeFile(root, "crates/demo_core/Cargo.toml", '[package]\nname = "demo_core"\nversion = "0.1.0"\nedition = "2024"\n');
  writeFile(root, "crates/demo_core/src/lib.rs", "/// 核心入口\npub mod helpers;\n");
  writeFile(root, "crates/demo_core/src/helpers.rs", "/// 临时保留的兜底模块\npub fn run() {}\n");
  git("add", ".");
  git("commit", "-m", "chore: 初始化豁免夹具");

  const commitV1 = "1".repeat(40);
  const commitV2 = "2".repeat(40);
  writeUpstreamLock(root, "202611251946", commitV1);

  // 1. 升级到 v1 后验证，发现 helpers.rs 兜底命名问题
  const initial = verifyPostUpgrade(root, { sourceRoot: HARNESS_ROOT });
  assert.equal(initial.status, "attention_required");
  const finding = initial.unresolvedFindings.find((item) => item.id === "structure.catchall-naming:crates/demo_core/src/helpers.rs");
  assert.ok(finding);

  // 2. 用户明确选择记录当前版本 v1 豁免
  const inputPath = path.join(root, ".harness", "tmp-exemptions-input.json");
  fs.writeFileSync(inputPath, JSON.stringify([{
    id: finding.id,
    category: finding.category,
    rule: finding.rule,
    path: finding.path,
    reason: "当前迭代暂缓重命名，留待下一次升级或专题重构处理",
    confirmed_by: "user",
  }], null, 2));
  const recorded = recordExemptions(root, { inputPath });
  fs.rmSync(inputPath, { force: true });
  assert.equal(recorded.status, "recorded");
  assert.equal(recorded.harnessVersion, "202611251946");
  assert.equal(recorded.expiresOnNextUpgrade, true);

  // 3. 在同一版本 v1 下再次验证，该项进入 exemptedFindings
  const verifiedV1 = verifyPostUpgrade(root, { sourceRoot: HARNESS_ROOT });
  assert.equal(verifiedV1.status, "passed_with_exemptions");
  assert.equal(verifiedV1.unresolvedFindings.length, 0);
  assert.equal(verifiedV1.exemptedFindings.length, 1);
  assert.equal(verifiedV1.expiredExemptions.length, 0);

  // 4. 下一次升级到 v2 后，来源锁更新；v1 豁免自动失效，问题重新浮现为 unresolvedFindings
  writeUpstreamLock(root, "202612011000", commitV2);
  const verifiedV2 = verifyPostUpgrade(root, { sourceRoot: HARNESS_ROOT });
  assert.equal(verifiedV2.status, "attention_required");
  assert.equal(verifiedV2.expiredExemptions.length, 1);
  assert.equal(verifiedV2.expiredExemptions[0].previous_harness_version, "202611251946");
  assert.equal(verifiedV2.exemptedFindings.length, 0);
  assert.ok(verifiedV2.unresolvedFindings.some((item) => item.id === finding.id));
});

test("record_exemptions_refuses_non_exemptable_hard_rules", (t) => {
  const { root } = createDownstreamFixture(t);
  writeUpstreamLock(root, "202611251946", "a".repeat(40));
  const inputPath = path.join(root, "bad-exempt.json");
  fs.writeFileSync(inputPath, JSON.stringify([{
    id: "constraint.file-line-hard-limit:src/big.rs",
    category: "constraint",
    rule: "硬行数上限",
    path: "src/big.rs",
    reason: "试图绕过",
    confirmed_by: "user",
  }]));
  assert.throws(() => recordExemptions(root, { inputPath }), /硬性规则不允许豁免/u);
});

test("structure_detector_invokes_core_first_checker_with_workspace_root", (t) => {
  const { root, git } = createDownstreamFixture(t);
  fs.cpSync(path.join(HARNESS_ROOT, ".agents", "skills", "desktop-initialize-rust-project", "assets", "rust-lib-cli"), root, { recursive: true });
  fs.mkdirSync(path.join(root, ".agents", "skills", "desktop-implement-change", "scripts"), { recursive: true });
  for (const name of ["check_core_first.mjs", "project_lock_policy.mjs"]) {
    fs.copyFileSync(
      path.join(HARNESS_ROOT, ".agents", "skills", "desktop-implement-change", "scripts", name),
      path.join(root, ".agents", "skills", "desktop-implement-change", "scripts", name),
    );
  }
  git("add", ".");
  git("commit", "-m", "chore: 初始化中性 Rust 工作区夹具");

  const report = inspectProjectStructure(root);
  assert.equal(report.checks.coreFirst?.ok, true);
  assert.equal(report.checks.coreFirst?.status, 0);
  assert.equal(report.findings.filter((item) => item.id.startsWith("constraint.core-first:")).length, 0);
});
