/** 检测下游项目结构与编码风格是否符合 Harness 最佳实践，并给出重构建议。 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { inspectRepository as inspectFileLineLimits } from "../../desktop-implement-change/scripts/check_file_line_limits.mjs";
import { inspectProject as inspectRustComments } from "../../desktop-implement-change/scripts/check_rust_chinese_comments.mjs";
import { inspectGitignore } from "../../desktop-implement-change/scripts/sync_gitignore.mjs";

const CATCHALL_NAMES = new Set(["utils", "util", "common", "helpers", "helper", "misc"]);
const GENERIC_SUFFIX_RE = /(?:^|[_-])(manager|processor|handler)$/iu;
const RUST_NON_MODULE_STEMS = new Set(["lib", "main", "mod", "build"]);
const FRONTEND_BARREL_NAMES = new Set(["index.ts", "index.tsx", "index.js", "index.jsx"]);
const PRODUCT_SOURCE_ROOTS = new Set(["src", "crates", "packages", "apps", "frontend", "src-tauri"]);

function lstatOrNull(target) {
  try { return fs.lstatSync(target); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

function listProjectFiles(root) {
  const res = spawnSync("git", ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.status === 0) return [...new Set(res.stdout.split("\0").filter(Boolean))].sort();
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if ([".git", "node_modules", "target", "dist", "coverage", ".nsh", "release"].includes(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  walk(root);
  return files.sort();
}

function isProductSourcePath(relative) {
  if (relative.startsWith(".agents/") || relative.startsWith(".harness/") || relative.startsWith("docs/")) return false;
  const segments = relative.split("/");
  if (segments.includes("fixtures") || segments.includes("tests")) return false;
  return segments.some((seg) => PRODUCT_SOURCE_ROOTS.has(seg));
}

export function stripTomlComment(line) {
  let quote = null;
  let escaped = false;
  let out = "";
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      out += ch;
      if (quote === '"' && escaped) escaped = false;
      else if (quote === '"' && ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") { quote = ch; out += ch; }
    else if (ch === "#") break;
    else out += ch;
  }
  return out.trim();
}

/** 检测成员 Cargo.toml 是否绕过根 [workspace.dependencies] 直接声明第三方版本号。 */
function detectUncentralizedWorkspaceDeps(root, files, findings) {
  const rootCargoPath = path.join(root, "Cargo.toml");
  if (!lstatOrNull(rootCargoPath)?.isFile()) return;
  const rootCargo = fs.readFileSync(rootCargoPath, "utf8");
  if (!/^\s*\[workspace\]/mu.test(rootCargo)) return;

  for (const relative of files) {
    if (relative === "Cargo.toml" || path.posix.basename(relative) !== "Cargo.toml") continue;
    const text = fs.readFileSync(path.join(root, relative), "utf8");
    let section = "";
    const directDeps = [];
    for (const rawLine of text.split(/\r?\n/u)) {
      const line = stripTomlComment(rawLine);
      if (!line) continue;
      const header = /^\[([^\]]+)\]$/u.exec(line);
      if (header) { section = header[1].trim(); continue; }
      if (!/(?:^|\.)(dependencies|dev-dependencies|build-dependencies)$/u.test(section)) continue;
      const assign = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/u.exec(line);
      if (!assign) continue;
      const [, crateName, rhs] = assign;
      if (/\bworkspace\s*=\s*true\b/u.test(rhs) || /\bpath\s*=/u.test(rhs)) continue;
      if (/^["'][^"']+["']$/u.test(rhs) || /\bversion\s*=/u.test(rhs)) directDeps.push(crateName);
    }
    if (directDeps.length > 0) {
      findings.push({
        id: `structure.workspace-deps-not-centralized:${relative}`,
        category: "structure",
        severity: "style",
        exemptable: true,
        rule: "根 [workspace.dependencies] 应集中声明第三方依赖，成员清单通过 workspace = true 复用",
        path: relative,
        summary: `成员清单直接声明了第三方版本号：${directDeps.join(", ")}`,
        remediation: "将上述依赖上移至根 Cargo.toml 的 [workspace.dependencies]，并在成员清单中改为 `workspace = true`。",
      });
    }
  }
}

