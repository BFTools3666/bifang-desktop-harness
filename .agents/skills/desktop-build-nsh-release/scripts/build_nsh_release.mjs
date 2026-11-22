#!/usr/bin/env node
/** NSH 真实构建与不可覆盖的批次证据；不执行发布、安装或 E2E。 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { checkContext } from '../../desktop-prepare-release/scripts/release_context.mjs';
import { loadDocument,renderDocument } from '../../desktop-prepare-release/scripts/release_notes.mjs';
import { check as checkVersion } from '../../desktop-manage-version/scripts/version_gate.mjs';
import { readDependencyLockPolicy } from '../../desktop-implement-change/scripts/project_lock_policy.mjs';
import { resolveCargoDeviceTarget } from '../../desktop-implement-change/scripts/cargo_device_config.mjs';
import { nshRevisionForTargets, validNshIdentity } from '../../desktop-add-nsh-adapter/scripts/nsh_runtime_revision.mjs';
import {
  assertNshCargoRuntime, assertNshCliVersion, assertNshDefaultCargoBuildTarget, assertNshWorkspacePin,
  NSH_HOST_DESKTOP_PLATFORMS, nshCargoEnvironment, readNshMixedConfig,
} from '../../desktop-implement-change/scripts/nsh_runtime_policy.mjs';
import { iosPackagingIdentity,restoreIosDisplayIdentity } from './nsh_ios_identity.mjs';
import { NSH_BUILD_CACHE_NAMES, prepareNshPortableEntry } from './nsh_portable_entry.mjs';

import { addNshIosBindgenSdk, resolveNshPackageOptions } from './nsh_package_options.mjs';

const targets = ['macos','windows','linux','android','ios','ios-simulator','web'];

/** 缺省目标取当前桌面系统，移动、Web 与其他桌面系统都不会作为回退。 */
export function resolveNshPackageTarget(requested, host = process.platform) {
  const native = NSH_HOST_DESKTOP_PLATFORMS[host];
  if (requested === undefined && !native) throw new Error('no default NSH packaging target for this host; request a supported --target');
  const target = requested === undefined ? native : requested;
  if (!targets.includes(target)) throw new Error('unsupported NSH packaging target');
  if ((['macos', 'windows', 'linux'].includes(target) && target !== native) ||
      (['ios', 'ios-simulator'].includes(target) && host !== 'darwin')) {
    throw new Error('target requires its native host');
  }
  return target;
}

