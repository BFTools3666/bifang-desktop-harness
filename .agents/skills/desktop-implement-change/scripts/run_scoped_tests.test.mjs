/** 用隔离夹具验证实际出站参数和空选择失败关闭。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { main } from './run_scoped_tests.mjs';

const APP = 'sample_nsh';
const NSH_FILE = `${APP}/tests/Account Login.test.tsx`;
const RUST_CASE = 'tests::reads_config';
const RUST = ['rust', '--rust-package', 'sample_core', '--rust-test', RUST_CASE];
const FULL = ['--scope', 'full', '--human-authorization', 'fixture approval reference'];

/** 准备应用与共享 Cargo 路径，所有测试命令只记录参数或产生受控报告。 */
function fixture(t, {
  listed = `${RUST_CASE}: test\n`, executed = `test ${RUST_CASE} ... ok\n`, nshCases = 1, nshStatus = 0,
} = {}) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'scoped-tests-fixture-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cwd = path.join(directory, 'project');
  fs.mkdirSync(path.join(cwd, APP, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'Cargo.toml'), '# cargo metadata fixture');
  fs.writeFileSync(path.join(cwd, APP, 'nsh.json'), '{}');
  fs.writeFileSync(path.join(cwd, NSH_FILE), '// scope fixture');
  fs.writeFileSync(path.join(cwd, 'Outside.test.tsx'), '// outside app fixture');
  const metadata = JSON.stringify({ workspace_root: cwd, target_directory: path.join(directory, 'global-target'),
    workspace_members: ['core'], packages: [{ id: 'core', name: 'sample_core' }, { id: 'external', name: 'other' }] });
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'rustup') return { status: 1 };
    if (command === 'cargo') {
      if (args[0] === 'metadata') return { status: 0, stdout: metadata };
      if (args.includes('--list')) return { status: 0, stdout: listed };
      return { status: 0, stdout: executed };
    }
    assert.equal(command, process.execPath);
    assert.match(args[0], /[/\\]check_nsh_toolchain\.mjs$/u);
    assert.equal(args.at(-2), '--junit');
    if (nshStatus !== 0) return { status: nshStatus };
    fs.writeFileSync(args.at(-1), `<testsuites name="nsh test" tests="${nshCases}" failures="0" errors="0" skipped="0" time="0.1"></testsuites>`);
    return { status: 0 };
  };
  return { calls, cwd, execute: (args, host = 'darwin') => main(args, { cwd, host, run }) };
}

test('rejects implicit, mixed and malformed scopes before invoking any tool', t => {
  const scoped = fixture(t);
  for (const args of [
    ['rust'], ['nsh', '--nsh-app', APP], ['nsh', '--nsh-app', APP, '--target', 'macos'],
    ['rust', '--scope', 'full'], ['rust', '--human-authorization', 'fixture'],
    ['rust', '--scope', 'full', '--human-authorization', ' \t'],
    ['rust', '--scope', 'full', '--human-authorization', 'one', '--human-authorization', 'two'],
    [...RUST, ...FULL], RUST.slice(0, 3), [...RUST.slice(0, 3), '--rust-test=--unknown'],
    ['rust', '--rust-package', '*', '--rust-test', RUST_CASE],
    ['nsh', '--test', NSH_FILE, ...FULL], ['nsh', '--nsh-filter', 'login'], ['nsh', ...FULL],
    ['nsh', '--test', NSH_FILE, '--nsh-filter', ' '], ['nsh', '--test', NSH_FILE, '--test', NSH_FILE],
    ['nsh', '--test', NSH_FILE, '--target', 'windows'],
  ]) {
    assert.throws(() => scoped.execute(args), undefined, args.join(' '));
  }
  assert.deepEqual(scoped.calls, []);
});