/** 检测 Rust 模块是否同时存在 `<module>.rs` 与同名目录 `<module>/`。 */
function detectRustDualModuleLayouts(files, findings) {
  const rustDirs = new Set();
  for (const relative of files) {
    if (!relative.endsWith(".rs") || !isProductSourcePath(relative)) continue;
    let dir = path.posix.dirname(relative);
    while (dir && dir !== ".") {
      rustDirs.add(dir);
      dir = path.posix.dirname(dir);
    }
  }
  for (const relative of files) {
    if (!relative.endsWith(".rs") || !isProductSourcePath(relative)) continue;
    const stem = path.posix.basename(relative, ".rs");
    if (RUST_NON_MODULE_STEMS.has(stem)) continue;
    const siblingDir = path.posix.join(path.posix.dirname(relative), stem);
    if (rustDirs.has(siblingDir)) {
      findings.push({
        id: `structure.rust-dual-module-layout:${relative}`,
        category: "structure",
        severity: "style",
        exemptable: true,
        rule: "Rust 多文件模块应使用 `<module>/mod.rs` 目录结构，禁止 `<module>.rs` 与同名目录并存",
        path: relative,
        summary: `检测到 ${relative} 与同名子模块目录 ${siblingDir}/ 并存`,
        remediation: `将 ${relative} 迁入 ${siblingDir}/mod.rs，保持子模块目录高内聚并由 $desktop-refactor-code 核对引用。`,
      });
    }
  }
}

/** 检测兜底命名（utils/common/helpers/misc）、泛化命名提示与前端 `export *` 桶文件。 */
function detectNamingAndBarrelIssues(root, files, findings) {
  const seenCatchallDirs = new Set();
  for (const relative of files) {
    if (!isProductSourcePath(relative)) continue;
    const ext = path.posix.extname(relative).toLowerCase();
    const isCode = [".rs", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext);
    if (!isCode) continue;

    const segments = relative.split("/");
    for (let index = 0; index < segments.length - 1; index += 1) {
      const seg = segments[index];
      const dirKey = segments.slice(0, index + 1).join("/");
      if (CATCHALL_NAMES.has(seg.toLowerCase()) && !seenCatchallDirs.has(dirKey)) {
        seenCatchallDirs.add(dirKey);
        findings.push({
          id: `structure.catchall-naming:${dirKey}`,
          category: "structure",
          severity: "style",
          exemptable: true,
          rule: "禁止使用 utils/common/helpers/misc 等兜底目录名隐藏职责",
          path: dirKey,
          summary: `检测到兜底命名目录：${dirKey}/`,
          remediation: "按真实领域概念或能力拆分为具名模块目录，交由 $desktop-refactor-code 重构并更新引用。",
        });
      }
    }

    const base = path.posix.basename(relative);
    const stem = path.posix.basename(relative, ext);
    if (CATCHALL_NAMES.has(stem.toLowerCase())) {
      findings.push({
        id: `structure.catchall-naming:${relative}`,
        category: "structure",
        severity: "style",
        exemptable: true,
        rule: "禁止使用 utils/common/helpers/misc 等兜底文件名隐藏职责",
        path: relative,
        summary: `检测到兜底命名文件：${relative}`,
        remediation: "将文件重命名或按职责拆分为明确的领域/能力模块（参见 docs/ENGINEERING_RULES.md §2.2）。",
      });
    } else if (GENERIC_SUFFIX_RE.test(stem)) {
      findings.push({
        id: `style.generic-naming:${relative}`,
        category: "style",
        severity: "style",
        exemptable: true,
        rule: "避免不能表达清晰边界的 manager/processor/handler 泛化命名",
        path: relative,
        summary: `检测到泛化命名文件：${relative}（请核对是否对应明确领域角色）`,
        remediation: "若不对应真实领域角色，请通过 $desktop-refactor-code 重命名为表达实际职责的模块名。",
      });
    }

    if (FRONTEND_BARREL_NAMES.has(base)) {
      const content = fs.readFileSync(path.join(root, relative), "utf8");
      if (/^\s*export\s+\*\s+from\s+/mu.test(content)) {
        findings.push({
          id: `structure.frontend-barrel-export-star:${relative}`,
          category: "structure",
          severity: "style",
          exemptable: true,
          rule: "前端模块不强制桶文件且禁止使用 `export *` 掩盖真实导出源",
          path: relative,
          summary: `检测到使用 export * 的前端桶文件：${relative}`,
          remediation: "让调用方直接从具体组件/hook 文件导入，或改为逐一具名导出并移除 `export *`。",
        });
      }
    }
  }
}

