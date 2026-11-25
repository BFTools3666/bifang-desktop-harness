/** deslop-please 与 rust-analyzer 延迟环境门禁的只读检查、安装复探与安全隔离回归测试。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ensure_deslop_please.mjs');

/** 在隔离目录写入可执行 stub 脚本，模拟不同宿主环境状态。 */
function writeStub(binDir, name, body) {
  const file = path.join(binDir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

/** 使用隔离 PATH 运行环境门禁脚本并解析单行 JSON 输出。 */
function runGate(args, binDir, { testMode = true } = {}) {
  const env = { ...process.env, AFH_PREREQ_PATH: binDir };
  if (testMode) env.AFH_TEST_MODE = '1';
  else delete env.AFH_TEST_MODE;
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env });
  const raw = (result.stdout || result.stderr).trim();
  return { status: result.status, json: JSON.parse(raw) };
}

test('只读模式在缺失 rust-analyzer 与 deslop-please 时返回退出码 20 且零写入', (t) => {
  if (process.platform === 'win32') t.skip('POSIX sh stub 仅在非 Windows 宿主执行');
  const binDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deslop_gate_')));
  t.after(() => fs.rmSync(binDir, { recursive: true, force: true }));

  const { status, json } = runGate(['--check-only'], binDir);
  assert.equal(status, 20);
  assert.equal(json.status, 'missing');
  assert.equal(json.rustAnalyzer.status, 'missing');
  assert.equal(json.deslopPlease.status, 'missing');
});

test('写入模式自动安装缺失的 rust-analyzer 组件与 deslop-please 并复探通过', (t) => {
  if (process.platform === 'win32') t.skip('POSIX sh stub 仅在非 Windows 宿主执行');
  const binDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deslop_gate_')));
  t.after(() => fs.rmSync(binDir, { recursive: true, force: true }));
  const markerRa = path.join(binDir, 'ra.installed');
  const markerDeslop = path.join(binDir, 'deslop.installed');

  writeStub(binDir, 'rustup', `if [ "$1" = "component" ] && [ "$2" = "add" ] && [ "$3" = "rust-analyzer" ]; then echo ok > "${markerRa}"; exit 0; fi; exit 1`);
  writeStub(binDir, 'rust-analyzer', `if [ -f "${markerRa}" ]; then echo "rust-analyzer 1.98.1"; exit 0; fi; exit 127`);
  writeStub(binDir, 'cargo', `if [ "$1" = "install" ] && [ "$2" = "--locked" ] && [ "$3" = "deslop-please" ]; then echo ok > "${markerDeslop}"; exit 0; fi; exit 1`);
  writeStub(binDir, 'deslop-please', `if [ -f "${markerDeslop}" ] && [ "$1" = "--help" ]; then echo "usage: deslop-please [crate_or_mod]"; exit 0; fi; exit 127`);

  const { status, json } = runGate(['--install-missing'], binDir);
  assert.equal(status, 0);
  assert.equal(json.status, 'passed');
  assert.equal(json.rustAnalyzer.change, 'installed');
  assert.equal(json.deslopPlease.change, 'installed');
});

test('生产模式禁止使用 AFH_PREREQ_PATH 覆盖', (t) => {
  const binDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deslop_gate_')));
  t.after(() => fs.rmSync(binDir, { recursive: true, force: true }));
  const { status, json } = runGate(['--check-only'], binDir, { testMode: false });
  assert.equal(status, 1);
  assert.match(json.message, /AFH_TEST_MODE=1/u);
});
