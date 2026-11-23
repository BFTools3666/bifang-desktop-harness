import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { canonicalBytes } from "../../desktop-prepare-release/scripts/release_context.mjs";
import { resolveAcceptanceScope } from "./acceptance_scope.mjs";

const SCRIPT = fileURLToPath(new URL("./acceptance_scope.mjs", import.meta.url));
const RELEASE_DATE = "2026-11-23";

/** 构造带真实 Git 提交、标签及双语日志的独立临时仓库。 */
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "harness-acceptance-scope-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "project");
  mkdirSync(root);
  const git = (...args) => {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const write = (name, data) => writeFileSync(join(root, name), data);
  const commit = (message) => {
    git("add", ".");
    git("commit", "--quiet", "-m", message);
    return git("rev-parse", "HEAD");
  };
  git("init", "--quiet", "--initial-branch=main");
  git("config", "--local", "user.name", "Acceptance Scope Test");
  git("config", "--local", "user.email", "acceptance-scope@example.com");
  git("config", "--local", "commit.gpgsign", "false");
  git("config", "--local", "tag.gpgsign", "false");
  git("config", "--local", "core.hooksPath", join(directory, "empty-hooks"));
  write("unchanged.txt", "An old feature.\n");
  const initial = commit("Initial feature");
  const releases = [];
  const release = (version, channel, { legacy = false, contextSchema = 4, annotated = false, abandoned = false } = {}) => {
    const sourceHead = git("rev-parse", "HEAD");
    const tag = legacy ? `v${version}` : `v${version}-20261123`;
    releases.unshift({
      releaseDate: RELEASE_DATE,
      version: `v${version}`,
      featureOptimizations: [{ "zh-CN": "新增操作", "en-US": "Added operation" }],
      bugFixes: [],
    });
    write("release-notes.json", JSON.stringify({ schemaVersion: 2, releases }));
    if (!legacy) {
      mkdirSync(join(root, ".harness"), { recursive: true });
      write(".harness/release-context.json", canonicalBytes({
        schemaVersion: contextSchema,
        ...(contextSchema === 2 ? { gitPublication: "local" } : {}),
        sourceHead, version, releaseDate: RELEASE_DATE, expectedTag: tag,
        ...(contextSchema === 2 ? { remote: null } : {}),
        defaultBranch: "main",
        ...(contextSchema === 4 ? { releaseChannel: channel } : {}),
        releaseReview: {
          selection: "disabled", status: "Not run", scopeBase: sourceHead, sourceHead,
          scopeDiffSha256: "0".repeat(64), reviewedSourceCommit: null, checks: [], evidenceSummary: null,
          reason: "Optional review disabled.", remainingRisk: "Semantic issues may remain.",
        },
        ...(contextSchema === 2 ? { candidateSelections: { macosSigningSelection: "not-applicable" } } : {}),
      }));
    }
    const releaseCommit = commit(`Release ${version}`);
    if (abandoned) releases.shift();
    else git("tag", ...(annotated ? ["-a", "-m", "Verified release"] : []), tag);
    return { tag, commit: releaseCommit, version };
  };
  return { directory, root, git, write, commit, initial, release };
}