/** 检测项目级 `.cargo/config.toml` 的 target-dir 重定向与仓库内遗留 `target/` 目录。 */
function detectCargoTargetHygiene(root, findings) {
  for (const rel of [".cargo/config.toml", ".cargo/config"]) {
    const full = path.join(root, rel);
    if (!lstatOrNull(full)?.isFile()) continue;
    const text = fs.readFileSync(full, "utf8");
    if (/^\s*target-dir\s*=/mu.test(text)) {
      findings.push({
        id: `constraint.cargo-target-redirect:${rel}`,
        category: "constraint",
        severity: "style",
        exemptable: true,
        rule: "禁止在项目级 .cargo/config.toml 中重定向 target-dir，应沿用设备全局 Cargo target 目录",
        path: rel,
        summary: `${rel} 包含项目级 target-dir 重定向`,
        remediation: "移除项目级 target-dir 配置，使 Cargo 自动沿用执行设备用户级全局 target 目录。",
      });
    }
  }
  const localTarget = path.join(root, "target");
  if (lstatOrNull(localTarget)?.isDirectory()) {
    findings.push({
      id: "structure.local-cargo-target-dir:target",
      category: "structure",
      severity: "style",
      exemptable: true,
      rule: "Rust 构建应沿用宿主全局 Cargo target 目录，避免在仓库内残留本地 target/",
      path: "target",
      summary: "仓库内存在本地 target/ 目录",
      remediation: "确认无活动进程占用后清理仓库内 target/，并确认本机全局 Cargo target 配置生效。",
    });
  }
}

