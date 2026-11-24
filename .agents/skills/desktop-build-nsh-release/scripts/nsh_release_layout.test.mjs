/** 桌面候选平铺、证据定位、失败清理与历史批次回归。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkContext, runGit, scopeDiffDigest, writeContext } from '../../desktop-prepare-release/scripts/release_context.mjs';
import { resolveAcceptanceScope } from '../../desktop-verify-delivery/scripts/acceptance_scope.mjs';
import { runRegressionPlan } from '../../desktop-verify-delivery/scripts/regression_scope.mjs';
import {
  fileSha256, inventory, locateNshCandidate, publishNshDesktopRelease, recoverNshDesktopRelease, sourceSnapshot,
  usesFlatNshRelease, verifyNshCandidate,
} from './nsh_release_layout.mjs';

const uuid = '01234567-89ab-cdef-0123-456789abcdef';
const name = '示例 Beta';
const version = '1.2.3';
const licenses = ['LICENSE.zh-CN.md', 'LICENSE.en.md'];

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nsh-release-layout-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const release = path.join(root, 'release');
  fs.mkdirSync(release);
  return {root, release};
}

function writeArtifact(stage, relative, content) {
  const file = path.join(stage, relative);
  fs.writeFileSync(file, content);
  const sha256 = fileSha256(file);
  fs.writeFileSync(file + '.sha256', `${sha256}  ${path.basename(file)}\n`);
  return sha256;
}

function stageCandidate(release, target, {installer = true, legacy = false, buildRun = `nsh-${target}-${uuid}`} = {}) {
  const stage = fs.mkdtempSync(path.join(release, '.nsh-package-'));
  fs.mkdirSync(path.join(stage, 'package'));
  fs.writeFileSync(path.join(stage, 'package', 'expanded-runner'), 'expanded bytes');
  fs.writeFileSync(path.join(stage, 'nsh-tests.xml'), '<testsuites/>');
  fs.writeFileSync(path.join(stage, 'regression-plan.json'), '{}');
  fs.writeFileSync(path.join(stage, 'regression-results.json'), '{}');
  for (const file of licenses) fs.writeFileSync(path.join(stage, file), 'license');
  const releaseNotesPath = 'release-notes.json';
  fs.writeFileSync(path.join(stage, releaseNotesPath), '{}');
  const artifact = legacy ? (target === 'macos' ? 'application.tar.gz' : 'package/Example.zip')
    : target === 'macos' ? 'application.dmg' : installer ? 'package/Example-setup.exe' : 'package/Example.zip';
  const sha256 = writeArtifact(stage, artifact, 'primary bytes');
  if (legacy && target === 'windows' && installer) {
    fs.writeFileSync(path.join(stage, 'package/Example-setup.exe'), 'MZ installer bytes');
  }
  return {stage, manifest: {
    schemaVersion: 1, mode: 'candidate', interface: 'nsh', version, target, buildRun, artifact, sha256,
    arch: target === 'macos' ? 'arm64' : 'x64', bundleFormat: target === 'macos' ? 'dmg' : installer ? 'exe' : 'zip',
    checksum: artifact + '.sha256', releaseNotesPath, licenses,
    releaseNotesSha256: fileSha256(path.join(stage, releaseNotesPath)),
  }};
}

test('desktop_final_installers_use_release_root_in_local_and_candidate_modes', () => {
  for (const target of ['macos', 'windows', 'linux', 'android', 'ios', 'ios-simulator', 'web']) {
    assert.equal(usesFlatNshRelease('local', target), ['macos', 'windows'].includes(target));
    assert.equal(usesFlatNshRelease('candidate', target), ['macos', 'windows'].includes(target));
  }
});

test('desktop packages and adjacent digests are flat while same-run evidence stays independently verified', t => {
  const {root, release} = fixture(t);
  fs.writeFileSync(path.join(release, 'unrelated.txt'), 'untouched');
  const publicFiles = ['.nsh-evidence', 'unrelated.txt'];
  for (const [target, format] of [['macos', 'dmg'], ['windows', 'exe']]) {
    const {stage, manifest} = stageCandidate(release, target);
    const stem = `${name}_${version}_${target === 'macos' ? 'arm64_setup for macOS' : 'x64_setup for Windows'}`;
    const result = publishNshDesktopRelease(release, stage, manifest, name);
    assert.equal(result.output, release);
    assert.equal(result.manifest, path.join(release, '.nsh-evidence', manifest.buildRun, 'manifest.json'));
    assert.equal(result.artifact, stem + '.' + format);
    const names = [result.artifact];
    assert.deepEqual(result.deliveryFiles.map(file => file.path), names);
    assert.equal(fs.existsSync(path.join(release, manifest.buildRun)), false);
    assert.equal(fs.existsSync(stage), false);
    const candidate = locateNshCandidate(root, target, manifest.buildRun);
    assert.equal(candidate.artifact, path.join(release, result.artifact));
    assert.equal(candidate.manifestFile, result.manifest);
    assert.equal(fs.existsSync(path.join(candidate.evidenceDirectory, 'package')), false);
    for (const file of candidate.deliveryFiles) {
      publicFiles.push(file.path, file.checksum);
      assert.equal(fileSha256(path.join(release, file.path)), file.sha256);
      assert.equal(fs.readFileSync(path.join(release, file.checksum), 'utf8'), `${file.sha256}  ${file.path}\n`);
    }
  }
  assert.deepEqual(fs.readdirSync(release).sort(), publicFiles.sort());
  assert.equal(fs.readFileSync(path.join(release, 'unrelated.txt'), 'utf8'), 'untouched');
});

test('archives_cannot_replace_final_installers_and_long_names_are_not_silently_truncated', t => {
  const {release} = fixture(t);
  const {stage, manifest} = stageCandidate(release, 'windows', {installer: false});
  assert.throws(() => publishNshDesktopRelease(release, stage, manifest, name), /real DMG or EXE/u);
  const next = stageCandidate(release, 'macos');
  assert.throws(() => publishNshDesktopRelease(release, next.stage, next.manifest, '示'.repeat(80)), /filesystem limit/u);
});

/** 本地桌面安装器也直接落位 release，但不能被候选验收入口误认。 */
test('local_desktop_installer_is_flat_and_is_not_a_release_candidate', t => {
  const {root, release} = fixture(t);
  const {stage, manifest} = stageCandidate(release, 'macos');
  manifest.mode = 'local';
  const result = publishNshDesktopRelease(release, stage, manifest, name);
  assert.equal(result.artifact, '示例 Beta_1.2.3_arm64_setup for macOS.dmg');
  assert.ok(fs.existsSync(path.join(release, result.artifact)));
  assert.throws(() => locateNshCandidate(root, 'macos', manifest.buildRun), /identity or layout mismatch/u);
});

