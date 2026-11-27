/** 构建前失败关闭、真实文件头与输出范围回归。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { assertNshToolchain,buildNshRelease,inventory,packageFacts,passingNshCases,releaseNoteBuildInputs,resolveNshPackageTarget,safeOutputPath,validateNshArtifacts } from './build_nsh_release.mjs';
import { renderDocument } from '../../desktop-prepare-release/scripts/release_notes.mjs';

/** 临时包只用于拒绝畸形输入，不能充当运行验证。 */
function fixture(run){const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nsh-package-test-')));try{run(root);}finally{fs.rmSync(root,{recursive:true,force:true});}}

const current = '0c29b5e3351128f489fe53bfb167160801707191';
const git = 'https://github.com/longbridge/nsh.git';
const older = [
  ['0.7.1', 'f78eace7af23a9c1c72605c7ee46204f57f3e8e6'],
  ['0.7.0', '3f8ecd8b3c55ad6274c6babbf7ee55c4cd4ae359'],
  ['0.6.1', '2f51d8611677c8a6bbad937b39756e8d0cc45350'],
  ['0.6.0', '554163758e30d2f62f814096a6327937dcb4fe49'],
  ['0.5.0', 'f4d68f7f9f31eb7b3ecc8a4cbc31096d5c6238a1'],
  ['0.5.1', '224d9a795c7ac9d10d75750de9351adac5549675'],
];

/** 独立成员必须匹配当前运行时与目标，旧框架和混装都被拒绝。 */
test('package_facts_accepts_only_current_top_level_nsh', () => fixture(root => {
  const metadata = (extra = {}, req = '^0.7.2', revision = current) => ({
    workspace_root: root, workspace_members: ['member-id'],
    packages: [{
      id: 'member-id', name: 'sample_tool_nsh', version: '0.1.0',
      manifest_path: path.join(root, 'sample_tool_nsh', 'Cargo.toml'),
      dependencies: [{ name: 'nsh-core', req, source: 'git+' + git + '?rev=' + revision }],
    }],
    metadata: { 'agent-first-harness': {
      'project-id': 'sample_tool', interfaces: ['nsh'],
      'target-platforms': ['macos', 'android', 'web'], 'nsh-targets': ['desktop', 'mobile', 'web'], ...extra,
    } },
  });
  for (const target of ['web', 'android', 'macos']) {
    assert.equal(packageFacts(root, metadata(), target).gui, path.join(root, 'sample_tool_nsh'));
  }
  assert.throws(() => packageFacts(root, metadata({ 'nsh-targets': ['tui'], 'target-platforms': ['macos'] }), 'macos'), /target capability is not selected/u);
  assert.throws(() => packageFacts(root, metadata(), 'tui'), /unsupported NSH packaging target/u);
  assert.throws(() => packageFacts(root, metadata({ 'nsh-targets': ['desktop', 'web'] }), 'macos'), /target-platforms mismatch/u);
  assert.throws(() => packageFacts(root, metadata(), 'linux'), /not selected/u);
  assert.throws(() => packageFacts(root, metadata({ interfaces: ['gui'], 'gui-framework': 'nsh' }), 'macos'), /requires NSH workspace/u);
  for (const [version, revision] of older) {
    assert.throws(() => packageFacts(root, metadata({}, '^' + version, revision), 'web'), /仅支持官方 v0\.7\.2/u);
  }
  const mixed = metadata();
  mixed.workspace_members.push('core');
  const [previousVersion, previousRevision] = older[0];
  mixed.packages.push({ id: 'core', dependencies: [{ name: 'nsh-core', rename: 'old_runtime', req: '^' + previousVersion, source: 'git+' + git + '?rev=' + previousRevision }] });
  assert.throws(() => packageFacts(root, mixed, 'web'), /仅支持官方 v0\.7\.2/u);
}));

/** Cargo 和 CLI 必须分别匹配发布版本与提交。 */
test('nsh_toolchain_requires_exact_v072_cli_and_runtime', () => fixture(root => {
  const file = path.join(root, 'Cargo.toml');
  const manifest = (version, revision) => '[workspace.dependencies]\nnsh-core = { version = "' + version + '", git = "' + git + '", rev = "' + revision + '" }\n';
  fs.writeFileSync(file, manifest('0.7.2', current));
  assert.equal(assertNshToolchain(root, ['web'], 'nsh 0.7.2 (0c29b5e)'), current);
  for (const [version, revision] of older) {
    const oldCli = 'nsh ' + version + ' (' + revision.slice(0, 7) + ')';
    assert.throws(() => assertNshToolchain(root, ['web'], oldCli), /do not match/u);
    fs.writeFileSync(file, manifest(version, revision));
    assert.throws(() => assertNshToolchain(root, ['web'], oldCli), /仅支持官方 v0\.7\.2/u);
    fs.writeFileSync(file, manifest('0.7.2', current));
  }
  fs.writeFileSync(file, manifest('0.7.2', older[0][1]));
  assert.throws(() => assertNshToolchain(root, ['web'], 'nsh 0.7.2 (0c29b5e)'), /仅支持官方 v0\.7\.2/u);
  fs.writeFileSync(file, manifest(older[0][0], current));
  assert.throws(() => assertNshToolchain(root, ['web'], 'nsh 0.7.2 (0c29b5e)'), /仅支持官方 v0\.7\.2/u);
}));

/** 旧工程在测试或包目录写入之前失败。 */
test('legacy_gui_nsh_cannot_enter_build', () => fixture(root => {
  fs.writeFileSync(path.join(root, 'Cargo.toml'), '[workspace]\nmembers = ["sample_tool_gui"]\n[workspace.metadata.agent-first-harness]\nproject-id = "sample_tool"\ninterfaces = ["gui"]\ngui-framework = "nsh"\ntarget-platforms = ["web"]\n');
  const member = path.join(root, 'sample_tool_gui');
  fs.mkdirSync(path.join(member, 'src'), { recursive: true });
  fs.writeFileSync(path.join(member, 'Cargo.toml'), '[package]\nname = "sample_tool_gui"\nversion = "0.1.0"\nedition = "2024"\n');
  fs.writeFileSync(path.join(member, 'src', 'lib.rs'), '');
  const regressionPlan = path.join(root, 'local-plan.json');
  fs.writeFileSync(regressionPlan, JSON.stringify({schemaVersion: 1, scope: {kind: 'development'},
    changedPaths: [], tests: [], excludedChanges: [], noTestsReason: 'Only testing the workspace rejection gate.'}));
  assert.throws(() => buildNshRelease({ root, target: 'web', regressionPlan }), /requires NSH workspace/u);
  assert.equal(fs.existsSync(path.join(root, 'target')), false);
}));

/** 缺少本次精确测试范围时，不启动 Cargo 或创建输出目录。 */
test('unscoped_nsh_build_is_rejected_before_any_test_or_output', () => fixture(root => {
  fs.writeFileSync(path.join(root, 'Cargo.toml'), '[workspace]\n');
  assert.throws(() => buildNshRelease({root, target: 'web'}), /regression-plan/u);
  assert.deepEqual(fs.readdirSync(root), ['Cargo.toml']);
}));

test('tracked_resolution_and_unanswered_candidate_selection_fail_before_build',()=>fixture(root=>{
  fs.writeFileSync(path.join(root,'Cargo.toml'),'[workspace.metadata.agent-first-harness]\ndependency-lock-policy = "tracked"\n');
  assert.throws(()=>buildNshRelease({root,mode:'candidate',target:'web'}),/explicit e2e/u);
  assert.throws(()=>buildNshRelease({root,mode:'candidate',target:'web',e2e:'disabled'}),/reason/u);
  assert.throws(()=>buildNshRelease({root,target:'web'}),/does not propagate tracked locks/u);
  assert.equal(fs.readdirSync(root).length,1);
}));

/** 不受支持的目标在任何构建命令前被拒绝。 */
test('unsupported_target_rejects_before_creating_build_state',()=>fixture(root=>{
  for (const mode of ['local','candidate']) assert.throws(()=>buildNshRelease({root,mode,target:'tui',e2e:'enabled'}),/unsupported NSH packaging target/u);
  assert.throws(()=>validateNshArtifacts(path.join(root,'missing'),'tui'),/unsupported NSH packaging target/u);
  assert.equal(fs.readdirSync(root).length,0);
}));

test('default NSH packaging resolves only the current desktop platform', () => {
  for (const [host, expected] of [['darwin', 'macos'], ['win32', 'windows'], ['linux', 'linux']]) {
    assert.equal(resolveNshPackageTarget(undefined, host), expected);
    assert.equal(resolveNshPackageTarget('web', host), 'web');
    assert.equal(resolveNshPackageTarget('android', host), 'android');
  }
  assert.throws(() => resolveNshPackageTarget('windows', 'darwin'), /native host/u);
  assert.throws(() => resolveNshPackageTarget('ios', 'linux'), /native host/u);
  assert.equal(resolveNshPackageTarget('ios-simulator', 'darwin'), 'ios-simulator');
  assert.throws(() => resolveNshPackageTarget(undefined, 'freebsd'), /no default/u);
});

test('output_and_artifact_links_cannot_escape_root',()=>fixture(root=>{
  const outside=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'nsh-outside-')));
  try{
    fs.symlinkSync(outside,path.join(root,'release'));
    assert.throws(()=>safeOutputPath(root,path.join(root,'release','candidate')),/symlink/u);
    fs.mkdirSync(path.join(root,'.nsh'));fs.symlinkSync(outside,path.join(root,'.nsh/packages'));
    assert.throws(()=>safeOutputPath(root,path.join(root,'.nsh/packages','batch')),/symlink/u);
    fs.writeFileSync(path.join(outside,'payload'),'bytes');
    fs.symlinkSync(path.join(outside,'payload'),path.join(root,'escaped'));
    assert.throws(()=>inventory(root),/escapes/u);
    assert.throws(()=>safeOutputPath(root,path.join(outside,'candidate')),/escaped/u);
  }finally{fs.rmSync(outside,{recursive:true,force:true});}
}));

