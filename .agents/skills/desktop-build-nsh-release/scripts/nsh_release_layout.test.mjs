/** 桌面候选平铺、证据定位、失败清理与历史批次回归。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkContext, runGit, scopeDiffDigest, writeContext } from '../../desktop-prepare-release/scripts/release_context.mjs';
import {
  fileSha256, inventory, locateNshCandidate, publishNshDesktopRelease, sourceSnapshot,
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

function stageCandidate(release, target, {installer = true, buildRun = `nsh-${target}-${uuid}`} = {}) {
  const stage = fs.mkdtempSync(path.join(release, '.nsh-package-'));
  fs.mkdirSync(path.join(stage, 'package'));
  fs.writeFileSync(path.join(stage, 'package', 'expanded-runner'), 'expanded bytes');
  fs.writeFileSync(path.join(stage, 'nsh-tests.xml'), '<testsuites/>');
  for (const file of licenses) fs.writeFileSync(path.join(stage, file), 'license');
  const releaseNotesPath = 'release-notes.json';
  fs.writeFileSync(path.join(stage, releaseNotesPath), '{}');
  const artifact = target === 'macos' ? 'application.tar.gz' : 'package/Example.zip';
  const sha256 = writeArtifact(stage, artifact, 'primary bytes');
  if (target === 'windows' && installer) {
    fs.writeFileSync(path.join(stage, 'package/Example-setup.exe'), 'MZ installer bytes');
  }
  return {stage, manifest: {
    schemaVersion: 1, mode: 'candidate', interface: 'nsh', version, target, buildRun, artifact, sha256,
    checksum: artifact + '.sha256', releaseNotesPath, licenses,
    releaseNotesSha256: fileSha256(path.join(stage, releaseNotesPath)),
  }};
}

test('NSH flat output is limited to formal macOS and Windows candidates', () => {
  for (const target of ['macos', 'windows', 'linux', 'android', 'ios', 'ios-simulator', 'web']) {
    assert.equal(usesFlatNshRelease('local', target), false);
    assert.equal(usesFlatNshRelease('candidate', target), ['macos', 'windows'].includes(target));
  }
});

test('desktop packages and adjacent digests are flat while same-run evidence stays independently verified', t => {
  const {root, release} = fixture(t);
  fs.writeFileSync(path.join(release, 'unrelated.txt'), 'untouched');
  const publicFiles = ['.nsh-evidence', 'unrelated.txt'];
  for (const [target, format] of [['macos', 'tar.gz'], ['windows', 'zip']]) {
    const {stage, manifest} = stageCandidate(release, target);
    const stem = `${name}_${version}_${manifest.buildRun}`;
    const result = publishNshDesktopRelease(release, stage, manifest, name);
    assert.equal(result.output, release);
    assert.equal(result.manifest, path.join(release, '.nsh-evidence', manifest.buildRun, 'manifest.json'));
    assert.equal(result.artifact, stem + '.' + format);
    const names = [result.artifact, ...(target === 'windows' ? [stem + '-setup.exe'] : [])];
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

test('Windows without an official installer publishes just the actual ZIP', t => {
  const {root, release} = fixture(t);
  const {stage, manifest} = stageCandidate(release, 'windows', {installer: false});
  publishNshDesktopRelease(release, stage, manifest, '示'.repeat(80));
  const candidate = locateNshCandidate(root, 'windows', manifest.buildRun);
  assert.equal(candidate.deliveryFiles.length, 1);
  assert.ok(Buffer.byteLength(path.basename(candidate.artifact)) < 255);
  assert.equal(path.extname(candidate.artifact), '.zip');
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
  const {stage, manifest} = stageCandidate(release, 'windows');
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
  fs.writeFileSync(path.join(root, '.gitignore'), '/release/\n');
  fs.writeFileSync(path.join(root, 'release-notes.json'), '{}');
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
  });
  const result = publishNshDesktopRelease(release, stage, manifest, name);
  const script = fileURLToPath(new URL('./nsh_release_layout.mjs', import.meta.url));
  const verify = () => spawnSync(process.execPath, [script, '--root', root,
    '--target', 'macos', '--build-run', manifest.buildRun], {encoding: 'utf8'});
  const verified = verify();
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).manifestSha256, fileSha256(result.manifest));
  assert.equal(JSON.parse(verified.stdout).artifact, path.join(release, result.artifact));
  git('tag', '--force', expectedTag, sourceHead);
  assert.throws(() => verifyNshCandidate(root, 'macos', manifest.buildRun), /tag does not point to HEAD/u);
});