/** 不同批次不能靠随机后缀绕过稳定名称，也不能覆盖旧包。 */
test('same_installer_identity_from_another_build_preserves_previous_bytes', t => {
  const {release} = fixture(t);
  const first = stageCandidate(release, 'macos');
  const result = publishNshDesktopRelease(release, first.stage, first.manifest, name);
  const next = stageCandidate(release, 'macos', {buildRun: 'nsh-macos-11234567-89ab-cdef-0123-456789abcdef'});
  assert.throws(() => publishNshDesktopRelease(release, next.stage, next.manifest, name), /filename already exists/u);
  assert.equal(fileSha256(path.join(release, result.artifact)), result.sha256);
  assert.ok(fs.existsSync(result.manifest));
});

/** 平铺安装包同时保留官方更新器需要的原名、字节和批次清单记录。 */
test('flat_desktop_publication_preserves_official_updater_archives', t => {
  const {root, release} = fixture(t);
  for (const [target, archives] of [
    ['macos', ['macos-aarch64.tar.gz', 'macos-x86_64.tar.gz']],
    ['windows', ['windows-x86_64.zip']],
  ]) {
    const {stage, manifest} = stageCandidate(release, target);
    const expected = archives.map(archive => `---Beta-${version}-${archive}`);
    for (const filename of expected) fs.writeFileSync(path.join(stage, 'package', filename), filename);
    publishNshDesktopRelease(release, stage, manifest, name);
    const candidate = locateNshCandidate(root, target, manifest.buildRun);
    assert.ok(candidate.manifest.files.some(file => file.path.startsWith('updates/')));
    for (const filename of expected) {
      const file = path.join(candidate.evidenceDirectory, 'updates', filename);
      assert.equal(fs.readFileSync(file, 'utf8'), filename);
      assert.ok(candidate.manifest.files.some(entry => entry.path === `updates/${filename}` && entry.sha256 === fileSha256(file)));
    }
    assert.equal(fs.existsSync(path.join(candidate.evidenceDirectory, 'package')), false);
  }
});

