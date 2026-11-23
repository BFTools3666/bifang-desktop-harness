#!/usr/bin/env node
/** 解析同渠道的正式发布差异并复核候选验收范围绑定。 */

import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import {
  CONTEXT_RELATIVE_PATH, canonicalBytes, checkContext, resolveRoot, runGit, scopeDiffDigest,
  validateContext,
} from "../../desktop-prepare-release/scripts/release_context.mjs";
import { parseDocumentBytes } from "../../desktop-prepare-release/scripts/release_notes.mjs";

const NOTES_PATH = "release-notes.json";
const RELEASE_TAG = /^v(\d+\.\d+\.\d+|\d{12})(?:-(\d{8}))?$/u;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** 只接受提交内普通 blob，区分缺失与不可用历史。 */
function readBlob(root, commit, path) {
  const entry = runGit(root, ["ls-tree", commit, "--", path]).stdout.trimEnd();
  if (entry === "") return null;
  const match = /^100(?:644|755) blob ([0-9a-f]{40})\t(.+)$/u.exec(entry);
  if (!match || match[2] !== path) throw new Error(`invalid tracked release file at ${commit}: ${path}`);
  return runGit(root, ["cat-file", "blob", match[1]], { text: false }).stdout;
}

/** 读取历史发布上下文，要求提交内字节与原有 schema 相符。 */
function historicalContext(root, commit) {
  const bytes = readBlob(root, commit, CONTEXT_RELATIVE_PATH);
  if (bytes === null) return null;
  const value = JSON.parse(UTF8.decode(bytes));
  if (value?.schemaVersion === 2) {
    // 旧 Git 发布模式及候选选择属于历史记录，验收基线只消费可用的发布身份与审查来源。
    const { schemaVersion, gitPublication, remote, candidateSelections, ...identity } = value;
    const validMode = (gitPublication === "local" && remote === null) ||
      (gitPublication === "remote" && typeof remote === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(remote));
    if (!validMode || !candidateSelections || typeof candidateSelections !== "object" || Array.isArray(candidateSelections) ||
        !bytes.equals(canonicalBytes(value))) throw new Error(`invalid legacy release context at ${commit}`);
    return validateContext({ ...identity, schemaVersion: 3 });
  }
  const context = validateContext(value);
  if (!bytes.equals(canonicalBytes(context))) throw new Error(`noncanonical release context at ${commit}`);
  return context;
}

/** 按实际版本数值比较，时间版本与产品版本分别处理。 */
function compareOlder(version, currentVersion) {
  const previous = version.split(".");
  const current = currentVersion.split(".");
  if (previous.length !== current.length) return false;
  for (let index = 0; index < previous.length; index += 1) {
    if (BigInt(previous[index]) !== BigInt(current[index])) {
      return BigInt(previous[index]) < BigInt(current[index]);
    }
  }
  return false;
}

