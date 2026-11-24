/** 安装载体失败关闭、参数边界和 macOS 真实磁盘映像回归。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { prepareNshDesktopInstaller } from './nsh_desktop_installer.mjs';

/** 每例拥有独立目录，正常与失败路径均清理。 */
function fixture(t) {
  const stage = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nsh-installer-')));
  t.after(() => fs.rmSync(stage, {recursive: true, force: true}));
  const packageRoot = path.join(stage, 'package'); fs.mkdirSync(packageRoot);
  return {stage, packageRoot, name: '示例 Desktop'};
}

/** 缺失官方安装器不能退回 ZIP，也不能挑选多个不明 EXE。 */
test('windows_requires_one_actual_official_installer', t => {
  const input = {...fixture(t), target: 'windows'};
  fs.writeFileSync(path.join(input.packageRoot, 'Example.zip'), 'zip');
  assert.throws(() => prepareNshDesktopInstaller(input), /official setup.exe/u);
  fs.writeFileSync(path.join(input.packageRoot, 'Example-setup.exe'), 'MZ');
  assert.deepEqual(prepareNshDesktopInstaller(input), {artifact: 'package/Example-setup.exe', bundleFormat: 'exe'});
  fs.writeFileSync(path.join(input.packageRoot, 'Other-setup.exe'), 'MZ');
  assert.throws(() => prepareNshDesktopInstaller(input), /exactly one/u);
});

/** DMG 形成前保存应用签名并提供 Applications 拖拽目标，失败清除输入目录。 */
test('macos_uses_system_dmg_tools_and_cleans_temporary_input_on_failure', t => {
  const input = {...fixture(t), target: 'macos'};
  fs.mkdirSync(path.join(input.packageRoot, input.name + '.app'));
  const calls = [];
  assert.throws(() => prepareNshDesktopInstaller(input, (command, args) => {
    calls.push({command, args});
    if (command === 'hdiutil') {
      assert.equal(fs.readlinkSync(path.join(input.stage, '.dmg-input', 'Applications')), '/Applications');
      throw new Error('image creation failed');
    }
  }), /image creation failed/u);
  assert.deepEqual(calls.map(entry => entry.command), ['ditto', 'codesign', 'hdiutil']);
  assert.equal(calls[0].args[0], path.join(input.packageRoot, input.name + '.app'));
  assert.equal(fs.existsSync(path.join(input.stage, '.dmg-input')), false);
});

/** 在 macOS 上实际创建、校验并只读挂载测试映像；这只证明包装器行为。 */
test('macos_real_dmg_contains_signed_app_and_applications_link', {skip: process.platform !== 'darwin' && 'requires macOS hdiutil'}, t => {
  const input = {...fixture(t), target: 'macos'};
  const contents = path.join(input.packageRoot, input.name + '.app', 'Contents');
  fs.mkdirSync(path.join(contents, 'MacOS'), {recursive: true});
  fs.copyFileSync('/usr/bin/true', path.join(contents, 'MacOS', 'fixture'));
  fs.writeFileSync(path.join(contents, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?>' +
    '<plist version="1.0"><dict><key>CFBundleExecutable</key><string>fixture</string>' +
    '<key>CFBundleIdentifier</key><string>test.harness.dmg</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
  const run = (command, args, cwd = input.stage) => {
    const result = spawnSync(command, args, {cwd, encoding: 'utf8', timeout: 60000});
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    return result.stdout;
  };
  run('codesign', ['--force', '--sign', '-', '--timestamp=none', path.dirname(contents)]);
  const result = prepareNshDesktopInstaller(input, run);
  assert.deepEqual(result, {artifact: 'application.dmg', bundleFormat: 'dmg'});
  const mount = path.join(input.stage, 'mounted'); fs.mkdirSync(mount);
  run('hdiutil', ['attach', '-readonly', '-nobrowse', '-mountpoint', mount, path.join(input.stage, result.artifact)]);
  try {
    assert.equal(fs.readlinkSync(path.join(mount, 'Applications')), '/Applications');
    assert.ok(fs.existsSync(path.join(mount, input.name + '.app', 'Contents', 'MacOS', 'fixture')));
  } finally { run('hdiutil', ['detach', mount]); }
});