test('same-run case collisions are detected before overwriting anything', t => {
  const {release} = fixture(t);
  const {stage, manifest} = stageCandidate(release, 'windows');
  const occupied = path.join(release, `OTHER_${manifest.buildRun.toUpperCase()}.ZIP`);
  fs.writeFileSync(occupied, 'existing bytes');
  assert.throws(() => publishNshDesktopRelease(release, stage, manifest, name), /already exists/u);
  assert.equal(fs.readFileSync(occupied, 'utf8'), 'existing bytes');
  assert.equal(fs.existsSync(path.join(release, '.nsh-evidence', manifest.buildRun)), false);
});

test('publication restores its own output links when a later destination fails', t => {
  const {root, release} = fixture(t);
  const {stage, manifest} = stageCandidate(release, 'windows');
  const realLink = fs.linkSync;
  let calls = 0;
  t.mock.method(fs, 'linkSync', (source, destination) => {
    if (++calls === 2) {
      fs.writeFileSync(destination, 'another writer');
      throw new Error('simulated destination conflict');
    }
    realLink(source, destination);
  });
  assert.throws(() => publishNshDesktopRelease(release, stage, manifest, name), /destination conflict/u);
  assert.throws(() => locateNshCandidate(root, 'windows', manifest.buildRun), /committed/u);
  const remainingFiles = fs.readdirSync(release, {withFileTypes: true}).filter(file => file.isFile());
  assert.equal(remainingFiles.length, 1);
  assert.equal(fs.readFileSync(path.join(release, remainingFiles[0].name), 'utf8'), 'another writer');
  assert.deepEqual(fs.readdirSync(path.join(release, '.nsh-evidence')), []);
});

/** 模拟首个公开文件落位后进程直接退出，恢复只回收相同 inode 的本批链接。 */
test('interrupted_publication_can_be_rolled_back_by_exact_build_run', t => {
  const {root, release} = fixture(t);
  const {stage, manifest} = stageCandidate(release, 'windows');
  const module = new URL('./nsh_release_layout.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { publishNshDesktopRelease } from ${JSON.stringify(module)};
    const [release, stage, manifest, name] = process.argv.slice(1);
    const link = fs.linkSync;
    fs.linkSync = (source, destination) => {
      link(source, destination);
      process.exit(91);
    };
    publishNshDesktopRelease(release, stage, JSON.parse(manifest), name);
  `, release, stage, JSON.stringify(manifest), name], {encoding: 'utf8'});
  assert.equal(child.status, 91, child.stderr);
  assert.throws(() => locateNshCandidate(root, 'windows', manifest.buildRun), /committed/u);
  const unrelated = `another_${manifest.buildRun}.zip`;
  fs.writeFileSync(path.join(release, unrelated), 'unrelated bytes');
  assert.equal(recoverNshDesktopRelease(root, 'windows', manifest.buildRun).status, 'rolled-back');
  assert.deepEqual(fs.readdirSync(release).sort(), ['.nsh-evidence', unrelated]);
  assert.deepEqual(fs.readdirSync(path.join(release, '.nsh-evidence')), []);
  assert.equal(fs.readFileSync(path.join(release, unrelated), 'utf8'), 'unrelated bytes');
});

/** 写入名称日志后尚未移动制品就退出时，恢复不得误删其他进程的同名文件。 */
test('interruption_before_public_staging_preserves_unrelated_same_name_file', t => {
  const {root, release} = fixture(t);
  const {stage, manifest} = stageCandidate(release, 'windows');
  const module = new URL('./nsh_release_layout.mjs', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import { publishNshDesktopRelease } from ${JSON.stringify(module)};
    const [release, stage, manifest, name] = process.argv.slice(1);
    const write = fs.writeFileSync;
    fs.writeFileSync = (file, bytes, options) => {
      write(file, bytes, options);
      if (String(file).endsWith('owner.json') && JSON.parse(bytes).files) process.exit(92);
    };
    publishNshDesktopRelease(release, stage, JSON.parse(manifest), name);
  `, release, stage, JSON.stringify(manifest), name], {encoding: 'utf8'});
  assert.equal(child.status, 92, child.stderr);
  const unrelated = path.join(release, '示例 Beta_1.2.3_x64_setup for Windows.exe');
  fs.writeFileSync(unrelated, 'unrelated bytes');
  assert.equal(recoverNshDesktopRelease(root, 'windows', manifest.buildRun).status, 'rolled-back');
  assert.equal(fs.readFileSync(unrelated, 'utf8'), 'unrelated bytes');
  assert.deepEqual(fs.readdirSync(path.join(release, '.nsh-evidence')), []);
});