test('fake_suffixes_and_incomplete_official_packages_are_rejected',()=>fixture(root=>{
  fs.writeFileSync(path.join(root,'fake.zip.txt'),'fake');
  assert.throws(()=>validateNshArtifacts(root,'windows'),/exactly one/u);
  fs.writeFileSync(path.join(root,'app.zip'),'not a zip');
  assert.throws(()=>validateNshArtifacts(root,'windows'),/header/u);
  fs.writeFileSync(path.join(root,'index.html'),'<html></html>');
  assert.throws(()=>validateNshArtifacts(root,'web'),/incomplete/u);
  assert.throws(()=>validateNshArtifacts(root,'macos'),/Mach-O/u);
}));

test('official_named_web_directory_is_discovered_and_requires_real_wasm_header',()=>fixture(root=>{
  const site=path.join(root,'NSH 工程验证');fs.mkdirSync(site);
  fs.writeFileSync(path.join(site,'index.html'),'<!doctype html><html></html>');
  fs.writeFileSync(path.join(site,'app.js'),'export {};');
  fs.writeFileSync(path.join(site,'app.wasm'),Buffer.from([0,97,115,109,1,0,0,0]));
  assert.equal(validateNshArtifacts(root,'web').length,3);
  fs.writeFileSync(path.join(site,'app.wasm'),'not WebAssembly');assert.throws(()=>validateNshArtifacts(root,'web'),/incomplete/u);
}));