/** 集成已传播的 Harness 确定性门禁（文件行数、core-first、Rust 中文注释、.gitignore）。 */
function runDelegatedCheckers(root, findings, checks) {
  const lineResult = inspectFileLineLimits(root);
  checks.fileLineLimits = {
    ok: lineResult.ok,
    checked: lineResult.checkedTextFiles,
    violationCount: lineResult.violations.length,
    reviewCount: lineResult.reviewCandidates.length,
  };
  for (const item of lineResult.violations) {
    findings.push({
      id: `constraint.file-line-hard-limit:${item.path}`,
      category: "constraint",
      severity: "hard",
      exemptable: false,
      rule: "单文件硬行数上限（Rust<=800、前端<=1000、其他文本<=2000）不可豁免",
      path: item.path,
      summary: `${item.path} 共 ${item.lines} 行，超过硬上限 ${item.limit} 行（${item.profile}）`,
      remediation: "按职责拆分超限文件（Rust 使用 `<module>/mod.rs`，前端按功能拆分高内聚文件）。",
    });
  }
  for (const item of lineResult.reviewCandidates) {
    findings.push({
      id: `style.file-line-review:${item.path}`,
      category: "style",
      severity: "style",
      exemptable: true,
      rule: "单文件进入建议重构/语义复核区间（Rust 401-800、前端 501-1000、其他文本 501-2000）",
      path: item.path,
      summary: `${item.path} 共 ${item.lines} 行，超过建议重构阈值 ${item.threshold} 行（${item.profile}）`,
      remediation: "检查是否仍高内聚、职责单一且各部分职责相近；否则按 $desktop-refactor-code 拆分。",
    });
  }

  const hasCargo = Boolean(lstatOrNull(path.join(root, "Cargo.toml"))?.isFile());
  if (hasCargo) {
    const rustCommentResult = inspectRustComments(root);
    checks.rustChineseComments = {
      ok: rustCommentResult.ok,
      checkedFiles: rustCommentResult.checkedRustFiles,
      violationCount: rustCommentResult.violations.length,
      errorCount: rustCommentResult.errors.length,
    };
    if (rustCommentResult.violations.length > 0) {
      const grouped = new Map();
      for (const item of rustCommentResult.violations) {
        if (!grouped.has(item.path)) grouped.set(item.path, []);
        grouped.get(item.path).push(item);
      }
      for (const [fileKey, items] of grouped) {
        const first = items[0];
        findings.push({
          id: `style.rust-chinese-comments:${fileKey}`,
          category: "style",
          severity: "style",
          exemptable: true,
          rule: "受管 Rust 声明必须具备紧邻的中文业务文档注释（///）",
          path: fileKey,
          summary: `${fileKey} 存在 ${items.length} 处中文文档注释缺口（首项：第 ${first.line} 行 ${first.kind} ${first.name}）`,
          remediation: "为缺失的 Rust 声明补齐解释业务语义与约束的中文文档注释，不得使用空洞套话。",
        });
      }
    }

    const coreFirstScript = path.join(root, ".agents", "skills", "desktop-implement-change", "scripts", "check_core_first.mjs");
    if (lstatOrNull(coreFirstScript)?.isFile()) {
      const cf = spawnSync(process.execPath, [coreFirstScript, "--root", root], { encoding: "utf8", timeout: 30_000 });
      checks.coreFirst = { ok: cf.status === 0, status: cf.status };
      if (cf.status !== 0) {
        const detail = (cf.stderr || cf.stdout || "core-first 检查未通过").trim().split(/\r?\n/u)[0];
        findings.push({
          id: "constraint.core-first:Cargo.toml",
          category: "constraint",
          severity: "hard",
          exemptable: false,
          rule: "Core-first 依赖方向硬规则（适配器依赖 core，core 不得反向依赖接口，适配器之间不得互相依赖）",
          path: "Cargo.toml",
          summary: detail,
          remediation: "按 $desktop-review-core-boundaries 与 $desktop-refactor-code 修正 workspace 依赖方向，将领域逻辑上移至 core。",
        });
      }
    }
  }

  try {
    const gitignoreReport = inspectGitignore(root);
    checks.gitignore = {
      ok: gitignoreReport.rulesToAdd.length === 0 && gitignoreReport.lockPolicyWarnings.length === 0,
      detectedCount: gitignoreReport.detectedGeneratedFiles.length,
      rulesToAdd: gitignoreReport.rulesToAdd.map((r) => r.pattern),
    };
    if (gitignoreReport.rulesToAdd.length > 0) {
      findings.push({
        id: "constraint.gitignore-dev-generated:.gitignore",
        category: "constraint",
        severity: "style",
        exemptable: true,
        rule: "开发过程中生成的未跟踪产物应自动纳入 .gitignore 忽略范围",
        path: ".gitignore",
        summary: `检测到 ${gitignoreReport.detectedGeneratedFiles.length} 个未忽略的开发生成物，建议追加规则：${gitignoreReport.rulesToAdd.map((r) => r.pattern).join(", ")}`,
        remediation: "运行 `node .agents/skills/desktop-implement-change/scripts/sync_gitignore.mjs sync --project-root .` 自动追加规则。",
      });
    }
    for (const warning of gitignoreReport.lockPolicyWarnings) {
      findings.push({
        id: "constraint.gitignore-lock-policy:.gitignore",
        category: "constraint",
        severity: "style",
        exemptable: true,
        rule: "`.gitignore` 必须与 Cargo `dependency-lock-policy` 一致",
        path: ".gitignore",
        summary: warning,
        remediation: "当项目采用 `dependency-lock-policy = \"tracked\"` 时，从 `.gitignore` 移除对应锁文件忽略规则。",
      });
    }
  } catch (error) {
    checks.gitignore = { ok: false, skipped: true, reason: error.message };
  }
}

/** 对目标项目执行完整的结构与最佳实践静态检测，返回分类清晰的发现清单。 */
export function inspectProjectStructure(targetRoot) {
  const supplied = path.resolve(targetRoot);
  const stat = lstatOrNull(supplied);
  if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`项目根目录必须是普通非符号链接目录：${supplied}`);
  }
  const root = fs.realpathSync(supplied);
  const files = listProjectFiles(root);
  const findings = [];
  const checks = {};

  detectUncentralizedWorkspaceDeps(root, files, findings);
  detectRustDualModuleLayouts(files, findings);
  detectNamingAndBarrelIssues(root, files, findings);
  detectCargoTargetHygiene(root, findings);
  runDelegatedCheckers(root, findings, checks);

  findings.sort((left, right) => left.id.localeCompare(right.id, "en"));
  const hardCount = findings.filter((item) => item.severity === "hard").length;
  const styleCount = findings.length - hardCount;
  const byCategory = {};
  for (const item of findings) byCategory[item.category] = (byCategory[item.category] ?? 0) + 1;

  return {
    status: findings.length === 0 ? "clean" : (hardCount > 0 ? "hard-issues-found" : "refactor-suggested"),
    projectRoot: root,
    summary: { total: findings.length, hard: hardCount, style: styleCount, byCategory },
    findings,
    checks,
  };
}
