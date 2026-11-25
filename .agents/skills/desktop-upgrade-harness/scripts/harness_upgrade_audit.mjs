#!/usr/bin/env node
/** Harness 升级后置审计：依赖与遗留清理盘点、项目结构最佳实践检测、综合验证及当前版本豁免管理（下次升级自动失效）。 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { loadLock } from "./harness_upgrade_ownership.mjs";
import { LOCK_RELATIVE } from "./harness_upgrade_policy.mjs";
import { UpgradeError, assertSafePath, canonicalDirectory, loadJson, lstatOrNull } from "./harness_upgrade_safety.mjs";
import { inspectProjectStructure, stripTomlComment } from "./harness_upgrade_structure.mjs";

export const EXEMPTIONS_RELATIVE = path.join(".harness", "upgrade-exemptions.json");
export const EXEMPTIONS_SCHEMA_VERSION = 1;

const RETIRED_CRATES_OR_NPM = new Set([
  "tauri-plugin-updater", "@tauri-apps/plugin-updater",
  "sentry", "posthog-js", "@aptabase/tauri", "tauri-plugin-aptabase",
]);
const RETIRED_DOC_MARKERS = [
  "desktop-enable-gui-updates",
  "desktop-add-gui-telemetry",
  "desktop-add-gui-updater",
  "check_no_python.mjs",
];

function parseSemverTuple(raw) {
  if (typeof raw !== "string") return null;
  const match = /(\d+)\.(\d+)\.(\d+)/u.exec(raw);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function readCandidatesCatalog(targetRoot, sourceRoot) {
  const rel = path.join(".agents", "skills", "desktop-manage-dependencies", "references", "registry-candidates.json");
  for (const base of [sourceRoot, targetRoot].filter(Boolean)) {
    const candidate = path.join(base, rel);
    if (lstatOrNull(candidate)?.isFile()) return loadJson(candidate, "依赖候选快照");
  }
  return null;
}

function parseRootCargoDependencies(cargoText) {
  const deps = new Map();
  let section = "";
  let rustVersion = null;
  for (const rawLine of cargoText.split(/\r?\n/u)) {
    const line = stripTomlComment(rawLine);
    if (!line) continue;
    const header = /^\[([^\]]+)\]$/u.exec(line);
    if (header) { section = header[1].trim(); continue; }
    if (["package", "workspace.package"].includes(section)) {
      const rv = /^rust-version\s*=\s*["']([^"']+)["']$/u.exec(line);
      if (rv) rustVersion = rv[1];
    }
    if (!["workspace.dependencies", "dependencies", "dev-dependencies", "build-dependencies"].includes(section)) continue;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/u.exec(line);
    if (!match) continue;
    const [, name, rhs] = match;
    if (/\bpath\s*=/u.test(rhs)) continue;
    const simple = /^["']([^"']+)["']$/u.exec(rhs);
    const inline = /\bversion\s*=\s*["']([^"']+)["']/u.exec(rhs);
    const version = simple?.[1] ?? inline?.[1] ?? null;
    if (version && !deps.has(name)) deps.set(name, { version, section });
  }
  return { deps, rustVersion };
}

function collectFilesMatching(root, predicate, maxDepth = 4) {
  const results = [];
  const visit = (dir, depth) => {
    if (depth > maxDepth) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if ([".git", "node_modules", "target", "dist", "coverage", ".nsh", "release", ".agents", ".harness"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(full, depth + 1);
      else if (entry.isFile()) {
        const rel = path.relative(root, full).split(path.sep).join("/");
        if (predicate(rel, entry.name)) results.push(rel);
      }
    }
  };
  visit(root, 0);
  return results.sort();
}

/** 扫描下游依赖与最新候选基线的差异，以及需要同步清理收窄的遗留旧代码/依赖/能力/文档信号。 */
export function auditDependenciesAndLegacy(targetRoot, { sourceRoot = null } = {}) {
  const target = canonicalDirectory(targetRoot, "目标根目录");
  const source = sourceRoot ? canonicalDirectory(sourceRoot, "源 Harness 根目录") : null;
  const catalog = readCandidatesCatalog(target, source);

  const rustUpgrades = [];
  const npmUpgrades = [];
  const toolchainDrift = [];
  const legacyCleanupSignals = [];

  const rootCargoPath = path.join(target, "Cargo.toml");
  if (lstatOrNull(rootCargoPath)?.isFile()) {
    const cargoText = fs.readFileSync(rootCargoPath, "utf8");
    const { deps, rustVersion } = parseRootCargoDependencies(cargoText);
    if (catalog?.constraints?.rustMsrv && rustVersion) {
      const cur = parseSemverTuple(rustVersion);
      const want = parseSemverTuple(catalog.constraints.rustMsrv);
      if (cur && want && compareSemver(cur, want) < 0) {
        toolchainDrift.push({ tool: "rust-version", current: rustVersion, candidate: catalog.constraints.rustMsrv, manifest: "Cargo.toml" });
      }
    }
    for (const [name, info] of deps) {
      if (RETIRED_CRATES_OR_NPM.has(name)) {
        legacyCleanupSignals.push({ kind: "retired-dependency", path: "Cargo.toml", detail: `检测到已退役/旧能力依赖 crate：${name} (${info.version})` });
      }
      const catalogEntry = catalog?.crates?.[name];
      if (!catalogEntry) continue;
      const cur = parseSemverTuple(info.version);
      const want = parseSemverTuple(catalogEntry.version);
      if (cur && want && compareSemver(cur, want) < 0) {
        rustUpgrades.push({ name, current: info.version, candidate: catalogEntry.version, manifest: "Cargo.toml", section: info.section });
      }
    }
    // 检查根 [workspace.dependencies] 中未被任何成员 Cargo.toml 引用的疑似孤儿依赖
    const memberCargos = collectFilesMatching(target, (rel, base) => rel !== "Cargo.toml" && base === "Cargo.toml", 4);
    if (memberCargos.length > 0) {
      const memberBody = memberCargos.map((rel) => fs.readFileSync(path.join(target, rel), "utf8")).join("\n");
      for (const [name, info] of deps) {
        if (info.section !== "workspace.dependencies") continue;
        const refPattern = new RegExp(`(?:^|[^A-Za-z0-9_-])${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?:$|[^A-Za-z0-9_-])`, "u");
        if (!refPattern.test(memberBody)) {
          legacyCleanupSignals.push({ kind: "unused-workspace-dependency", path: "Cargo.toml", detail: `根 [workspace.dependencies] 中的 ${name} 未被任何成员 Cargo.toml 引用，升级时可评估清理` });
        }
      }
    }
  }

  const pkgFiles = collectFilesMatching(target, (_, base) => base === "package.json", 3);
  for (const rel of pkgFiles) {
    let pkg;
    try { pkg = loadJson(path.join(target, rel), rel); } catch { continue; }
    for (const section of ["dependencies", "devDependencies"]) {
      const table = pkg[section];
      if (!table || typeof table !== "object") continue;
      for (const [name, declared] of Object.entries(table)) {
        if (typeof declared !== "string") continue;
        if (RETIRED_CRATES_OR_NPM.has(name)) {
          legacyCleanupSignals.push({ kind: "retired-dependency", path: rel, detail: `检测到已退役/旧能力 npm 依赖：${name} (${declared})` });
        }
        const catalogEntry = catalog?.npm?.[name];
        if (!catalogEntry) continue;
        const cur = parseSemverTuple(declared);
        const want = parseSemverTuple(catalogEntry.version);
        if (cur && want && compareSemver(cur, want) < 0) {
          npmUpgrades.push({
            name,
            current: declared,
            candidate: catalogEntry.dependencyRange ?? `^${catalogEntry.version}`,
            manifest: rel,
            section,
          });
        }
      }
    }
  }

  // 扫描手写 /usr/bin/open 等可由官方插件替代的旧代码信号，以及文档中的退役入口残留
  const rustSources = collectFilesMatching(target, (rel) => rel.endsWith(".rs"), 5);
  for (const rel of rustSources) {
    const content = fs.readFileSync(path.join(target, rel), "utf8");
    if (content.includes("/usr/bin/open") && (/(?:notification|通知)/iu.test(content) || /notification/iu.test(rel))) {
      legacyCleanupSignals.push({
        kind: "legacy-code-replaceable-by-official",
        path: rel,
        detail: "检测到手写 `/usr/bin/open` 打开通知设置，升级 Tauri 依赖时可改用官方 Rust-only `tauri-plugin-opener` 并清理旧子进程代码",
      });
    }
  }
  const docFiles = collectFilesMatching(target, (rel) => rel.endsWith(".md"), 3);
  for (const rel of docFiles) {
    const content = fs.readFileSync(path.join(target, rel), "utf8");
    for (const marker of RETIRED_DOC_MARKERS) {
      if (content.includes(marker)) {
        legacyCleanupSignals.push({
          kind: "legacy-doc-reference",
          path: rel,
          detail: `文档仍引用已退役或仅上游专用的入口：${marker}`,
        });
      }
    }
  }

  return {
    status: (rustUpgrades.length + npmUpgrades.length + toolchainDrift.length + legacyCleanupSignals.length) > 0
      ? "upgrades-or-cleanup-available" : "up-to-date",
    projectRoot: target,
    catalogCheckedOn: catalog?.checkedOn ?? null,
    hasUpgradeCandidates: rustUpgrades.length > 0 || npmUpgrades.length > 0 || toolchainDrift.length > 0,
    hasLegacySignals: legacyCleanupSignals.length > 0,
    rustUpgrades,
    npmUpgrades,
    toolchainDrift,
    legacyCleanupSignals,
    cleanupScopeWhenUpgrading: [
      "清理已被新版官方生态/API 取代的旧兼容代码、手工子进程或死代码分支",
      "移除根 Cargo.toml、成员清单与 package.json 中不再使用的旧依赖并收窄最小 features",
      "清理已关闭或退役能力残留的命令、ACL、配置、i18n 键与资源文件（不改动已批准现行产品能力）",
      "同步清理并收窄 README 与项目文档中过时的版本、依赖、命令和旧能力说明",
    ],
  };
}