test('selected desktop candidate rejects extra files and changed public or evidence bytes', t => {
  const {root, release} = fixture(t);
  const {stage, manifest} = stageCandidate(release, 'macos');
  const result = publishNshDesktopRelease(release, stage, manifest, name);
  const locate = () => locateNshCandidate(root, 'macos', manifest.buildRun);
  assert.throws(() => locateNshCandidate(root, 'windows', manifest.buildRun), /target and buildRun/u);
  const extra = path.join(release, result.artifact + '.extra');
  fs.writeFileSync(extra, 'extra output');
  assert.throws(locate, /release file set changed/u);
  fs.unlinkSync(extra);
  const receipt = path.join(release, result.checksum);
  const receiptBytes = fs.readFileSync(receipt);
  fs.writeFileSync(receipt, 'changed checksum');
  assert.throws(locate, /adjacent checksum changed/u);
  fs.writeFileSync(receipt, receiptBytes);
  fs.writeFileSync(path.join(path.dirname(result.manifest), 'nsh-tests.xml'), 'different evidence');
  assert.throws(locate, /candidate evidence file set or bytes changed/u);
});

test('an existing desktop batch remains selectable by its exact legacy directory', t => {
  const {root, release} = fixture(t);
  const {stage, manifest} = stageCandidate(release, 'windows', {legacy: true});
  manifest.files = inventory(stage);
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest));
  const legacy = path.join(release, manifest.buildRun);
  fs.renameSync(stage, legacy);
  const result = locateNshCandidate(root, 'windows', manifest.buildRun);
  assert.equal(result.artifact, path.join(legacy, 'package/Example.zip'));
  assert.equal(result.manifestFile, path.join(legacy, 'manifest.json'));
  fs.mkdirSync(path.join(release, '.nsh-evidence', manifest.buildRun), {recursive: true});
  assert.throws(() => locateNshCandidate(root, 'windows', manifest.buildRun), /exactly one committed/u);
});