test('large_valid_release_notes_are_transported_by_short_paths',()=>fixture(root=>{
  const notes={schemaVersion:2,releases:Array.from({length:10},(_,index)=>({
    version:`v0.${10-index}.0`,releaseDate:'2026-11-07',
    featureOptimizations:Array.from({length:10},(_,itemIndex)=>({
      'zh-CN':`第 ${index}-${itemIndex} 项：${'工'.repeat(2390)}`,
      'en-US':`Item ${index}-${itemIndex}: ${'a'.repeat(2390)}`,
    })),bugFixes:[],
  }))};
  const documentBytes=Buffer.byteLength(JSON.stringify(notes));
  assert.ok(documentBytes>900_000 && documentBytes<1024*1024,documentBytes);
  const {env,temporary}=releaseNoteBuildInputs(root,notes,{
    ...process.env,HARNESS_RELEASE_NOTES_ZH:'stale',HARNESS_RELEASE_NOTES_EN_PATH:'stale',
  });
  assert.equal(temporary.length,2);
  assert.equal(env.HARNESS_RELEASE_NOTES_ZH,undefined);
  assert.equal(env.HARNESS_RELEASE_NOTES_EN,undefined);
  assert.equal(fs.readFileSync(env.HARNESS_RELEASE_NOTES_ZH_PATH,'utf8'),renderDocument(notes,'zh-CN'));
  assert.equal(fs.readFileSync(env.HARNESS_RELEASE_NOTES_EN_PATH,'utf8'),renderDocument(notes,'en-US'));
  const child=spawnSync(process.execPath,['-e','process.stdout.write("started")'],{env,encoding:'utf8'});
  assert.equal(child.status,0,child.error?.message);
  assert.equal(child.stdout,'started');
  const local=releaseNoteBuildInputs(root,null,env);
  assert.equal(local.env.HARNESS_RELEASE_NOTES_ZH_PATH,undefined);
  assert.equal(local.env.HARNESS_RELEASE_NOTES_EN_PATH,undefined);
}));

test('official Windows ZIP remains primary when Inno Setup and updater archives are present',()=>fixture(root=>{
  const zip = Buffer.alloc(22);
  zip.set([80,75,3,4]);
  fs.mkdirSync(path.join(root,'Example'));
  fs.writeFileSync(path.join(root,'Example/Example.exe'),'MZ runner');
  fs.writeFileSync(path.join(root,'Example-setup.exe'),'MZ installer');
  fs.writeFileSync(path.join(root,'Example.zip'),zip);
  fs.writeFileSync(path.join(root,'Example-0.1.0-x64.zip'),zip);
  assert.equal(validateNshArtifacts(root,'windows',{name:'Example'}).length,4);
  fs.unlinkSync(path.join(root,'Example/Example.exe'));
  assert.throws(()=>validateNshArtifacts(root,'windows',{name:'Example'}),/Windows runner/u);
}));

test('JUnit rejects Rust-only and skipped NSH suites despite successful process exit', () => {
  const report = suites => '<testsuites name="nsh test" tests="3" failures="0" errors="0" skipped="1" time="1.000">' + suites + '</testsuites>';
  const suite = (name, total, skipped) => `<testsuite name="${name}" tests="${total}" failures="0" errors="0" skipped="${skipped}"></testsuite>`;
  const rust = suite('workspace Cargo tests',2,0);
  assert.throws(()=>passingNshCases(report(rust+suite('App.test.tsx',1,1))),/nonempty passing/u);
  assert.equal(passingNshCases(report(rust+suite('App.test.tsx',2,1))),1);
});