/** 严格校验 `.harness/upgrade-exemptions.json` 结构。 */
export function loadExemptions(targetRoot) {
  const file = assertSafePath(targetRoot, path.join(targetRoot, EXEMPTIONS_RELATIVE), "升级豁免记录", { finalMayBeMissing: true });
  if (!lstatOrNull(file)) return null;
  const data = loadJson(file, "升级豁免记录");
  if (data.schema_version !== EXEMPTIONS_SCHEMA_VERSION) {
    throw new UpgradeError(`upgrade-exemptions.json 的 schema_version 必须为 ${EXEMPTIONS_SCHEMA_VERSION}`);
  }
  if (typeof data.harness_version !== "string" || !data.harness_version
    || typeof data.harness_commit !== "string" || !/^[0-9a-f]{40}$/u.test(data.harness_commit)) {
    throw new UpgradeError("upgrade-exemptions.json 缺少合法的 harness_version 或 40 位 harness_commit 绑定");
  }
  if (!Array.isArray(data.exemptions)) throw new UpgradeError("upgrade-exemptions.json 的 exemptions 必须是数组");
  for (const item of data.exemptions) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new UpgradeError("豁免条目必须是对象");
    for (const key of ["id", "category", "rule", "path", "reason", "confirmed_by", "confirmed_at"]) {
      if (typeof item[key] !== "string" || !item[key].trim()) {
        throw new UpgradeError(`豁免条目缺少非空字段 ${key}`);
      }
    }
  }
  return { file, data };
}