/** 仅允许受支持目标使用相同正式提交的 CLI 与 Cargo 运行时。 */
export function assertNshToolchain(root,selected,cliVersion) {
  const revision = nshRevisionForTargets(selected);
  assertNshWorkspacePin(fs.readFileSync(path.join(root, 'Cargo.toml'), 'utf8'));
  assertNshCliVersion(cliVersion);
  return revision;
}
/** 输出只能落在真实项目目录，拒绝链接目录和已有批次覆盖。 */
export function safeOutputPath(root,file) {
  const absolute=path.resolve(file);
  if(!absolute.startsWith(root+path.sep)) throw new Error('output escaped project root');
  for(let current=absolute;current!==root;current=path.dirname(current)) {
    try{if(fs.lstatSync(current).isSymbolicLink()) throw new Error('output path contains symlink');}catch(error){if(error.code!=='ENOENT') throw error;}
  }
  return absolute;
}
/** 真实子进程参数数组，无 shell 或任意 hook。 */
function run(command,args,cwd,env=process.env,capture=false) {
  const secret = env.NSH_KEYSTORE_PASSWORD;
  const redact = value => secret && value ? value.replaceAll(secret, '[redacted]') : value;
  const result=spawnSync(command,args,{cwd,env,encoding:'utf8',stdio:capture||secret?'pipe':'inherit',maxBuffer:32*1024*1024});
  if (secret && !capture && result.stdout) process.stdout.write(redact(result.stdout));
  if (secret && !capture && result.stderr) process.stderr.write(redact(result.stderr));
  if(result.status!==0 && capture && result.stderr) process.stderr.write(redact(result.stderr).slice(-12000));
  if (result.status !== 0) throw new Error(`${command} failed (${result.status ?? result.error?.code ?? 'unknown'})`);
  return redact(result.stdout)?.trim();
}
/** 候选日志通过短路径交给 Rust build.rs；本地试包显式清除继承值。 */
export function releaseNoteBuildInputs(stage,notes,baseEnvironment=process.env) {
  const env={...baseEnvironment};
  for(const key of ['HARNESS_RELEASE_NOTES','HARNESS_RELEASE_NOTES_ZH','HARNESS_RELEASE_NOTES_EN','HARNESS_RELEASE_NOTES_ZH_PATH','HARNESS_RELEASE_NOTES_EN_PATH']) delete env[key];
  if(!notes) return {env,temporary:[]};
  const zh=renderDocument(notes,'zh-CN'),en=renderDocument(notes,'en-US');
  const zhPath=path.join(stage,'release-notes.zh-CN.txt'),enPath=path.join(stage,'release-notes.en-US.txt');
  fs.writeFileSync(zhPath,zh,{flag:'wx',mode:0o600});
  fs.writeFileSync(enPath,en,{flag:'wx',mode:0o600});
  env.HARNESS_RELEASE_NOTES_ZH_PATH=zhPath;
  env.HARNESS_RELEASE_NOTES_EN_PATH=enPath;
  return {env,temporary:[zhPath,enPath]};
}
/** 产物目录拒绝链接；签名 bundle 内的框架链接只由官方打包器拥有。 */
export function inventory(directory) {
  const files=[];
  const walk=(current,relative='')=>{
    for(const name of fs.readdirSync(current).sort()) {
      const file=path.join(current,name), key=path.posix.join(relative,name), stat=fs.lstatSync(file);
      if(stat.isSymbolicLink()) {
        const link=fs.readlinkSync(file),resolved=fs.realpathSync(file);
        if(path.isAbsolute(link) || !resolved.startsWith(fs.realpathSync(directory)+path.sep)) throw new Error('artifact link escapes package');
        files.push({path:key,link}); continue;
      }
      if(stat.isDirectory()) walk(file,key);
      else if(stat.isFile()) files.push({path:key,size:stat.size,sha256:fileSha256(file)});
      else throw new Error('unsupported artifact type');
    }
  };
  walk(directory);return files;
}
/** 文件头检查和流式摘要使用固定大小缓冲区，避免大包占用相同大小的堆内存。 */
function filePrefix(file, size) {
  const fd = fs.openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(size);
    return bytes.subarray(0, fs.readSync(fd, bytes, 0, size, 0));
  } finally { fs.closeSync(fd); }
}