test('rejects NSH directories, globs, traversal, files outside the selected app and missing files', t => {
  const scoped = fixture(t);
  for (const file of [APP, `${APP}/tests/*.test.tsx`, `${APP}/../Outside.test.tsx`,
    `${APP}/missing.test.tsx`, 'Outside.test.tsx', path.join(scoped.cwd, NSH_FILE)]) {
    assert.throws(() => scoped.execute(['nsh', '--nsh-app', APP, '--test', file]), /路径|相对|目录内/u, file);
  }
  assert.deepEqual(scoped.calls, []);
});

test('uses default host and one package and runs a unique exact Rust case', t => {
  const scoped = fixture(t);
  scoped.execute(RUST);
  const runs = scoped.calls.filter(({ command, args }) => command === 'cargo' && args[0] === 'test');
  const expected = ['test', '--all-features', '--target', 'host-tuple', '--package', 'sample_core', RUST_CASE, '--', '--exact'];
  assert.deepEqual(runs.map(({ args }) => args), [[...expected, '--list'], [...expected, '--color', 'never']]);
  assert.deepEqual(scoped.calls.slice(0, 3).map(({ command }) => command), ['cargo', 'rustup', 'cargo']);
});

test('zero, duplicate or non-workspace Rust selection never runs tests', t => {
  for (const listed of ['other::case: test\n', `${RUST_CASE}: test\n${RUST_CASE}: test\n`]) {
    const scoped = fixture(t, { listed });
    assert.throws(() => scoped.execute(RUST), /应唯一命中/u);
    assert.equal(scoped.calls.filter(({ args }) => args[0] === 'test').length, 1);
    assert.equal(scoped.calls.at(-1).args.at(-1), '--list');
  }
  const scoped = fixture(t);
  assert.throws(() => scoped.execute(['rust', '--rust-package', 'other', '--rust-test', RUST_CASE]), /没有所选包/u);
  assert.equal(scoped.calls.length, 1);
});

test('an ignored Rust case does not count as a successful focused run', t => {
  const scoped = fixture(t, { executed: `test ${RUST_CASE} ... ignored, requires a separate workflow\n` });
  assert.throws(() => scoped.execute(RUST), /没有实际通过/u);
  assert.deepEqual(scoped.calls.at(-1).args.slice(-2), ['--color', 'never']);
});

test('forwards one exact NSH file and a literal name filter through the native checker', t => {
  const scoped = fixture(t);
  scoped.execute(['nsh', '--nsh-app', APP, '--target', 'macos', '--test', NSH_FILE, '--nsh-filter', 'login [pending]']);
  assert.equal(scoped.calls.length, 1);
  const call = scoped.calls[0];
  assert.equal(call.options.cwd, scoped.cwd);
  assert.deepEqual(call.args.slice(1, -1), ['macos', '--', 'test', NSH_FILE, '--target', 'macos', '--filter=login [pending]', '--junit']);
  assert.equal(fs.existsSync(path.dirname(call.args.at(-1))), false);
});

test('no matching NSH cases or an NSH failure never falls back to a larger run', t => {
  for (const options of [{ nshCases: 0 }, { nshStatus: 12 }]) {
    const scoped = fixture(t, options);
    assert.throws(() => scoped.execute(['nsh', '--test', NSH_FILE, '--nsh-filter', 'missing']), /零命中|失败/u);
    assert.equal(scoped.calls.length, 1);
    assert.equal(fs.existsSync(path.dirname(scoped.calls[0].args.at(-1))), false);
  }
});

test('explicit full syntax preserves the existing command for the chosen runner only', t => {
  const scoped = fixture(t);
  scoped.execute(['rust', ...FULL]);
  assert.deepEqual(scoped.calls.at(-1).args, ['test', '--workspace', '--all-targets', '--all-features', '--target', 'host-tuple']);
  assert.ok(scoped.calls.every(({ command }) => command !== process.execPath));

  scoped.calls.length = 0;
  scoped.execute(['nsh', '--nsh-app', APP, ...FULL]);
  assert.equal(scoped.calls.length, 1);
  assert.deepEqual(scoped.calls[0].args.slice(1, -1), ['--', 'test', APP, '--junit']);
});
