#!/usr/bin/env node
/** 自动识别开发过程中产生的未跟踪生成物，并在遵守锁策略与已跟踪文件保护前提下增量写入 `.gitignore`。 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { readDependencyLockPolicy } from "./project_lock_policy.mjs";

export const MANAGED_BLOCK_START = "# >>> agent-first-harness:auto-gitignore >>>";
export const MANAGED_BLOCK_END = "# <<< agent-first-harness:auto-gitignore <<<";

export class GitignoreSyncError extends Error {}

/** 开发过程中常见生成物的分类规则；按顺序匹配并产出规范 `.gitignore` 规则。 */
export const GENERATED_ARTIFACT_RULES = [
  { id: "rust-target", category: "rust", pattern: "**/target/", match: (p) => /(?:^|\/)target\//u.test(p) },
  { id: "rust-profraw", category: "rust", pattern: "*.profraw", match: (p) => p.endsWith(".profraw") },
  { id: "rust-profdata", category: "rust", pattern: "*.profdata", match: (p) => p.endsWith(".profdata") },
  { id: "coverage-lcov", category: "test", pattern: "*.lcov", match: (p) => p.endsWith(".lcov") },
  { id: "rust-backup", category: "rust", pattern: "**/*.rs.bk", match: (p) => p.endsWith(".rs.bk") },
  { id: "rust-pdb", category: "rust", pattern: "*.pdb", match: (p) => p.endsWith(".pdb") },
  { id: "macos-dsym", category: "rust", pattern: "*.dSYM/", match: (p) => /(?:^|\/)[^/]+\.dSYM\//u.test(p) },
  { id: "cargo-timings", category: "rust", pattern: "**/cargo-timings/", match: (p) => /(?:^|\/)cargo-timings\//u.test(p) },
  { id: "lock-cargo", category: "lock", pattern: "Cargo.lock", lockSensitive: true, match: (p) => /(?:^|\/)Cargo\.lock$/u.test(p) },
  { id: "lock-pnpm", category: "lock", pattern: "pnpm-lock.yaml", lockSensitive: true, match: (p) => /(?:^|\/)pnpm-lock\.yaml$/u.test(p) },
  { id: "lock-pnpm-nonstandard", category: "lock", pattern: "pnpm-package.lock", match: (p) => /(?:^|\/)pnpm-package\.lock$/u.test(p) },
  { id: "node-modules", category: "frontend", pattern: "**/node_modules/", match: (p) => /(?:^|\/)node_modules\//u.test(p) },
  { id: "frontend-dist", category: "frontend", pattern: "**/dist/", match: (p) => /(?:^|\/)dist\//u.test(p) },
  { id: "coverage-dir", category: "test", pattern: "**/coverage/", match: (p) => /(?:^|\/)coverage\//u.test(p) },
  { id: "vite-cache", category: "frontend", pattern: "**/.vite/", match: (p) => /(?:^|\/)\.vite\//u.test(p) },
  { id: "vitest-cache", category: "test", pattern: "**/.vitest/", match: (p) => /(?:^|\/)\.vitest\//u.test(p) },
  { id: "ts-buildinfo", category: "frontend", pattern: "*.tsbuildinfo", match: (p) => p.endsWith(".tsbuildinfo") },
  { id: "eslint-cache", category: "frontend", pattern: ".eslintcache", match: (p) => /(?:^|\/)\.eslintcache$/u.test(p) },
  { id: "turbo-cache", category: "frontend", pattern: "**/.turbo/", match: (p) => /(?:^|\/)\.turbo\//u.test(p) },
  { id: "parcel-cache", category: "frontend", pattern: "**/.parcel-cache/", match: (p) => /(?:^|\/)\.parcel-cache\//u.test(p) },
  { id: "playwright-report", category: "test", pattern: "/playwright-report/", match: (p) => p.startsWith("playwright-report/") },
  { id: "test-results", category: "test", pattern: "/test-results/", match: (p) => p.startsWith("test-results/") },
  { id: "nsh-runtime", category: "nsh", pattern: "**/.nsh/", match: (p) => /(?:^|\/)\.nsh\//u.test(p) },
  { id: "tauri-gen-schemas", category: "tauri", pattern: "**/src-tauri/gen/schemas/", match: (p) => /(?:^|\/)src-tauri\/gen\/schemas\//u.test(p) },
  { id: "scip-index", category: "analysis", pattern: "*.scip", match: (p) => p.endsWith(".scip") },
  { id: "scip-dir", category: "analysis", pattern: "**/.scip/", match: (p) => /(?:^|\/)\.scip\//u.test(p) },
  { id: "release-dir", category: "release", pattern: "/release/", match: (p) => p.startsWith("release/") },
  { id: "release-clean", category: "release", pattern: "/.release-clean.*", match: (p) => p.startsWith(".release-clean.") },
  { id: "knowledge-dir", category: "harness", pattern: "/knowledge/", match: (p) => p.startsWith("knowledge/") },
  { id: "archify-skill", category: "harness", pattern: "/.harness/skills/archify/", match: (p) => p.startsWith(".harness/skills/archify/") },
  { id: "harness-tmp", category: "harness", pattern: "/.harness/tmp/", match: (p) => p.startsWith(".harness/tmp/") },
  { id: "harness-cache", category: "harness", pattern: "/.harness/cache/", match: (p) => p.startsWith(".harness/cache/") },
  { id: "logs-general", category: "logs", pattern: "*.log", match: (p) => p.endsWith(".log") },
  { id: "logs-npm", category: "logs", pattern: "npm-debug.log*", match: (p) => /(?:^|\/)npm-debug\.log/u.test(p) },
  { id: "logs-pnpm", category: "logs", pattern: "pnpm-debug.log*", match: (p) => /(?:^|\/)pnpm-debug\.log/u.test(p) },
  { id: "env-local", category: "env", pattern: ".env.local", match: (p) => /(?:^|\/)\.env\.local$/u.test(p) },
  { id: "env-scoped-local", category: "env", pattern: ".env.*.local", match: (p) => /(?:^|\/)\.env\.[^/]+\.local$/u.test(p) },
  { id: "os-ds-store", category: "os", pattern: ".DS_Store", match: (p) => /(?:^|\/)\.DS_Store$/u.test(p) },
  { id: "os-thumbs", category: "os", pattern: "Thumbs.db", match: (p) => /(?:^|\/)Thumbs\.db$/u.test(p) },
  { id: "os-desktop-ini", category: "os", pattern: "Desktop.ini", match: (p) => /(?:^|\/)Desktop\.ini$/u.test(p) },
  { id: "editor-swp", category: "editor", pattern: "*.swp", match: (p) => p.endsWith(".swp") },
  { id: "editor-swo", category: "editor", pattern: "*.swo", match: (p) => p.endsWith(".swo") },
  { id: "temp-tmp", category: "temp", pattern: "*.tmp", match: (p) => p.endsWith(".tmp") },
  { id: "temp-bak", category: "temp", pattern: "*.bak", match: (p) => p.endsWith(".bak") },
  { id: "editor-tilde", category: "editor", pattern: "*~", match: (p) => p.endsWith("~") },
];

/** 适用于所有下游项目的最小基础忽略规则（锁文件按项目策略动态决定）。 */
export const BASELINE_PATTERNS = [
  "/target/",
  "**/target/",
  "/release/",
  "/.release-clean.*",
  "/knowledge/",
  "/.harness/skills/archify/",
  "/.harness/tmp/",
  "/.harness/cache/",
  "*.profraw",
  "*.profdata",
  "*.lcov",
  "**/*.rs.bk",
  "*.scip",
  "**/.scip/",
  "*.log",
  ".DS_Store",
  "Thumbs.db",
  "Desktop.ini",
  "*.swp",
  "*.swo",
  "*.tmp",
  "*~",
];

function lstatOrNull(target) {
  try { return fs.lstatSync(target); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function runGit(root, args, { check = true } = {}) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: null, maxBuffer: 32 * 1024 * 1024 });
  if (result.error?.code === "ENOENT") throw new GitignoreSyncError("git 可执行文件不可用");
  if (result.error) throw new GitignoreSyncError(`git ${args.join(" ")} 执行失败：${result.error.message}`);
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const stdout = decoder.decode(result.stdout ?? Buffer.alloc(0));
  const stderr = decoder.decode(result.stderr ?? Buffer.alloc(0));
  if (check && result.status !== 0) {
    throw new GitignoreSyncError(`git ${args.join(" ")} 失败：${stderr.trim() || stdout.trim() || "未知错误"}`);
  }
  return { status: result.status ?? 1, stdout, stderr };
}

/** 验证项目根目录为普通非符号链接目录，且精确等于独立 Git 仓库顶层。 */
export function resolveGitRoot(projectRoot) {
  const supplied = path.resolve(projectRoot);
  const stat = lstatOrNull(supplied);
  if (!stat) throw new GitignoreSyncError(`项目目录不存在：${supplied}`);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new GitignoreSyncError(`项目根目录必须是普通目录：${supplied}`);
  const canonical = fs.realpathSync(supplied);
  const top = runGit(canonical, ["rev-parse", "--show-toplevel"]).stdout.trim();
  if (fs.realpathSync(top) !== canonical) {
    throw new GitignoreSyncError(`目标目录必须是独立 Git 仓库顶层：${canonical}`);
  }
  return canonical;
}

/** 将一条简单的 `.gitignore` 规则转换为正则，用于检查是否会误匹配已跟踪文件。 */
function gitignorePatternToRegex(rawPattern) {
  let pattern = rawPattern.trim();
  const anchored = pattern.startsWith("/");
  if (anchored) pattern = pattern.slice(1);
  const dirOnly = pattern.endsWith("/");
  if (dirOnly) pattern = pattern.slice(0, -1);
  const hasSlash = pattern.includes("/");
  let regexSource = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const ch = pattern[index];
    if (ch === "*" && pattern[index + 1] === "*") {
      if (pattern[index + 2] === "/") { regexSource += "(?:.*/)?"; index += 2; }
      else { regexSource += ".*"; index += 1; }
    } else if (ch === "*") regexSource += "[^/]*";
    else if (ch === "?") regexSource += "[^/]";
    else regexSource += ch.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
  }
  const prefix = anchored || hasSlash ? "^" : "(?:^|/)";
  const suffix = dirOnly ? "(?:/.*)?$" : "(?:/.*)?$";
  return new RegExp(`${prefix}${regexSource}${suffix}`, "u");
}

function validateExtraPattern(raw) {
  if (typeof raw !== "string") throw new GitignoreSyncError("忽略规则必须是字符串");
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) {
    throw new GitignoreSyncError(`非法的忽略规则（不能为空、注释或否定规则）：${JSON.stringify(raw)}`);
  }
  if (/[\r\n\u0000-\u001f\u007f]/u.test(trimmed) || trimmed.includes("\\") || trimmed.split("/").includes("..")) {
    throw new GitignoreSyncError(`忽略规则包含非法控制字符、反斜杠或上级目录跳转：${JSON.stringify(raw)}`);
  }
  return trimmed;
}

function readGitignoreState(root) {
  const gitignorePath = path.join(root, ".gitignore");
  const stat = lstatOrNull(gitignorePath);
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) {
    throw new GitignoreSyncError(".gitignore 必须是普通非符号链接文件");
  }
  if (!stat) return { gitignorePath, exists: false, content: "", existingRules: new Set() };
  const raw = fs.readFileSync(gitignorePath);
  let content;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(raw); }
  catch { throw new GitignoreSyncError(".gitignore 不是合法的 UTF-8 文件"); }
  const existingRules = new Set();
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) existingRules.add(trimmed);
  }
  return { gitignorePath, exists: true, content, existingRules };
}

function readLockPolicySafe(root) {
  const cargoPath = path.join(root, "Cargo.toml");
  if (!lstatOrNull(cargoPath)) return "ignored";
  return readDependencyLockPolicy(root);
}

function listTrackedFiles(root) {
  const stdout = runGit(root, ["ls-files", "-z"]).stdout;
  return stdout.split("\0").filter(Boolean);
}

function listUntrackedFiles(root) {
  const stdout = runGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]).stdout;
  const files = [];
  for (const entry of stdout.split("\0")) {
    if (entry.startsWith("?? ")) files.push(entry.slice(3));
  }
  return files.sort();
}

function isLockPattern(pattern) {
  return pattern === "Cargo.lock" || pattern === "pnpm-lock.yaml"
    || pattern === "/Cargo.lock" || pattern === "/pnpm-lock.yaml";
}

/** 只读扫描当前仓库的未跟踪生成物与 `.gitignore` 缺口。 */
export function inspectGitignore(projectRoot, { includeBaseline = false, extraPatterns = [] } = {}) {
  const root = resolveGitRoot(projectRoot);
  const lockPolicy = readLockPolicySafe(root);
  const state = readGitignoreState(root);
  const trackedFiles = listTrackedFiles(root);
  const untrackedFiles = listUntrackedFiles(root);

  const detectedGeneratedFiles = [];
  const candidateMap = new Map();
  const lockPolicyWarnings = [];

  if (lockPolicy === "tracked") {
    for (const lockName of ["Cargo.lock", "pnpm-lock.yaml"]) {
      if (state.existingRules.has(lockName) || state.existingRules.has(`/${lockName}`)) {
        lockPolicyWarnings.push(`项目声明 dependency-lock-policy = "tracked"，但 .gitignore 仍包含 ${lockName}`);
      }
    }
  }

  for (const file of untrackedFiles) {
    for (const rule of GENERATED_ARTIFACT_RULES) {
      if (rule.lockSensitive && lockPolicy === "tracked") continue;
      if (!rule.match(file)) continue;
      detectedGeneratedFiles.push({ path: file, ruleId: rule.id, category: rule.category, pattern: rule.pattern });
      if (!candidateMap.has(rule.pattern)) {
        candidateMap.set(rule.pattern, { pattern: rule.pattern, source: "detected", category: rule.category, matchedPaths: [] });
      }
      candidateMap.get(rule.pattern).matchedPaths.push(file);
      break;
    }
  }

  if (includeBaseline) {
    const baseline = lockPolicy === "tracked"
      ? BASELINE_PATTERNS
      : [...BASELINE_PATTERNS, "Cargo.lock", "pnpm-lock.yaml", "pnpm-package.lock"];
    for (const pattern of baseline) {
      if (!candidateMap.has(pattern)) {
        candidateMap.set(pattern, { pattern, source: "baseline", category: "baseline", matchedPaths: [] });
      }
    }
  }

  for (const raw of extraPatterns) {
    const pattern = validateExtraPattern(raw);
    if (lockPolicy === "tracked" && isLockPattern(pattern)) {
      lockPolicyWarnings.push(`跳过锁文件忽略规则 ${pattern}（当前项目 dependency-lock-policy = "tracked"）`);
      continue;
    }
    if (!candidateMap.has(pattern)) {
      candidateMap.set(pattern, { pattern, source: "explicit", category: "custom", matchedPaths: [] });
    }
  }

  const rulesToAdd = [];
  const alreadyCovered = [];
  const skippedTrackedConflicts = [];

  for (const [pattern, detail] of candidateMap) {
    if (state.existingRules.has(pattern)) {
      alreadyCovered.push(pattern);
      continue;
    }
    const regex = gitignorePatternToRegex(pattern);
    const conflictingTracked = trackedFiles.filter((tracked) => regex.test(tracked));
    if (conflictingTracked.length > 0) {
      skippedTrackedConflicts.push({ pattern, trackedPaths: conflictingTracked.slice(0, 5), totalConflicts: conflictingTracked.length });
      continue;
    }
    rulesToAdd.push(detail);
  }

  return {
    status: rulesToAdd.length > 0 ? "changes-needed" : "up-to-date",
    projectRoot: root,
    gitignorePath: state.gitignorePath,
    gitignoreExists: state.exists,
    lockPolicy,
    detectedGeneratedFiles,
    rulesToAdd,
    alreadyCovered,
    skippedTrackedConflicts,
    lockPolicyWarnings,
  };
}

/** 原子写入 `.gitignore`，仅维护受管追加区块，不覆盖或重排用户既有规则。 */
function writeGitignoreAtomic(root, gitignorePath, nextContent) {
  const stat = lstatOrNull(gitignorePath);
  if (stat && (stat.isSymbolicLink() || !stat.isFile())) {
    throw new GitignoreSyncError(".gitignore 必须是普通非符号链接文件");
  }
  const temporary = path.join(root, `.gitignore.${crypto.randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temporary, "wx", 0o644);
    fs.writeFileSync(fd, nextContent, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    const beforeReplace = lstatOrNull(gitignorePath);
    if (beforeReplace && (beforeReplace.isSymbolicLink() || !beforeReplace.isFile())) {
      throw new GitignoreSyncError(".gitignore 在写入期间变为非普通文件");
    }
    fs.renameSync(temporary, gitignorePath);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
  }
}

function mergeManagedBlock(existingContent, addedPatterns) {
  const eol = existingContent.includes("\r\n") ? "\r\n" : "\n";
  const lines = existingContent.length ? existingContent.split(/\r?\n/u) : [];
  if (lines.length > 0 && lines.at(-1) === "") lines.pop();
  const startIdx = lines.indexOf(MANAGED_BLOCK_START);
  const endIdx = startIdx >= 0 ? lines.indexOf(MANAGED_BLOCK_END, startIdx + 1) : -1;
  if (startIdx >= 0 && endIdx > startIdx) {
    const inside = lines.slice(startIdx + 1, endIdx);
    const insideSet = new Set(inside.map((l) => l.trim()));
    const mergedInside = [...inside, ...addedPatterns.filter((p) => !insideSet.has(p))];
    const nextLines = [...lines.slice(0, startIdx + 1), ...mergedInside, ...lines.slice(endIdx)];
    return `${nextLines.join(eol)}${eol}`;
  }
  const prefix = lines.length > 0 ? [...lines, ""] : [];
  const nextLines = [
    ...prefix,
    MANAGED_BLOCK_START,
    "# 由 Harness 自动识别并追加的开发生成物忽略规则（可手动调整）",
    ...addedPatterns,
    MANAGED_BLOCK_END,
  ];
  return `${nextLines.join(eol)}${eol}`;
}

/** 自动同步 `.gitignore`，将缺失的开发生成物规则增量写入受管区块并复验忽略生效。 */
export function syncGitignore(projectRoot, { includeBaseline = false, extraPatterns = [], dryRun = false } = {}) {
  const inspection = inspectGitignore(projectRoot, { includeBaseline, extraPatterns });
  if (inspection.rulesToAdd.length === 0) {
    return { ...inspection, status: "up-to-date", updated: false, addedRules: [], verifiedIgnoredPaths: [] };
  }
  const addedRules = inspection.rulesToAdd.map((item) => item.pattern);
  if (dryRun) {
    return { ...inspection, status: "dry-run", updated: false, addedRules, verifiedIgnoredPaths: [] };
  }
  const currentContent = inspection.gitignoreExists ? fs.readFileSync(inspection.gitignorePath, "utf8") : "";
  const nextContent = mergeManagedBlock(currentContent, addedRules);
  writeGitignoreAtomic(inspection.projectRoot, inspection.gitignorePath, nextContent);

  const verifiedIgnoredPaths = [];
  for (const item of inspection.detectedGeneratedFiles) {
    if (!addedRules.includes(item.pattern)) continue;
    const check = runGit(inspection.projectRoot, ["check-ignore", "-q", "--no-index", "--", item.path], { check: false });
    if (check.status === 0) verifiedIgnoredPaths.push(item.path);
  }
  return { ...inspection, status: "updated", updated: true, addedRules, verifiedIgnoredPaths };
}

function parseCli(argv) {
  const command = argv[0];
  if (!["inspect", "sync"].includes(command)) {
    throw new GitignoreSyncError("必须提供 inspect 或 sync 子命令");
  }
  const options = {
    "project-root": { type: "string" },
    "include-baseline": { type: "boolean", default: false },
    pattern: { type: "string", multiple: true, default: [] },
  };
  if (command === "sync") options["dry-run"] = { type: "boolean", default: false };
  let values;
  try { ({ values } = parseArgs({ args: argv.slice(1), options, strict: true })); }
  catch (error) { throw new GitignoreSyncError(error.message); }
  if (!values["project-root"]) throw new GitignoreSyncError("必须提供 --project-root");
  return { command, values };
}

export function execute(argv) {
  const { command, values } = parseCli(argv);
  const opts = {
    includeBaseline: values["include-baseline"],
    extraPatterns: values.pattern,
    dryRun: Boolean(values["dry-run"]),
  };
  const result = command === "inspect"
    ? inspectGitignore(values["project-root"], opts)
    : syncGitignore(values["project-root"], opts);
  return { result, exitCode: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const { result, exitCode } = execute(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = exitCode;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "error", error: error.message })}\n`);
    process.exitCode = 2;
  }
}