/** 只枚举候选第一父链上的真实提交标签，排除侧枝和当前版本。 */
function earlierTags(root, current) {
  const parents = runGit(root, ["rev-list", "--first-parent", current.sourceCommit]).stdout.trim().split("\n");
  const positions = new Map(parents.slice(1).map((commit, index) => [commit, index]));
  const refs = runGit(root, [
    "for-each-ref", "--format=%(refname:strip=2)%09%(objecttype)%09%(objectname)%09%(*objecttype)%09%(*objectname)",
    "refs/tags/",
  ]).stdout.trimEnd();
  return refs.split("\n").flatMap((line) => {
    const [tag, kind, object, peeledKind, peeledObject] = line.trimEnd().split("\t");
    const parsed = RELEASE_TAG.exec(tag);
    if (!parsed || !compareOlder(parsed[1], current.version)) return [];
    let commit = kind === "commit" ? object : peeledObject;
    if (peeledKind === "tag") {
      const result = runGit(root, ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`], { check: false });
      commit = result.returncode === 0 ? result.stdout.trim() : null;
    }
    if (!positions.has(commit)) return [];
    return [{ commit, tag, version: parsed[1], date: parsed[2], position: positions.get(commit) }];
  }).sort((left, right) => left.position - right.position);
}

/** 确认标签身份，旧无渠道标签仅凭该提交自己的头条版本承认 Release。 */
function releaseAtTag(root, tagged) {
  const { commit, tag, version, date } = tagged;
  const context = historicalContext(root, commit);
  if (context && context.expectedTag !== tag) return null;
  const notes = readBlob(root, commit, NOTES_PATH);
  if (notes === null) return null;
  const { releases } = parseDocumentBytes(notes);
  const [entry] = releases;
  const entryDate = entry.releaseDate.replaceAll("-", "");
  if (entry.version !== `v${version}` || (date && date !== entryDate)) return null;
  if (context) {
    const source = runGit(root, ["merge-base", "--is-ancestor", context.sourceHead, commit], { check: false });
    if (source.returncode !== 0) throw new Error(`release context source is not reachable from ${tag}`);
  }
  return { commit, tag, version, channel: context?.releaseChannel ?? "release", priorEntries: releases.slice(1) };
}

/** 从当前已发布 HEAD 解析范围，不依赖语义审查开关或工作树推测。 */
export function resolveAcceptanceScope(projectRoot) {
  const root = resolveRoot(projectRoot);
  if (runGit(root, ["rev-parse", "--is-shallow-repository"]).stdout.trim() !== "false") {
    throw new Error("acceptance scope requires non-shallow release history");
  }
  const current = checkContext({ projectRoot: root }, { published: true });
  const bytes = readBlob(root, current.sourceCommit, NOTES_PATH);
  if (!bytes) throw new Error("current release must track release-notes.json");
  const { releases } = parseDocumentBytes(bytes);
  if (releases[0].version !== `v${current.version}` || releases[0].releaseDate !== current.releaseDate) {
    throw new Error("current release notes do not match the verified release context");
  }
  const verifiedVersions = new Set();
  const reportedVersions = new Set(releases.slice(1).map(({ version }) => version));
  let previous = null;
  for (const tagged of earlierTags(root, current)) {
    const release = releaseAtTag(root, tagged);
    if (!release) continue;
    verifiedVersions.add(`v${release.version}`);
    for (const entry of release.priorEntries) reportedVersions.add(entry.version);
    if (release.channel === current.releaseChannel) {
      previous = release;
      break;
    }
  }
  const missingVersion = [...reportedVersions].find((version) =>
    (!previous || compareOlder(previous.version, version.slice(1))) && !verifiedVersions.has(version));
  if (missingVersion) throw new Error(`missing verified release history for ${missingVersion}`);

  const baseline = previous ? { tag: previous.tag, commit: previous.commit, version: previous.version } : null;
  const base = baseline?.commit ?? runGit(root, ["hash-object", "-t", "tree", "--stdin"]).stdout.trim();
  const changedPaths = UTF8.decode(runGit(root, [
    "diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-relative",
    "--ignore-submodules=none",
    base, current.sourceCommit, "--",
  ], { text: false }).stdout).split("\0").filter(Boolean);
  const acceptanceScope = {
    kind: baseline ? "release-delta" : "first-release",
    version: current.version,
    releaseTag: current.expectedTag,
    releaseChannel: current.releaseChannel,
    sourceCommit: current.sourceCommit,
    releaseContextSha256: current.releaseContextSha256,
    baseline,
    diffSha256: scopeDiffDigest(root, base, current.sourceCommit),
  };
  const releaseNotes = releases.filter(({ version }) => !baseline || compareOlder(baseline.version, version.slice(1)));
  return { acceptanceScope, changedPaths, releaseNotes, releaseContextSchemaVersion: current.schemaVersion };
}

/** 复核已写入候选 manifest 的范围和顶层发布身份。 */
export function verifyAcceptanceBinding(scope, manifest, { releaseContextSchemaVersion, requireAccepted = false }) {
  const channel = !Object.hasOwn(manifest, "releaseChannel") && releaseContextSchemaVersion === 3
    ? "release" : manifest.releaseChannel;
  // 本地 CLI/Tauri 依赖上下文摘要绑定，NSH 和矩阵清单另记录各自的顶层标签字段。
  const tags = ["expectedTag", "releaseTag"].filter((key) => Object.hasOwn(manifest, key));
  if (manifest.version !== scope.version ||
      manifest.sourceCommit !== scope.sourceCommit ||
      manifest.releaseContextSha256 !== scope.releaseContextSha256 ||
      channel !== scope.releaseChannel || tags.some((key) => manifest[key] !== scope.releaseTag) ||
      !isDeepStrictEqual(manifest.acceptanceScope, scope)) {
    throw new Error("candidate manifest acceptance scope does not match the verified release range");
  }
  if (!["pending", "rejected", "accepted"].includes(manifest.milestoneAcceptance)) {
    throw new Error("candidate manifest has an invalid acceptance status");
  }
  if (requireAccepted && manifest.milestoneAcceptance !== "accepted") {
    throw new Error("candidate must be accepted for readiness verification");
  }
  if (manifest.milestoneAcceptance === "accepted") verifyFunctionalAcceptance(manifest);
}

/** 接受结论须保留真实场景、无变化的依据或既有关闭运行选择的风险。 */
function verifyFunctionalAcceptance(manifest) {
  const coverage = manifest.functionalAcceptance;
  const hasText = (value) => typeof value === "string" && value.trim().length > 0;
  if (coverage?.status === "passed" && Array.isArray(coverage.scenarios) &&
      coverage.scenarios.length > 0 && coverage.scenarios.every((scenario) =>
        scenario && [scenario.change, scenario.scenario, scenario.observation].every(hasText))) return;
  if (coverage?.status === "not-applicable" && hasText(coverage.reason)) return;
  if (coverage?.status === "Not run" && manifest.e2eSelection === "disabled" &&
      hasText(coverage.reason) && hasText(coverage.remainingRisk)) return;
  throw new Error("accepted candidate is missing valid functional acceptance evidence");
}

/** 解析命令行并以只读方式输出或复核验收范围。 */
export function main(argv) {
  const [command, ...args] = argv;
  const { values } = parseArgs({
    args, options: { "project-root": { type: "string" }, manifest: { type: "string" }, "require-accepted": { type: "boolean" } },
  });
  if (!values["project-root"] || !["resolve", "verify"].includes(command) ||
      (command === "verify") !== Boolean(values.manifest) || (values["require-accepted"] && command !== "verify")) {
    throw new Error("usage: acceptance_scope.mjs resolve --project-root <root> | verify --project-root <root> --manifest <candidate-manifest> [--require-accepted]");
  }
  const result = resolveAcceptanceScope(values["project-root"]);
  if (command === "verify") {
    const path = resolve(values.manifest);
    const file = lstatSync(path);
    if (!file.isFile() || file.isSymbolicLink()) throw new Error("candidate manifest must be a regular file");
    const manifest = JSON.parse(UTF8.decode(readFileSync(path)));
    verifyAcceptanceBinding(result.acceptanceScope, manifest, {
      releaseContextSchemaVersion: result.releaseContextSchemaVersion,
      requireAccepted: values["require-accepted"],
    });
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}
