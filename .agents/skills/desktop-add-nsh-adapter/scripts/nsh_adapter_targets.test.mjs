import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { NSH_REVISION, normalizeNshOptions, nshDependencies, nshPackageScripts, nshRevisionForTargets, renderNshAdapterFiles } from './nsh_adapter_files.mjs';
import { assertNshDefaultCargoBuildTarget, assertNshNativeDevelopmentTarget, assertNshSharedCargoTarget } from '../../desktop-implement-change/scripts/nsh_runtime_policy.mjs';

const checkNsh = "node .agents/skills/desktop-add-nsh-adapter/scripts/check_nsh_toolchain.mjs";
const preflight = checkNsh + ' && ';
const profile = Object.freeze({
  system_tray: 'disabled', system_notification: 'disabled', autostart: 'disabled',
  about_page: 'disabled', sponsor_page: 'disabled', single_instance: 'disabled',
  deep_link: 'disabled', global_shortcut: 'disabled', sidebar_mode: 'detailed',
});
const base = { projectId: 'sample_tool', nameZh: '示例工具', nameEn: 'Sample Tool', owner: 'test-owner' };

/** 未选择 TUI 的工程不暴露终端入口。 */
test('supported NSH targets use only the released v0.6.0 runtime and scripts', () => {
  const desktop = { ...base, targetPlatforms: ['macos'], nshTargets: ['desktop'], profile };
  const mobileWeb = { ...base, targetPlatforms: ['android', 'web'], nshTargets: ['mobile', 'web'] };
  assert.equal(NSH_REVISION, '554163758e30d2f62f814096a6327937dcb4fe49');
  for (const options of [desktop, mobileWeb]) {
    assert.equal(nshRevisionForTargets(options.nshTargets), NSH_REVISION);
    const dependencies = nshDependencies(options);
    assert.match(dependencies, new RegExp(NSH_REVISION, 'u'));
    assert.doesNotMatch(dependencies, /nsh-base/u);
    const files = renderNshAdapterFiles(options);
    assert.doesNotMatch(files.get('sample_tool_nsh/Cargo.toml'), /nsh-base/u);
    assert.ok(![...files.keys()].some(name => name.includes('.tui.')));
    const scripts = nshPackageScripts(options.projectId, options.nshTargets, options.targetPlatforms);
    assert.equal(scripts['nsh:check'], preflight + 'nsh check sample_tool_nsh');
    assert.equal(scripts['nsh:test'], preflight + 'nsh test sample_tool_nsh');
    assert.equal(scripts.test, 'cargo test --workspace --all-targets --all-features --target host-tuple');
    assert.equal(scripts['dev:tui'], undefined);
    assert.equal(scripts['nsh:test:tui'], undefined);
  }
});

/** 直接调用各生成入口也拒绝不受支持的目标。 */
test('generation_rejects_unsupported_nsh_targets', () => {
  const terminal = { ...base, targetPlatforms: ['macos'], nshTargets: ['unknown'] };
  const combined = { ...terminal, nshTargets: ['desktop', 'unknown'], profile };
  for (const options of [terminal, combined]) {
    assert.throws(() => normalizeNshOptions(options), /invalid NSH targets/u);
    assert.throws(() => renderNshAdapterFiles(options), /invalid NSH targets/u);
    assert.throws(() => nshDependencies(options), /invalid NSH targets/u);
    assert.throws(() => nshRevisionForTargets(options.nshTargets), /invalid NSH targets/u);
    assert.throws(() => nshPackageScripts(options.projectId, options.nshTargets, options.targetPlatforms), /invalid NSH targets/u);
  }
});

