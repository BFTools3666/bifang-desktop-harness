#!/usr/bin/env node
/** 提交、定位及复核 NSH 候选的最终制品与同批证据。 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { checkContext } from '../../desktop-prepare-release/scripts/release_context.mjs';
import { NSH_BUILD_CACHE_NAMES } from './nsh_portable_entry.mjs';

const desktopFormats = new Map([['macos', 'tar.gz'], ['windows', 'zip']]);
const targets = ['macos', 'windows', 'linux', 'android', 'ios', 'ios-simulator', 'web'];
const evidenceFolder = '.nsh-evidence';
const manifestName = 'manifest.json';
const releaseNotesName = 'release-notes.json';
const licenses = ['LICENSE.zh-CN.md', 'LICENSE.en.md'];

export function usesFlatNshRelease(mode, target) {
  return mode === 'candidate' && desktopFormats.has(target);
}

/** 流式计算制品摘要，常驻缓冲区与制品大小无关。 */
export function fileSha256(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const hash = createHash('sha256');
    const bytes = Buffer.allocUnsafe(1024 * 1024);
    let count;
    while ((count = fs.readSync(fd, bytes)) > 0) hash.update(bytes.subarray(0, count));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

/** 官方 bundle 可包含不越出当前范围的相对链接。 */
export function inventory(directory) {
  const files = [];
  const root = fs.realpathSync(directory);
  const walk = (current, relative = '') => {
    for (const name of fs.readdirSync(current).sort()) {
      const file = path.join(current, name);
      const key = path.posix.join(relative, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) {
        const link = fs.readlinkSync(file);
        if (path.isAbsolute(link) || !fs.realpathSync(file).startsWith(root + path.sep)) {
          throw new Error('artifact link escapes package');
        }
        files.push({path: key, link});
      } else if (stat.isDirectory()) {
        walk(file, key);
      } else if (stat.isFile()) {
        files.push({path: key, size: stat.size, sha256: fileSha256(file)});
      } else {
        throw new Error('unsupported artifact type');
      }
    }
  };
  walk(directory);
  return files;
}

/** 源和资源按字节绑定，缓存与输出不进入快照。 */
export function sourceSnapshot(root) {
  const hash = createHash('sha256');
  const walk = directory => {
    for (const name of fs.readdirSync(directory).sort()) {
      if (NSH_BUILD_CACHE_NAMES.has(name) || ['Cargo.lock', 'pnpm-lock.yaml', 'pnpm-package.lock'].includes(name)) continue;
      const file = path.join(directory, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('source symlink is unsupported');
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) hash.update(JSON.stringify([path.relative(root, file), stat.mode & 0o777, fileSha256(file)]));
      else throw new Error('unsupported NSH source type');
    }
  };
  walk(root);
  return hash.digest('hex');
}

function assertBuildRun(target, buildRun) {
  if (!targets.includes(target) || typeof buildRun !== 'string' ||
      !new RegExp(`^nsh-${target}-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$`, 'u').test(buildRun)) {
    throw new Error('expected complete NSH target and buildRun');
  }
}

function normalizeName(name) {
  return name.normalize('NFC').toLowerCase();
}

function safeRelativePath(value) {
  return typeof value === 'string' && value.split('/').every(part =>
    part && part !== '.' && part !== '..' && !/[<>:"\\|?*\u0000-\u001f]|[ .]$/u.test(part));
}

function safeLeafName(value) {
  return safeRelativePath(value) && !value.includes('/');
}

/** 保留应用与版本的可识别前缀，为批次 ID 及后缀预留文件系统长度。 */
function clipFilenamePrefix(value, bytes) {
  let prefix = '';
  for (const character of value.normalize('NFC')) {
    if (Buffer.byteLength(prefix + character) > bytes) break;
    prefix += character;
  }
  return prefix;
}

function requireDirectory(directory) {
  if (!fs.lstatSync(directory, {throwIfNoEntry: false})?.isDirectory()) {
    throw new Error(`expected an ordinary release directory: ${directory}`);
  }
}

function requireFile(directory, relative) {
  if (!safeRelativePath(relative)) throw new Error('invalid release file path');
  const parts = relative.split('/');
  for (const part of parts.slice(0, -1)) {
    directory = path.join(directory, part);
    requireDirectory(directory);
  }
  const file = path.join(directory, parts.at(-1));
  if (!fs.lstatSync(file, {throwIfNoEntry: false})?.isFile()) {
    throw new Error(`expected an ordinary release file: ${relative}`);
  }
  return file;
}

/** 同一 buildRun 的发布文件构成独立集合，其他 release 内容不进入本次验证。 */
function publicNames(directory, buildRun) {
  const runMarker = '_' + buildRun;
  return fs.readdirSync(directory).filter(name => {
    const value = normalizeName(name);
    const index = value.lastIndexOf(runMarker);
    return index !== -1 && /^[.-]/u.test(value.slice(index + runMarker.length));
  }).sort();
}

function validateDigest(directory, file) {
  if (file.checksum !== file.path + '.sha256' || !/^[0-9a-f]{64}$/u.test(file.sha256)) {
    throw new Error('invalid NSH artifact checksum metadata');
  }
  const artifact = requireFile(directory, file.path);
  const receipt = requireFile(directory, file.checksum);
  if (fileSha256(artifact) !== file.sha256 ||
      fs.readFileSync(receipt, 'utf8') !== `${file.sha256}  ${path.posix.basename(file.path)}\n`) {
    throw new Error(`NSH artifact bytes or adjacent checksum changed: ${file.path}`);
  }
}

function validatePublicFiles(directory, manifest) {
  const format = desktopFormats.get(manifest.target);
  if (!format || !safeLeafName(manifest.artifact) ||
      !manifest.artifact.endsWith(`_${manifest.buildRun}.${format}`)) {
    throw new Error('invalid flat NSH candidate filename');
  }
  const primary = {path: manifest.artifact, sha256: manifest.sha256, checksum: manifest.checksum};
  const setup = manifest.artifact.slice(0, -(format.length + 1)) + '-setup.exe';
  const files = manifest.deliveryFiles;
  if (!Array.isArray(files) || !isDeepStrictEqual(files[0], primary) ||
      files.length > (manifest.target === 'windows' ? 2 : 1) ||
      (files.length === 2 && files[1]?.path !== setup)) {
    throw new Error('invalid flat NSH delivery file inventory');
  }
  const normalize = names => names.map(name => name.normalize('NFC')).sort();
  const expected = files.flatMap(file => [file.path, file.checksum]);
  if (!isDeepStrictEqual(normalize(publicNames(directory, manifest.buildRun)), normalize(expected))) {
    throw new Error('flat NSH release file set changed');
  }
  for (const file of files) validateDigest(directory, file);
}

function validateEvidence(directory, manifest) {
  const actual = inventory(directory).filter(file => file.path !== manifestName);
  if (!isDeepStrictEqual(actual, manifest.files)) throw new Error('NSH candidate evidence file set or bytes changed');
  if (manifest.releaseNotesPath !== releaseNotesName || !isDeepStrictEqual(manifest.licenses, licenses) ||
      fileSha256(requireFile(directory, releaseNotesName)) !== manifest.releaseNotesSha256) {
    throw new Error('NSH candidate release notes or licenses metadata changed');
  }
  for (const license of licenses) requireFile(directory, license);
  requireFile(directory, 'nsh-tests.xml');
}

function stagePublicFile(source, publicStage, name, sha256) {
  const destination = path.join(publicStage, name);
  fs.renameSync(source, destination);
  const file = {path: name, sha256: sha256 ?? fileSha256(destination), checksum: name + '.sha256'};
  fs.writeFileSync(path.join(publicStage, file.checksum), `${file.sha256}  ${name}\n`, {flag: 'wx'});
  return file;
}

/** 保全上游 updater 识别的归档原名，展开目录清理前将更新文件纳入批次证据。 */
function preserveUpdaterArchives(stage, appName, version, target) {
  // NSH 0.6.1 的 platform_archive_name 逐字符将非 ASCII 字母数字替换为连字符。
  const stem = appName.replace(/[^A-Za-z0-9]/gu, '-');
  const prefix = `${stem}-${version}-${target}-`;
  const architectures = target === 'macos' ? /^(?:aarch64|x86_64)\.tar\.gz$/u : /^[a-z0-9_]+\.zip$/u;
  const packageDirectory = path.join(stage, 'package');
  const updates = fs.readdirSync(packageDirectory).filter(name =>
    name.startsWith(prefix) && architectures.test(name.slice(prefix.length)));
  if (updates.length === 0) return;
  const directory = path.join(stage, 'updates');
  fs.mkdirSync(directory);
  for (const name of updates) {
    fs.renameSync(requireFile(stage, `package/${name}`), path.join(directory, name));
  }
}

function removePublicationPath(file, remove) {
  try { remove(file); }
  catch (error) { process.stderr.write(`NSH release cleanup preserved ${file}: ${error.message}\n`); }
}

/** 只撤回仍与本批暂存文件指向同一普通文件的公开链接。 */
function removeOwnedPublicationLink(source, destination) {
  const staged = fs.lstatSync(source, {bigint: true});
  const entry = fs.lstatSync(destination, {bigint: true, throwIfNoEntry: false});
  if (staged.isFile() && entry?.isFile() && staged.dev === entry.dev && staged.ino === entry.ino) {
    fs.unlinkSync(destination);
  }
}

/** 恢复精确的中断批次。活跃进程、无法确认的归属和已提交制品皆予以保留。 */
export function recoverNshDesktopRelease(root, target, buildRun) {
  assertBuildRun(target, buildRun);
  if (!desktopFormats.has(target)) throw new Error('only flat desktop publication can be recovered');
  const release = path.join(fs.realpathSync(root), 'release');
  const evidenceRoot = path.join(release, evidenceFolder);
  const lock = path.join(evidenceRoot, '.' + buildRun + '.lock');
  for (const directory of [release, evidenceRoot, lock]) requireDirectory(directory);
  const owner = JSON.parse(fs.readFileSync(requireFile(lock, 'owner.json'), 'utf8'));
  if (owner.buildRun !== buildRun || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
    throw new Error('invalid NSH publication owner');
  }
  try { process.kill(owner.pid, 0); }
  catch (error) {
    if (error.code !== 'ESRCH') throw error;
    const committed = fs.lstatSync(path.join(evidenceRoot, buildRun), {throwIfNoEntry: false});
    if (committed) locateNshCandidate(root, target, buildRun);
    else {
      const staged = path.join(lock, 'public');
      if (fs.lstatSync(staged, {throwIfNoEntry: false})) {
        requireDirectory(staged);
        for (const name of publicNames(staged, buildRun)) {
          removeOwnedPublicationLink(requireFile(staged, name), path.join(release, name));
        }
      }
    }
    fs.rmSync(lock, {recursive: true});
    return {buildRun, status: committed ? 'committed' : 'rolled-back'};
  }
  throw new Error('NSH publication owner is still active');
}

/** 同盘硬链接独占落位，证据目录最后原子提交。失败只撤回此次已落位文件。 */
export function publishNshDesktopRelease(release, stage, manifest, appName) {
  const {target, buildRun, mode, version} = manifest;
  assertBuildRun(target, buildRun);
  if (!usesFlatNshRelease(mode, target) || path.dirname(stage) !== release ||
      !safeLeafName(appName) || !safeLeafName(version)) throw new Error('invalid desktop release staging layout');
  requireDirectory(release);
  requireDirectory(stage);

  const evidenceRoot = path.join(release, evidenceFolder);
  fs.mkdirSync(evidenceRoot, {recursive: true});
  requireDirectory(evidenceRoot);
  const committed = path.join(evidenceRoot, buildRun);
  const legacyDirectory = path.join(release, buildRun);
  const lock = path.join(evidenceRoot, '.' + buildRun + '.lock');
  fs.mkdirSync(lock);
  const publicStage = path.join(lock, 'public');
  const linked = [];
  let preserveLock = false;
  try {
    if (publicNames(release, buildRun).length ||
        fs.lstatSync(committed, {throwIfNoEntry: false}) || fs.lstatSync(legacyDirectory, {throwIfNoEntry: false})) {
      throw new Error('NSH release buildRun already exists');
    }
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({buildRun, pid: process.pid}), {flag: 'wx'});
    fs.mkdirSync(publicStage);
    const stagedEvidence = path.join(lock, 'evidence');
    fs.renameSync(stage, stagedEvidence);
    stage = stagedEvidence;
    const packageDirectory = path.join(stage, 'package');
    requireDirectory(packageDirectory);
    const stem = `${clipFilenamePrefix(appName, 96)}_${clipFilenamePrefix(version, 48)}_${buildRun}`;
    const primary = stagePublicFile(requireFile(stage, manifest.artifact), publicStage,
      stem + '.' + desktopFormats.get(target), manifest.sha256);
    fs.unlinkSync(requireFile(stage, manifest.checksum));
    const deliveryFiles = [primary];
    if (target === 'windows') {
      const installers = fs.readdirSync(packageDirectory).filter(name => name.endsWith('-setup.exe'));
      if (installers.length > 1) throw new Error('expected at most one official Windows installer');
      if (installers.length) {
        const installer = requireFile(stage, `package/${installers[0]}`);
        deliveryFiles.push(stagePublicFile(installer, publicStage, stem + '-setup.exe'));
      }
    }
    preserveUpdaterArchives(stage, appName, version, target);
    fs.rmSync(packageDirectory, {recursive: true});
    Object.assign(manifest, {
      releaseLayout: 'flat-desktop',
      artifact: primary.path,
      sha256: primary.sha256,
      checksum: primary.checksum,
      deliveryFiles,
      files: inventory(stage),
    });
    validateEvidence(stage, manifest);
    fs.writeFileSync(path.join(stage, manifestName), JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx'});

    for (const file of publicNames(publicStage, buildRun)) {
      const source = path.join(publicStage, file);
      const destination = path.join(release, file);
      fs.linkSync(source, destination);
      linked.push({source, destination});
    }
    validatePublicFiles(release, manifest);
    if (fs.lstatSync(committed, {throwIfNoEntry: false})) throw new Error('NSH release buildRun already exists');
    fs.renameSync(stage, committed);
    return {output: release, manifest: path.join(committed, manifestName), ...manifest};
  } catch (error) {
    for (const {source, destination} of linked.reverse()) {
      try { removeOwnedPublicationLink(source, destination); }
      catch (cleanupError) {
        preserveLock = true;
        process.stderr.write(`NSH release cleanup preserved ${lock}: ${cleanupError.message}\n`);
      }
    }
    throw error;
  } finally {
    if (!preserveLock) removePublicationPath(lock, file => fs.rmSync(file, {recursive: true}));
  }
}

/** 只读按精确目标与 buildRun 选择新布局或历史批次。 */
export function locateNshCandidate(root, target, buildRun) {
  assertBuildRun(target, buildRun);
  const release = path.join(fs.realpathSync(root), 'release');
  requireDirectory(release);
  const evidenceRoot = path.join(release, evidenceFolder);
  const hasEvidenceRoot = fs.lstatSync(evidenceRoot, {throwIfNoEntry: false}) !== undefined;
  if (hasEvidenceRoot) requireDirectory(evidenceRoot);
  const flat = path.join(evidenceRoot, buildRun);
  const legacy = path.join(release, buildRun);
  const flatExists = hasEvidenceRoot && fs.lstatSync(flat, {throwIfNoEntry: false}) !== undefined;
  const legacyExists = fs.lstatSync(legacy, {throwIfNoEntry: false}) !== undefined;
  if (flatExists === legacyExists) throw new Error('expected exactly one committed NSH buildRun evidence directory');

  const evidenceDirectory = flatExists ? flat : legacy;
  const artifactDirectory = flatExists ? release : legacy;
  requireDirectory(evidenceDirectory);
  const manifestFile = requireFile(evidenceDirectory, manifestName);
  const manifestBytes = fs.readFileSync(manifestFile);
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.schemaVersion !== 1 || manifest.interface !== 'nsh' || manifest.mode !== 'candidate' ||
      manifest.target !== target || manifest.buildRun !== buildRun ||
      (flatExists ? manifest.releaseLayout !== 'flat-desktop' : manifest.releaseLayout !== undefined)) {
    throw new Error('NSH candidate identity or layout mismatch');
  }
  validateEvidence(evidenceDirectory, manifest);
  const primary = {path: manifest.artifact, sha256: manifest.sha256, checksum: manifest.checksum};
  if (flatExists) validatePublicFiles(artifactDirectory, manifest);
  else validateDigest(artifactDirectory, primary);
  return {
    artifact: path.join(artifactDirectory, manifest.artifact),
    artifactDirectory,
    evidenceDirectory,
    manifestFile,
    manifestSha256: createHash('sha256').update(manifestBytes).digest('hex'),
    manifest,
    deliveryFiles: flatExists ? manifest.deliveryFiles : [primary],
  };
}

/** 验收和就绪复核均从已发布上下文重新确定同一候选。 */
export function verifyNshCandidate(root, target, buildRun) {
  const result = locateNshCandidate(root, target, buildRun);
  const {manifest} = result;
  const context = checkContext({projectRoot: root}, {published: true});
  for (const key of ['version', 'sourceCommit', 'expectedTag', 'releaseContextSha256', 'releaseReview']) {
    if (!isDeepStrictEqual(manifest[key], context[key])) throw new Error(`NSH candidate release context mismatch: ${key}`);
  }
  const releaseChannel = !Object.hasOwn(manifest, 'releaseChannel') && context.schemaVersion === 3
    ? 'release' : manifest.releaseChannel;
  if (releaseChannel !== context.releaseChannel) throw new Error('NSH candidate release context mismatch: releaseChannel');
  // 工作区快照用于构建期间的漂移监测。候选可转移，以已发布源码和最终证据绑定。
  if (!/^[0-9a-f]{64}$/u.test(manifest.sourceSnapshot)) {
    throw new Error('invalid NSH candidate build source snapshot');
  }
  if (manifest.releaseNotesVersion !== `v${manifest.version}` ||
      manifest.reviewSelection !== context.releaseReview.selection || manifest.reviewStatus !== context.releaseReview.status ||
      manifest.releaseNotesSha256 !== fileSha256(path.join(root, releaseNotesName))) {
    throw new Error('NSH candidate review or release notes no longer match the released source');
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const {values} = parseArgs({options: {
      root: {type: 'string', default: '.'}, target: {type: 'string'}, 'build-run': {type: 'string'},
      'recover-interrupted': {type: 'boolean'},
    }});
    if (values['recover-interrupted']) {
      const result = recoverNshDesktopRelease(values.root, values.target, values['build-run']);
      process.stdout.write(JSON.stringify(result) + '\n');
    } else {
      const {artifact, artifactDirectory, evidenceDirectory, manifestFile, manifestSha256, deliveryFiles} =
        verifyNshCandidate(values.root, values.target, values['build-run']);
      process.stdout.write(JSON.stringify({
        artifact, artifactDirectory, evidenceDirectory, manifest: manifestFile, manifestSha256, deliveryFiles,
      }) + '\n');
    }
  } catch (error) {
    process.stderr.write(`NSH candidate: ${error.message}\n`);
    process.exitCode = 1;
  }
}