test('publication and lookup reject symlinked evidence roots, unsafe names and ambiguous batch input', t => {
  const {root, release} = fixture(t);
  const {stage, manifest} = stageCandidate(release, 'macos');
  assert.throws(() => publishNshDesktopRelease(release, stage, manifest, 'C:\\outside'), /staging layout/u);
  assert.throws(() => locateNshCandidate(root, 'macos', '../outside'), /target and buildRun/u);
  const outside = path.join(root, 'user-evidence');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(release, '.nsh-evidence'), 'junction');
  assert.throws(() => publishNshDesktopRelease(release, stage, manifest, name), /ordinary release directory/u);
  assert.throws(() => locateNshCandidate(root, 'macos', manifest.buildRun), /ordinary release directory/u);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('the locator CLI binds a committed NSH package to a real published Git context', t => {
  const {root, release} = fixture(t);
  const git = (...args) => runGit(root, args).stdout.trim();
  git('init', '--quiet', '--initial-branch=main');
  git('config', '--local', 'user.name', 'NSH Release Layout Test');
  git('config', '--local', 'user.email', 'nsh-release-layout@example.test');
  git('config', '--local', 'core.hooksPath', '.git/fixture-hooks');
  git('config', '--local', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(root, '.gitignore'), '/release/\n/knowledge/\n');
  const notes = JSON.stringify({schemaVersion: 2, releases: [{version: 'v' + version, releaseDate: '2026-11-23',
    featureOptimizations: [{'zh-CN': '测试发布', 'en-US': 'Fixture release'}], bugFixes: []}]});
  fs.writeFileSync(path.join(root, 'release-notes.json'), notes);
  git('add', '.gitignore', 'release-notes.json');
  git('commit', '--quiet', '-m', 'fixture source');
  const sourceHead = git('rev-parse', 'HEAD');
  const {expectedTag} = writeContext({
    projectRoot: root,
    sourceHead,
    version,
    releaseDate: '2026-11-23',
    defaultBranch: 'main',
    channel: 'release',
    reviewSelection: 'disabled',
    scopeBase: sourceHead,
    scopeDiffSha256: scopeDiffDigest(root, sourceHead, sourceHead),
    reviewReason: 'Review disabled for this fixture.',
    reviewRemainingRisk: 'Synthetic package bytes cover layout behavior.',
  });
  git('add', '.harness/release-context.json');
  git('commit', '--quiet', '-m', 'fixture release context');
  git('tag', expectedTag);
  const context = checkContext({projectRoot: root}, {published: true});

  const {stage, manifest} = stageCandidate(release, 'macos');
  fs.writeFileSync(path.join(stage, 'release-notes.json'), notes);
  const resolved = resolveAcceptanceScope(root);
  const plan = {schemaVersion: 1, scope: resolved.acceptanceScope, initialScopeAuthorization: 'Approved fixture scope.',
    tests: [], excludedChanges: resolved.changedPaths.map(file => ({changes: [file], reason: 'Only release metadata.'})),
    noTestsReason: 'This fixture only exercises published metadata and installer layout.'};
  for (const file of ['regression-plan.json', 'regression-results.json']) fs.unlinkSync(path.join(stage, file));
  const unitTests = runRegressionPlan(root, plan, {directory: stage});
  Object.assign(manifest, {
    host: process.platform,
    sourceSnapshot: sourceSnapshot(root),
    sourceCommit: context.sourceCommit,
    expectedTag: context.expectedTag,
    releaseContextSha256: context.releaseContextSha256,
    releaseChannel: context.releaseChannel,
    releaseReview: context.releaseReview,
    reviewSelection: context.releaseReview.selection,
    reviewStatus: context.releaseReview.status,
    releaseNotesVersion: 'v' + version,
    releaseNotesSha256: fileSha256(path.join(stage, 'release-notes.json')),
    unitTests,
  });
  const result = publishNshDesktopRelease(release, stage, manifest, name);
  const script = fileURLToPath(new URL('./nsh_release_layout.mjs', import.meta.url));
  const verify = () => spawnSync(process.execPath, [script, '--root', root,
    '--target', 'macos', '--build-run', manifest.buildRun], {encoding: 'utf8'});
  const verified = verify();
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).manifestSha256, fileSha256(result.manifest));
  assert.equal(JSON.parse(verified.stdout).artifact, path.join(release, result.artifact));
  fs.mkdirSync(path.join(root, 'knowledge'));
  fs.writeFileSync(path.join(root, 'knowledge', 'overview.md'), 'Locally generated report');
  const withIgnoredReport = verify();
  assert.equal(withIgnoredReport.status, 0, withIgnoredReport.stderr);
  fs.appendFileSync(path.join(root, '.gitignore'), '# tracked drift\n');
  assert.throws(() => verifyNshCandidate(root, 'macos', manifest.buildRun), /worktree must be clean/u);
  git('restore', '.gitignore');
  git('tag', '--force', expectedTag, sourceHead);
  assert.throws(() => verifyNshCandidate(root, 'macos', manifest.buildRun), /tag does not point to HEAD/u);
});
