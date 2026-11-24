/** 从已提交上游枚举适用工程资产；盘点不写目标，也不把兼容缺口解释成同步完成。 */
import path from "node:path";
import { spawnSync } from "node:child_process";
import { inapplicableGuiCandidate, isRetiredInterfaceAsset, readInterfaceSelection } from "./harness_upgrade_interfaces.mjs";
import { loadOwnership, ownershipMode } from "./harness_upgrade_ownership.mjs";
import { OWNERSHIP_RELATIVE, SOURCE_ONLY_PATHS } from "./harness_upgrade_policy.mjs";
import { isRetiredEngineeringPath } from "./harness_upgrade_retirement.mjs";
import { UpgradeError, assertSafePath, canonicalDirectory, isWithin, lstatOrNull, requireGitRoot, requireSourceIdentity, safeRelativePath, snapshotFile } from "./harness_upgrade_safety.mjs";

/** 由源清单和实际接口决定全集，不由手工候选、旧来源锁或路径白名单反推范围。 */
export function sourceInventory(source, selection) {
  const ownership = assertSafePath(source, path.join(source, OWNERSHIP_RELATIVE), "源所有权清单", { finalMayBeMissing: false });
  const { defaultMode, rules } = loadOwnership(ownership);
  const result = spawnSync("git", ["-C", source, "ls-tree", "-r", "--name-only", "-z", "HEAD"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new UpgradeError("无法枚举已提交的源 Harness 工程资产");
  const files = [];
  for (const raw of result.stdout.split("\0").filter(Boolean).sort()) {
    const relative = safeRelativePath(raw);
    const mode = ownershipMode(relative, defaultMode, rules);
    if (["protected", "tombstone"].includes(mode) || SOURCE_ONLY_PATHS.includes(relative)
      || relative === ".agents/skills/README.md" || relative.startsWith(".agents/skills/desktop-curate-harness-memory/")
      || isRetiredEngineeringPath(relative) || isRetiredInterfaceAsset(relative) || inapplicableGuiCandidate(relative, selection)) continue;
    const file = assertSafePath(source, path.join(source, ...relative.split("/")), "源适用工程资产", { finalMayBeMissing: false });
    const snapshot = snapshotFile(file);
    files.push({ path: relative, mode, source: snapshot });
    const official = /^\.agents\/skills\/desktop-add-nsh-adapter\/assets\/vendor\/(nsh(?:-design-guides)?)\/(.+)$/u.exec(relative);
    if (official && selection.interfaces.includes("nsh")) {
      const installed = `.agents/skills/${official[1]}/${official[2]}`;
      files.push({ path: installed, source_path: relative, mode: ownershipMode(installed, defaultMode, rules), source: snapshot });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

/** 自有 NSH 工程也能只读盘点通用和条件工程项；严格运行时支持结果单独报告。 */
export function inspectInventory(sourceRoot, sourceVersion, sourceCommit, targetRoot) {
  const { source, identity } = requireSourceIdentity(sourceRoot, sourceVersion, sourceCommit);
  const target = canonicalDirectory(targetRoot, "目标根目录");
  if (isWithin(source, target) || isWithin(target, source)) throw new UpgradeError("源和目标根目录必须彼此独立且不能嵌套");
  const targetGit = requireGitRoot(target);
  const selection = readInterfaceSelection(target, { validateNshRuntime: false });
  let runtime = { status: "supported" };
  try { readInterfaceSelection(target); }
  catch (error) { runtime = { status: "unsupported", reason: error.message }; }
  const files = sourceInventory(source, selection).map(item => {
    const file = assertSafePath(target, path.join(target, ...item.path.split("/")), "目标工程资产", { finalMayBeMissing: true });
    const snapshot = lstatOrNull(file) ? snapshotFile(file) : null;
    const status = snapshot === null ? "missing" : (snapshot.sha256 === item.source.sha256 && snapshot.mode === item.source.mode ? "matches_source" : "review_required");
    return { ...item, target: snapshot, status };
  });
  return {
    source_root: source, source_version: sourceVersion, source_commit: sourceCommit, source_git: identity,
    target_root: target, target_git: targetGit, target_interfaces: selection.interfaces,
    gui_framework: selection.guiFramework, nsh_targets: selection.nshTargets ?? [],
    engineering_baseline: "not_verified", runtime, files,
  };
}