function checkBrokenSkillLinksInAgents(targetRoot, findings) {
  const agentsPath = path.join(targetRoot, "AGENTS.md");
  if (!lstatOrNull(agentsPath)?.isFile()) return;
  const content = fs.readFileSync(agentsPath, "utf8");
  for (const match of content.matchAll(/\]\((\.agents\/skills\/[^)#\s]+)\)/gu)) {
    const rel = match[1];
    if (!lstatOrNull(path.join(targetRoot, ...rel.split("/")))) {
      findings.push({
        id: `constraint.broken-skill-link:${rel}`,
        category: "constraint",
        severity: "style",
        exemptable: true,
        rule: "AGENTS.md 中的项目 Skills 链接必须指向实际存在的本地入口",
        path: "AGENTS.md",
        summary: `AGENTS.md 链接了不存在的 Skill 入口：${rel}`,
        remediation: "移除已裁剪/退役 Skill 链接或补齐缺失的受管 Skill 文件。",
      });
    }
  }
}

/** 综合验证 Harness 升级结果，并自动令旧版本记录的豁免全部失效。 */
export function verifyPostUpgrade(targetRoot, { sourceRoot = null, lockPath = null } = {}) {
  const target = canonicalDirectory(targetRoot, "目标根目录");
  const resolvedLock = lockPath ? path.resolve(lockPath) : path.join(target, LOCK_RELATIVE);
  const lock = loadLock(resolvedLock);
  const currentSource = lock?.harness_source ?? null;

  const loadedExemptions = loadExemptions(target);
  let activeExemptions = [];
  let expiredExemptions = [];
  if (loadedExemptions) {
    const sameVersion = currentSource !== null
      && loadedExemptions.data.harness_version === currentSource.version
      && loadedExemptions.data.harness_commit === currentSource.commit;
    if (sameVersion) {
      activeExemptions = loadedExemptions.data.exemptions;
    } else {
      expiredExemptions = loadedExemptions.data.exemptions.map((item) => ({
        ...item,
        previous_harness_version: loadedExemptions.data.harness_version,
        previous_harness_commit: loadedExemptions.data.harness_commit,
        expired_reason: "Harness 已升级到新版本或提交，上一版本豁免自动失效，需重新评估调整或记录新版本豁免",
      }));
    }
  }

  const structureReport = inspectProjectStructure(target);
  const depReport = auditDependenciesAndLegacy(target, { sourceRoot });
  const allFindings = [...structureReport.findings];
  checkBrokenSkillLinksInAgents(target, allFindings);

  for (const signal of depReport.legacyCleanupSignals) {
    if (signal.kind === "legacy-doc-reference" || signal.kind === "retired-dependency") {
      allFindings.push({
        id: `constraint.${signal.kind}:${signal.path}`,
        category: "constraint",
        severity: "style",
        exemptable: true,
        rule: "升级后不应残留已退役能力依赖或失效文档引用",
        path: signal.path,
        summary: signal.detail,
        remediation: "结合依赖升级一并清理该遗留项，或明确记录当前版本豁免（下次升级自动失效）。",
      });
    }
  }

  const activeById = new Map(activeExemptions.map((item) => [item.id, item]));
  const unresolvedFindings = [];
  const exemptedFindings = [];

  for (const finding of allFindings.sort((a, b) => a.id.localeCompare(b.id, "en"))) {
    const matchedExemption = finding.exemptable ? activeById.get(finding.id) : null;
    if (matchedExemption) {
      exemptedFindings.push({ ...finding, status: "exempted_for_current_version", exemption: matchedExemption });
    } else {
      unresolvedFindings.push({ ...finding, status: "unresolved" });
    }
  }

  const unresolvedHard = unresolvedFindings.filter((f) => f.severity === "hard").length;
  const unresolvedAdjustable = unresolvedFindings.length - unresolvedHard;
  const status = unresolvedFindings.length > 0
    ? "attention_required"
    : (exemptedFindings.length > 0 ? "passed_with_exemptions" : "passed");

  return {
    status,
    projectRoot: target,
    harnessSource: currentSource,
    exemptionsFile: path.join(target, EXEMPTIONS_RELATIVE),
    expiredExemptions,
    activeExemptions,
    unresolvedFindings,
    exemptedFindings,
    dependencySummary: {
      hasUpgradeCandidates: depReport.hasUpgradeCandidates,
      rustUpgradeCount: depReport.rustUpgrades.length,
      npmUpgradeCount: depReport.npmUpgrades.length,
      legacySignalCount: depReport.legacyCleanupSignals.length,
    },
    checks: structureReport.checks,
    summary: {
      unresolvedHard,
      unresolvedAdjustable,
      exempted: exemptedFindings.length,
      expired: expiredExemptions.length,
    },
  };
}

/** 将用户逐项确认的当前版本豁免原子写入受保护的 `.harness/upgrade-exemptions.json`，绑定当前 Harness 版本与提交。 */
export function recordExemptions(targetRoot, { lockPath = null, inputPath } = {}) {
  const target = canonicalDirectory(targetRoot, "目标根目录");
  const resolvedLock = lockPath ? path.resolve(lockPath) : path.join(target, LOCK_RELATIVE);
  const lock = loadLock(resolvedLock);
  if (!lock?.harness_source?.version || !lock?.harness_source?.commit) {
    throw new UpgradeError("必须先通过 harness_upgrade.mjs record 记录当前来源锁，才能记录当前版本豁免");
  }
  const resolvedInput = path.resolve(inputPath);
  const inputStat = lstatOrNull(resolvedInput);
  if (!inputStat || inputStat.isSymbolicLink() || !inputStat.isFile()) {
    throw new UpgradeError(`豁免确认输入必须是普通非符号链接文件：${resolvedInput}`);
  }
  let rawInput;
  try { rawInput = JSON.parse(fs.readFileSync(resolvedInput, "utf8")); }
  catch (error) { throw new UpgradeError(`豁免确认输入不是合法 JSON：${error.message}`); }
  const items = Array.isArray(rawInput) ? rawInput : rawInput?.exemptions;
  if (!Array.isArray(items)) throw new UpgradeError("豁免输入必须是数组或包含 exemptions 数组的对象");

  const now = new Date().toISOString().replace("Z", "+00:00");
  const seenIds = new Set();
  const normalized = [];
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new UpgradeError("豁免项必须是对象");
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) throw new UpgradeError("豁免项缺少非空 id");
    if (id.startsWith("constraint.file-line-hard-limit:") || id.startsWith("constraint.core-first:")) {
      throw new UpgradeError(`硬性规则不允许豁免，必须重构调整：${id}`);
    }
    if (seenIds.has(id)) throw new UpgradeError(`豁免项 id 重复：${id}`);
    seenIds.add(id);
    const record = {
      id,
      category: String(item.category ?? "style").trim(),
      rule: String(item.rule ?? "").trim(),
      path: String(item.path ?? "").trim(),
      reason: String(item.reason ?? "").trim(),
      confirmed_by: String(item.confirmed_by ?? "").trim(),
      confirmed_at: typeof item.confirmed_at === "string" && item.confirmed_at.trim() ? item.confirmed_at.trim() : now,
    };
    for (const key of ["category", "rule", "path", "reason", "confirmed_by"]) {
      if (!record[key]) throw new UpgradeError(`豁免项 ${id} 缺少非空字段 ${key}`);
    }
    normalized.push(record);
  }
  normalized.sort((a, b) => a.id.localeCompare(b.id, "en"));

  const payload = {
    schema_version: EXEMPTIONS_SCHEMA_VERSION,
    harness_version: lock.harness_source.version,
    harness_commit: lock.harness_source.commit,
    expires_on_next_upgrade: true,
    recorded_at: now,
    exemptions: normalized,
  };

  const exemptionsPath = assertSafePath(target, path.join(target, EXEMPTIONS_RELATIVE), "升级豁免记录", { finalMayBeMissing: true });
  const harnessDir = path.join(target, ".harness");
  if (!lstatOrNull(harnessDir)) fs.mkdirSync(harnessDir, { mode: 0o755 });
  const temp = path.join(harnessDir, `.upgrade-exemptions-${crypto.randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    const existing = lstatOrNull(exemptionsPath);
    if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
      throw new UpgradeError("upgrade-exemptions.json 必须是普通非符号链接文件");
    }
    fs.renameSync(temp, exemptionsPath);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temp, { force: true });
  }

  return {
    status: "recorded",
    exemptionsFile: exemptionsPath,
    harnessVersion: payload.harness_version,
    harnessCommit: payload.harness_commit,
    count: normalized.length,
    expiresOnNextUpgrade: true,
  };
}

function parseCli(argv) {
  const command = argv[0];
  if (!["deps", "structure", "verify", "record-exemptions"].includes(command)) {
    throw new UpgradeError("必须提供 deps、structure、verify 或 record-exemptions 子命令");
  }
  const options = {
    "project-root": { type: "string" },
    "source-root": { type: "string" },
    lock: { type: "string" },
    input: { type: "string" },
  };
  let values;
  try { ({ values } = parseArgs({ args: argv.slice(1), options, strict: true })); }
  catch (error) { throw new UpgradeError(error.message); }
  if (!values["project-root"]) throw new UpgradeError("缺少必需参数 --project-root");
  if (command === "record-exemptions" && !values.input) throw new UpgradeError("record-exemptions 必须提供 --input");
  return { command, values };
}

export function execute(argv) {
  const { command, values } = parseCli(argv);
  if (command === "deps") {
    return { result: auditDependenciesAndLegacy(values["project-root"], { sourceRoot: values["source-root"] ?? null }), exitCode: 0 };
  }
  if (command === "structure") {
    const result = inspectProjectStructure(values["project-root"]);
    return { result, exitCode: result.summary.hard > 0 ? 2 : 0 };
  }
  if (command === "verify") {
    const result = verifyPostUpgrade(values["project-root"], { sourceRoot: values["source-root"] ?? null, lockPath: values.lock ?? null });
    return { result, exitCode: result.unresolvedFindings.length > 0 ? 2 : 0 };
  }
  return { result: recordExemptions(values["project-root"], { lockPath: values.lock ?? null, inputPath: values.input }), exitCode: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { result, exitCode } = execute(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
    process.exitCode = 2;
  }
}