test("scopes delta to nearest proven same-channel release and excludes unchanged features", (t) => {
  const item = fixture(t);
  const previous = item.release("1.0.0", "release", { annotated: true, contextSchema: 3 });
  item.write("beta-feature.txt", "Beta content subsequently shipped.\n");
  item.commit("New feature in beta");
  item.release("1.1.0", "beta");
  const parent = item.git("rev-parse", "HEAD");
  item.git("switch", "--quiet", "-c", "experiment");
  item.write("experimental.txt", "Side branch feature included in the release.\n");
  item.commit("Experiment");
  item.git("tag", "v1.1.1");
  item.git("switch", "--quiet", "main");
  assert.equal(item.git("rev-parse", "HEAD"), parent);
  item.git("merge", "--no-ff", "--quiet", "--no-edit", "experiment");
  item.write("changed.txt", "New release behavior.\n");
  item.commit("Change release");
  const published = item.release("1.2.0", "release");
  const result = resolveAcceptanceScope(item.root);
  assert.equal(result.acceptanceScope.kind, "release-delta");
  assert.deepEqual(result.acceptanceScope.baseline, previous);
  assert.equal(result.acceptanceScope.sourceCommit, published.commit);
  assert.match(result.acceptanceScope.diffSha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(result.changedPaths, [
    ".harness/release-context.json", "beta-feature.txt", "changed.txt", "experimental.txt", "release-notes.json",
  ]);
  assert.deepEqual(result.releaseNotes.map(({ version }) => version), ["v1.2.0", "v1.1.0"]);
});

test("legacy release with committed matching notes is a Release baseline", (t) => {
  const item = fixture(t);
  const previous = item.release("1.0.0", "release", { legacy: true });
  item.release("1.0.1", "release");
  assert.deepEqual(resolveAcceptanceScope(item.root).acceptanceScope.baseline, previous);
});

/** 升级后的首轮验收依然可从 schema 2 的正式标签界定本轮变化。 */
test("schema_two_release_remains_a_release_baseline", (t) => {
  const item = fixture(t);
  const previous = item.release("1.0.0", "release", { contextSchema: 2 });
  item.release("1.0.1", "release");
  assert.deepEqual(resolveAcceptanceScope(item.root).acceptanceScope.baseline, previous);
});

/** 本机 Git 忽略子模块的偏好不能隐藏实际进入发布的 gitlink。 */
test("changed_gitlink_is_listed_despite_local_diff_settings", (t) => {
  const item = fixture(t);
  item.release("1.0.0", "release");
  item.git("config", "diff.ignoreSubmodules", "all");
  mkdirSync(join(item.root, "embedded"));
  item.git("update-index", "--add", "--cacheinfo", `160000,${item.initial},embedded`);
  item.git("commit", "--quiet", "-m", "Add embedded revision");
  item.release("1.0.1", "release");
  assert.ok(resolveAcceptanceScope(item.root).changedPaths.includes("embedded"));
});

test("first release of a channel compares the full initial product tree", (t) => {
  const item = fixture(t);
  item.release("1.0.0", "release");
  item.release("1.0.1", "beta");
  const { acceptanceScope, changedPaths } = resolveAcceptanceScope(item.root);
  assert.equal(acceptanceScope.releaseChannel, "beta");
  assert.equal(acceptanceScope.kind, "first-release");
  assert.equal(acceptanceScope.baseline, null);
  assert.ok(changedPaths.includes("unchanged.txt"));
});

test("missing earlier release tag refuses to treat history as a first release", (t) => {
  const item = fixture(t);
  const previous = item.release("1.0.0", "release");
  item.release("1.0.1", "release");
  item.git("tag", "-d", previous.tag);
  assert.throws(() => resolveAcceptanceScope(item.root), /missing verified release history for v1.0.0/u);
});

test("an untagged abandoned release context does not create release ancestry", (t) => {
  const item = fixture(t);
  item.release("1.0.0", "release", { abandoned: true });
  item.release("1.0.1", "release");
  assert.equal(resolveAcceptanceScope(item.root).acceptanceScope.kind, "first-release");
});

test("accepted candidate must bind the exact recomputed release range", (t) => {
  const item = fixture(t);
  item.release("1.0.0", "release");
  const published = item.release("1.0.1", "release");
  const { acceptanceScope, changedPaths } = resolveAcceptanceScope(item.root);
  assert.deepEqual(changedPaths, [".harness/release-context.json", "release-notes.json"]);
  const manifest = {
    version: published.version,
    sourceCommit: published.commit,
    releaseContextSha256: acceptanceScope.releaseContextSha256,
    releaseChannel: "release",
    expectedTag: published.tag,
    milestoneAcceptance: "accepted",
    acceptanceScope,
    functionalAcceptance: {
      status: "not-applicable",
      reason: "Release metadata only; package release note bytes verified.",
    },
  };
  const path = join(item.directory, "manifest.json");
  const invoke = (...args) => spawnSync(process.execPath, [
    SCRIPT, "verify", "--project-root", item.root, "--manifest", path, ...args,
  ], { encoding: "utf8" });
  writeFileSync(path, JSON.stringify(manifest));
  const verified = invoke();
  assert.equal(verified.status, 0, verified.stderr);
  assert.deepEqual(JSON.parse(verified.stdout).acceptanceScope, acceptanceScope);

  writeFileSync(path, JSON.stringify({ ...manifest, acceptanceScope: undefined }));
  assert.match(invoke().stderr, /acceptance scope does not match/u);
  writeFileSync(path, JSON.stringify({ ...manifest, acceptanceScope: { ...acceptanceScope, diffSha256: "0".repeat(64) } }));
  assert.match(invoke().stderr, /acceptance scope does not match/u);
  writeFileSync(path, JSON.stringify({ ...manifest, releaseChannel: "beta" }));
  assert.match(invoke().stderr, /acceptance scope does not match/u);
  for (const releaseChannel of [undefined, null]) {
    writeFileSync(path, JSON.stringify({ ...manifest, releaseChannel }));
    assert.match(invoke().stderr, /acceptance scope does not match/u);
  }
  writeFileSync(path, JSON.stringify({ ...manifest, releaseTag: "v0.0.0-20261123" }));
  assert.match(invoke().stderr, /acceptance scope does not match/u);
  for (const status of ["pending", "rejected"]) {
    writeFileSync(path, JSON.stringify({ ...manifest, milestoneAcceptance: status }));
    assert.equal(invoke().status, 0);
    assert.match(invoke("--require-accepted").stderr, /must be accepted/u);
  }
  writeFileSync(path, JSON.stringify({ ...manifest, milestoneAcceptance: undefined }));
  assert.match(invoke().stderr, /invalid acceptance status/u);
  writeFileSync(path, JSON.stringify({ ...manifest, functionalAcceptance: undefined }));
  assert.match(invoke().stderr, /missing valid functional acceptance evidence/u);
  writeFileSync(path, JSON.stringify({ ...manifest, functionalAcceptance: { status: "passed", scenarios: [] } }));
  assert.match(invoke().stderr, /missing valid functional acceptance evidence/u);
});

/** 省略渠道只兼容 schema 3 的 Release，显式空值仍阻断。 */
test("schema_three_candidate_can_omit_release_channel", (t) => {
  const item = fixture(t);
  item.release("1.0.0", "release", { contextSchema: 3 });
  const { acceptanceScope } = resolveAcceptanceScope(item.root);
  const path = join(item.directory, "manifest.json");
  const manifest = { ...acceptanceScope, acceptanceScope, milestoneAcceptance: "pending" };
  const invoke = () => spawnSync(process.execPath, [SCRIPT, "verify", "--project-root", item.root,
    "--manifest", path], { encoding: "utf8" });
  delete manifest.releaseChannel;
  writeFileSync(path, JSON.stringify(manifest));
  const verified = invoke();
  assert.equal(verified.status, 0, verified.stderr);
  writeFileSync(path, JSON.stringify({ ...manifest, releaseChannel: null }));
  assert.match(invoke().stderr, /acceptance scope does not match/u);
});