function fileSha256(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const hash = createHash('sha256');
    const bytes = Buffer.allocUnsafe(1024 * 1024);
    let count;
    while ((count = fs.readSync(fd, bytes)) > 0) hash.update(bytes.subarray(0, count));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

/** 校验官方输出的主包和应用入口，允许官方生成额外安装器或更新归档。 */
export function validateNshArtifacts(directory, target, {name, bundleFormat} = {}) {
  if (!targets.includes(target)) throw new Error('unsupported NSH packaging target');
  const files = inventory(directory).filter(file => file.sha256);
  const one = (list, label) => {
    if (list.length !== 1) throw new Error('expected exactly one ' + label);
    return list[0];
  };
  const read = (file, size) => filePrefix(path.join(directory, file.path), size);
  const exact = (extension, label) => one(files.filter(file =>
    name ? file.path === name + extension : !file.path.includes('/') && file.path.endsWith(extension)), label);
  const zip = (file) => {
    if (file.size < 22 || !read(file, 4).equals(Buffer.from([80, 75, 3, 4]))) throw new Error('invalid ZIP package header');
  };
  const pe = (file) => {
    if (read(file, 2).toString() !== 'MZ') throw new Error('invalid PE executable');
  };
  if (target === 'web') {
    const index = one(files.filter(file => path.posix.basename(file.path) === 'index.html' &&
      (!name || file.path === name + '/index.html')), 'Web index');
    const site = path.posix.dirname(index.path);
    const runtime = files.filter(file => site === '.' || file.path.startsWith(site + '/'));
    if (!runtime.some(file => file.path.endsWith('.wasm') && read(file, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) ||
        !runtime.some(file => file.path.endsWith('.js') && file.size > 0)) throw new Error('Web runtime is incomplete');
  } else if (target === 'android') {
    zip(exact('.' + (bundleFormat ?? 'apk'), 'Android package'));
  } else if (target === 'windows') {
    const archive = exact('.zip', 'Windows ZIP');
    zip(archive);
    const application = archive.path.slice(0, -4);
    pe(one(files.filter(file => path.posix.dirname(file.path) === application && file.path.endsWith('.exe')), 'Windows runner'));
    for (const installer of files.filter(file => !file.path.includes('/') && file.path.endsWith('-setup.exe'))) pe(installer);
  } else if (target === 'linux') {
    const archive = exact('.tar.gz', 'Linux archive');
    if (!read(archive, 2).equals(Buffer.from([31, 139]))) throw new Error('invalid gzip archive');
    const application = archive.path.slice(0, -7);
    if (!files.some(file => path.posix.dirname(file.path) === application &&
        read(file, 4).equals(Buffer.from([127, 69, 76, 70])))) throw new Error('Linux ELF executable missing');
  } else {
    if (bundleFormat === 'ipa') zip(exact('.ipa', 'signed IPA'));
    const executables = files.filter(file => {
      const components = file.path.split('/');
      if (name ? components[0] !== name + '.app' : !components[0].endsWith('.app')) return false;
      return target === 'macos'
        ? components.length === 4 && components[1] === 'Contents' && components[2] === 'MacOS'
        : components.length === 2;
    }).filter(file => ['cffaedfe', 'cefaedfe', 'feedfacf', 'cafebabe', 'bebafeca'].includes(read(file, 4).toString('hex')));
    one(executables, 'Mach-O app executable');
  }
  return files;
}

/** 官方 JUnit 只包含 NSH 测试文件，Rust 测试由 workspace 独立取证。 */
export function passingNshCases(report) {
  const header = /<testsuites name="nsh test" tests="(\d+)" failures="(\d+)" errors="(\d+)" skipped="(\d+)" time="[^"]+">/u.exec(report);
  if (!header || !report.trimEnd().endsWith('</testsuites>')) throw new Error('invalid NSH JUnit report');
  if (Number(header[2]) || Number(header[3])) throw new Error('NSH render tests failed');
  let passed = 0;
  for (const suite of report.matchAll(/<testsuite name="[^"]+\.test\.tsx?" tests="(\d+)" failures="0" errors="0" skipped="(\d+)"/gu)) {
    passed += Number(suite[1]) - Number(suite[2]);
  }
  if (passed <= 0) throw new Error('nonempty passing NSH render tests required');
  return passed;
}
/** 源、GUI 资源与受管文档按字节绑定，缓存和输出不进入快照。 */
export function sourceSnapshot(root) {
  const hash=createHash('sha256');
  const walk=(directory)=>{
    for(const name of fs.readdirSync(directory).sort()) {
      if(NSH_BUILD_CACHE_NAMES.has(name)) continue;
      const file=path.join(directory,name), stat=fs.lstatSync(file);
      if(['Cargo.lock','pnpm-lock.yaml','pnpm-package.lock'].includes(name)) continue;
      if(stat.isSymbolicLink()) throw new Error('source symlink is unsupported');
      if(stat.isDirectory()) walk(file);
      else if(stat.isFile()) hash.update(JSON.stringify([path.relative(root,file), stat.mode & 0o777, fileSha256(file)]));
      else throw new Error('unsupported NSH source type');
    }
  };
  walk(root);return hash.digest('hex');
}
/** 只读校验持久框架、版本与选择目标，不能把 CLI 当 NSH 打包。 */
export function packageFacts(root,metadata,target) {
  if(!targets.includes(target)) throw new Error('unsupported NSH packaging target');
  const pkg = assertNshCargoRuntime(root, metadata);
  const facts = metadata.metadata['agent-first-harness'];
  const platform = target === 'ios-simulator' ? 'ios' : target;
  if (!facts['target-platforms'].includes(platform)) throw new Error('target is not selected');
  const capability = platform === 'web' ? 'web' : ['android', 'ios'].includes(platform) ? 'mobile' : 'desktop';
  if (!facts['nsh-targets'].includes(capability)) throw new Error('NSH target capability is not selected');
  return { gui: path.dirname(pkg.manifest_path), version: pkg.version, policy: facts };
}
/** 构建前解析候选选择，测试和封包不掺入运行验收。 */
export function buildNshRelease({root,mode='local',target,e2e,e2eReason,e2eRisk,...packageInput}) {
  target = resolveNshPackageTarget(target);
  root=fs.realpathSync(root);
  if(!['local','candidate'].includes(mode)) throw new Error('mode must be local or candidate');
  if(mode==='candidate' && !['enabled','disabled'].includes(e2e)) throw new Error('candidate requires explicit e2e');
  if(mode==='candidate' && e2e==='disabled' && [e2eReason,e2eRisk].some(value=>typeof value!=='string' || !value.trim())) throw new Error('disabled E2E requires reason and remaining risk');
  if(readDependencyLockPolicy(root)==='tracked') throw new Error('NSH generated runtime workspace does not propagate tracked locks; packaging is blocked until a frozen resolution route is implemented');
  const context = mode === 'candidate' ? checkContext({projectRoot:root},{published:true}) : null;
  const releaseChannel = context?.releaseChannel ?? 'dev';
  const testEnv = { ...releaseNoteBuildInputs(null, null).env, HARNESS_RELEASE_CHANNEL: releaseChannel };
  delete testEnv.NSH_KEYSTORE_PASSWORD;
  const metadata=JSON.parse(run('cargo',['metadata','--offline','--no-deps','--format-version','1'],root,testEnv,true));
  const facts=packageFacts(root,metadata,target);
  assertNshDefaultCargoBuildTarget(facts.gui, testEnv);
  const targetDirectory = resolveCargoDeviceTarget({ projectRoot: root, metadata, environment: testEnv });
  const nshTestEnv = nshCargoEnvironment(targetDirectory, testEnv);
  const desktop = facts.policy['nsh-targets'].includes('desktop');
  const version=run('nsh',['--version'],root,testEnv,true);
  assertNshToolchain(root, facts.policy['nsh-targets'], version);
  const packageOptions = resolveNshPackageOptions(root, target, packageInput, nshCargoEnvironment(targetDirectory));
  let notes=null;
  if(fs.existsSync(path.join(root,'.harness/version-state.json'))) checkVersion(root,'build');
  if(context) {
    notes=loadDocument(path.join(root,'release-notes.json'));
    if(!notes || context.version!==facts.version || notes.releases[0].version!==`v${facts.version}`) throw new Error('candidate version mismatch');
  }
  const config = readNshMixedConfig(facts.gui);
  if (!validNshIdentity('nameZh', config.name)) throw new Error('nsh.json name must be a safe application package name');
  if (typeof config.id !== 'string' || config.id.length > 240 || !/^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z][A-Za-z0-9_-]*)+$/u.test(config.id)) {
    throw new Error('nsh.json id must be a reverse-DNS application identifier');
  }
  if (target === 'android' && config.id.includes('-')) throw new Error('Android application id cannot contain hyphens');
  if (['macos', 'ios', 'ios-simulator'].includes(target) && config.id.includes('_')) throw new Error('Apple bundle id cannot contain underscores');
  if (config.version !== facts.version) throw new Error('nsh.json version must match the Cargo member version');
  if (config.build !== undefined && (!Number.isInteger(config.build) || config.build < 1 || config.build > 0xffffffff)) {
    throw new Error('nsh.json build must be a positive 32-bit package build number');
  }
  const betaIdentity = releaseChannel === 'beta' ? { name: config.name + ' Beta', id: config.id + '.beta' } : null;
  if (betaIdentity) {
    if (!validNshIdentity('nameZh', betaIdentity.name) || betaIdentity.id.length > 240) {
      throw new Error('NSH Beta application name or id exceeds the packaging limit');
    }
    Object.assign(config, betaIdentity);
  }
  const iosIdentity = target === 'ios' || target === 'ios-simulator' ? iosPackagingIdentity(config.name) : null;
  if (iosIdentity?.changed && packageOptions.bundleFormat === 'ipa') {
    throw new Error('NSH cannot sign this iOS name: its executable would collide with the nsh resources directory');
  }

  const before = sourceSnapshot(root);
  const batch = `nsh-${target}-${randomUUID()}`;
  const parent = safeOutputPath(root, path.join(root, mode === 'candidate' ? 'release' : '.nsh/packages'));
  fs.mkdirSync(parent, {recursive:true});
  const stage = fs.mkdtempSync(path.join(parent, '.nsh-package-'));
  try {
    const testArgs = ['test','--workspace','--all-targets','--all-features','--target','host-tuple'];
    const tests = run('cargo', [...testArgs,'--','--list'], root, testEnv, true);
    if (!/^.+: test$/mu.test(tests)) throw new Error('nonempty workspace tests required');
    run('cargo', testArgs, root, testEnv);
    run('nsh', ['check'], facts.gui, nshTestEnv);
    const report = path.join(stage, 'nsh-tests.xml');
    run('nsh', ['test', '.', '--junit', report], facts.gui, nshTestEnv);
    const renderTestCases = passingNshCases(fs.readFileSync(report, 'utf8'));
    if (sourceSnapshot(root) !== before) throw new Error('source changed during tests');

    const {env, temporary} = releaseNoteBuildInputs(stage, notes, packageOptions.env);
    env.HARNESS_RELEASE_CHANNEL = releaseChannel;
    addNshIosBindgenSdk(target, env, sdk => run('xcrun', ['--sdk',sdk,'--show-sdk-path'], root, env, true));
    const portable = desktop && ['android','ios','ios-simulator','web'].includes(target);
    const staged = portable || Boolean(betaIdentity);
    const entry = staged ? prepareNshPortableEntry(root, facts.gui, stage, { portable, betaIdentity }) : facts.gui;
    const packageRoot = path.join(stage, 'package');
    run('nsh', ['package','--target',target,'--out',packageRoot,'--app-version',facts.version,
      ...(iosIdentity?.changed ? ['--name',iosIdentity.packageName] : []), ...packageOptions.args], entry, env);
    if (staged) fs.rmSync(path.join(stage, 'portable-source'), {recursive:true});
    for (const file of temporary) fs.unlinkSync(file);
    if (iosIdentity?.changed) {
      const app = restoreIosDisplayIdentity(packageRoot, iosIdentity);
      if (target === 'ios-simulator') run('codesign', ['--force','--sign','-','--timestamp=none','--preserve-metadata=entitlements',app], root);
    }
    if (['ad-hoc','provisioning-profile'].includes(packageOptions.signing)) {
      run('codesign', ['--verify','--deep','--strict',path.join(packageRoot, config.name + '.app')], root);
    }

    const { bundleFormat, signing, abis } = packageOptions;
    validateNshArtifacts(packageRoot, target, {name:config.name, bundleFormat});
    if (mode === 'candidate') {
      for (const name of ['release-notes.json','LICENSE.zh-CN.md','LICENSE.en.md']) fs.copyFileSync(path.join(root,name),path.join(stage,name));
    }
    const archive = bundleFormat === 'app.tar.gz' ? 'application.tar.gz' : bundleFormat === 'web.tar.gz' ? 'web.tar.gz' : null;
    if (archive) run('tar', ['-czf',path.join(stage,archive),'-C',packageRoot,'.'], root);
    const artifact = archive ?? path.posix.join('package', config.name + '.' + bundleFormat);
    const artifactSha = fileSha256(path.join(stage, artifact));
    fs.writeFileSync(path.join(stage, artifact + '.sha256'), `${artifactSha}  ${path.basename(artifact)}\n`);
    if (sourceSnapshot(root) !== before) throw new Error('source changed during packaging');
    if (mode === 'candidate') checkContext({projectRoot:root,expectedSha256:context.releaseContextSha256},{published:true});
    const androidArch = abis?.length === 1 ? {'arm64-v8a':'arm64','armeabi-v7a':'arm','x86_64':'x64'}[abis[0]] : 'universal';
    const manifest = {
      schemaVersion:1, project:facts.policy['project-id'], interface:'nsh', nshTargets:facts.policy['nsh-targets'],
      mode, releaseChannel, target, platform:target==='ios-simulator'?'ios':target, host:process.platform,
      hostArch:process.arch, arch:packageOptions.arch ?? (target==='web'?'wasm32':target==='android'?androidArch:['ios','ios-simulator'].includes(target)?'arm64':process.arch),
      ...(abis ? {androidAbis:abis} : {}),
      buildMode:['web','android','ios','ios-simulator'].includes(target) || packageOptions.arch && packageOptions.arch !== process.arch ? 'cross' : 'native',
      buildRun:batch, bundleFormat,
      artifactKind:target==='web'?'web-archive':bundleFormat==='aab'?'application-archive':['apk','ipa'].includes(bundleFormat)?'installer':'application-archive',
      artifact, sha256:artifactSha, checksum:artifact+'.sha256', version:facts.version, appId:config.id, appBuild:config.build ?? 1,
      sourceCommit:context?.sourceCommit??null, sourceSnapshot:before, tool:version,
      e2eSelection:mode==='candidate'?e2e:'not-applicable',
      e2eStatus:mode==='candidate'&&e2e==='enabled'?'pending':'Not run',
      ...(e2e==='disabled'?{e2eReason,e2eRemainingRisk:e2eRisk}:{}),
      signingSelection:signing, signingSource:packageOptions.args.includes('--sign') || packageOptions.args.includes('--keystore')
        ? 'explicit-official-signing' : 'official-local-packaging-default',
      unitTests:{status:'passed',testCases:tests.split('\n').filter(line=>line.endsWith(': test')).length,nshRenderTests:'passed',nshRenderTestCases:renderTestCases},
      milestoneAcceptance:'pending', runtimeVerification:'Unverified', files:inventory(stage),
    };
    if (target==='web') manifest.webRoot=path.posix.join('package',config.name);
    if (context) Object.assign(manifest, {
      expectedTag:context.expectedTag,releaseContextSha256:context.releaseContextSha256,releaseReview:context.releaseReview,
      reviewSelection:context.releaseReview.selection,reviewStatus:context.releaseReview.status,
      candidateSelections:{e2eSelection:e2e,signingSelection:signing,signingSource:manifest.signingSource},
      releaseNotesVersion:notes.releases[0].version,releaseNotesSha256:fileSha256(path.join(stage,'release-notes.json')),
      releaseNotesPath:'release-notes.json',releaseNotesResourceVerification:'sidecar-byte-identical',licenses:['LICENSE.zh-CN.md','LICENSE.en.md'],
    });
    fs.writeFileSync(path.join(stage,'manifest.json'), JSON.stringify(manifest,null,2)+'\n');
    const output = safeOutputPath(root, path.join(parent, batch));
    fs.renameSync(stage, output);
    return {output,manifest:path.join(output,'manifest.json'),...manifest};
  } finally {
    fs.rmSync(stage, {recursive:true,force:true});
  }
}

if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  try {const {values}=parseArgs({options:{root:{type:'string',default:'.'},mode:{type:'string',default:'local'},target:{type:'string'},e2e:{type:'string'},'e2e-reason':{type:'string'},'e2e-risk':{type:'string'},arch:{type:'string'},abi:{type:'string',multiple:true},format:{type:'string'},sign:{type:'string'},profile:{type:'string'},keystore:{type:'string'},'key-alias':{type:'string'},'asset-url':{type:'string'}}});const result=buildNshRelease({...values,e2eReason:values['e2e-reason'],e2eRisk:values['e2e-risk'],keyAlias:values['key-alias'],assetUrl:values['asset-url']});process.stdout.write(JSON.stringify({output:result.output,manifest:result.manifest,buildRun:result.buildRun,bundleFormat:result.bundleFormat,webRoot:result.webRoot,mode:result.mode,releaseChannel:result.releaseChannel,target:result.target,version:result.version,artifact:result.artifact,sha256:result.sha256,unitTests:result.unitTests})+'\n');}
  catch(error){process.stderr.write(`NSH build: ${error.message}\n`);process.exitCode=1;}
}