test('development defaults are native and iOS runs only through its explicit script', () => {
  const ios = nshPackageScripts('sample_tool', ['mobile'], ['ios']);
  assert.equal(ios.dev, undefined);
  assert.equal(ios['dev:ios'], preflight + 'nsh run sample_tool_nsh --target ios');
  assert.equal(ios['dev:android'], undefined);
  assert.equal(ios['nsh:test:ios'], undefined);
  const mixed = nshPackageScripts('sample_tool', ['desktop','mobile','web','tui'], ['macos','ios','android','web']);
  assert.equal(mixed.dev, checkNsh + ' desktop && nsh run sample_tool_nsh');
  assert.equal(mixed['dev:web'], preflight + 'nsh run sample_tool_nsh --target web');
  assert.equal(mixed['nsh:test:web'], undefined);
  assert.equal(mixed['nsh:test:android'], undefined);
  assert.equal(mixed['nsh:test:macos'], checkNsh + ' macos && nsh test sample_tool_nsh/App.test.tsx --target macos');
  assert.equal(mixed['nsh:test:tui'], checkNsh + ' tui && nsh test sample_tool_nsh/App.test.tsx --target tui');
});

test('native development checks both the execution host and project selection', () => {
  const selection = { 'nsh-targets': ['desktop', 'tui'], 'target-platforms': ['macos', 'windows'] };
  assert.doesNotThrow(() => assertNshNativeDevelopmentTarget(selection, 'macos', 'darwin'));
  assert.doesNotThrow(() => assertNshNativeDevelopmentTarget(selection, 'desktop', 'win32'));
  assert.doesNotThrow(() => assertNshNativeDevelopmentTarget(selection, 'tui', 'darwin'));
  assert.throws(() => assertNshNativeDevelopmentTarget(selection, 'windows', 'darwin'), /native host/u);
  assert.throws(() => assertNshNativeDevelopmentTarget(selection, 'tui', 'linux'), /native host/u);
});

test('the upstream NSH app-local Cargo fallback is rejected', () => {
  const root = path.join(os.tmpdir(), 'nsh-test-project');
  const sharedTarget = path.join(os.tmpdir(), 'shared-cargo-target');
  assert.doesNotThrow(() => assertNshSharedCargoTarget(root, { CARGO_TARGET_DIR: sharedTarget }));
  assert.throws(() => assertNshSharedCargoTarget(root, {}), /system-wide/u);
  assert.throws(() => assertNshSharedCargoTarget(root, { CARGO_TARGET_DIR: 'target' }), /system-wide/u);
  assert.throws(() => assertNshSharedCargoTarget(root, { CARGO_TARGET_DIR: path.join(root, 'target') }), /outside the project/u);
});

test('NSH refuses an implicit target configured for upstream Cargo subprocesses', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nsh-cargo-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cargoHome = path.join(root, 'global');
  const member = path.join(root, 'workspace', 'app');
  fs.mkdirSync(cargoHome);
  fs.mkdirSync(member, { recursive: true });
  const environment = { CARGO_HOME: cargoHome };
  const global = path.join(cargoHome, 'config.toml');
  fs.writeFileSync(global, '[build]\ntarget-dir = "shared"\n');
  assert.doesNotThrow(() => assertNshDefaultCargoBuildTarget(member, environment));
  assert.throws(() => assertNshDefaultCargoBuildTarget(member, { ...environment, CARGO_BUILD_TARGET: 'wasm32-unknown-unknown' }), /host target/u);
  fs.writeFileSync(global, 'include = [{ path = "absent.toml", optional = true }, "target.toml"]\n');
  const included = path.join(cargoHome, 'target.toml');
  fs.writeFileSync(included, '"build"."target" = ["wasm32-unknown-unknown"]\n');
  assert.throws(() => assertNshDefaultCargoBuildTarget(member, environment), /host target/u);
  fs.writeFileSync(included, '[target.wasm32-unknown-unknown]\nrunner = "tools/runner"\n');
  fs.mkdirSync(path.join(member, '.cargo'));
  fs.writeFileSync(path.join(member, '.cargo', 'config'), 'build = { target = "wasm32-unknown-unknown" }\n');
  assert.throws(() => assertNshDefaultCargoBuildTarget(member, environment), /host target/u);
});

test('renderer preserves literal dollar replacements and token-shaped names', () => {
  const options = {...base, nameZh:'工具 $& __PROJECT_ID__', nshTargets:['tui'], targetPlatforms:['macos']};
  const files = renderNshAdapterFiles(options);
  assert.equal(JSON.parse(files.get('sample_tool_nsh/nsh.json')).name, options.nameZh);
  assert.ok(files.get('sample_tool_nsh/App.tsx').includes(JSON.stringify(options.nameZh)));
});
