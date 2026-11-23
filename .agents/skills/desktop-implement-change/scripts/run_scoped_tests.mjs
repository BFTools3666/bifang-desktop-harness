#!/usr/bin/env node
/** 在启动 Cargo 或 NSH 前锁定下游测试范围。 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveCargoDeviceTarget } from './cargo_device_config.mjs';

const NSH_CHECKER = fileURLToPath(new URL('../../desktop-add-nsh-adapter/scripts/check_nsh_toolchain.mjs', import.meta.url));
const NATIVE_HOSTS = { macos: 'darwin', linux: 'linux', windows: 'win32' };
const TEST_FILE = /\.test\.tsx?$/u;
const FULL_SCOPE = '全量测试要求 --scope full --human-authorization <本次人工授权引用>，且不得同时传入定向选择器';

/** 只接受仓库内实际存在的路径，避免目录误发现、glob、参数注入或链接跳转。 */
function exactPath(root, relative, directory = false) {
  const segments = relative.split('/');
  if (relative.startsWith('-') || /[*?\[\]{}:\\\u0000-\u001f]|[!+@]\(/u.test(relative) ||
      segments.some(segment => !segment || segment === '.' || segment === '..') ||
      (!directory && !TEST_FILE.test(relative))) {
    throw new Error(`需要精确的项目相对${directory ? '应用目录' : ' NSH 测试文件'}：${JSON.stringify(relative)}`);
  }
  let current = root;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const entry = fs.lstatSync(current, { throwIfNoEntry: false });
    const matches = directory || index < segments.length - 1 ? entry?.isDirectory() : entry?.isFile();
    if (!matches) throw new Error(`路径不存在或不是普通文件或目录：${JSON.stringify(relative)}`);
  }
  if (directory && !fs.lstatSync(path.join(current, 'nsh.json'), { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`NSH 应用目录缺少 nsh.json：${relative}`);
  }
  return relative;
}

/** 在任何子进程启动前拒绝重复、空值、混合选择或隐式全量。 */
function selectScope(args, root, host) {
  const [runner, ...cli] = args;
  if (!['rust', 'nsh'].includes(runner)) throw new Error('请选择 rust 或 nsh 测试入口');
  const scopeFields = ['scope', 'human-authorization'];
  const focusFields = runner === 'rust' ? ['rust-package', 'rust-test'] : ['test', 'nsh-filter'];
  const targetFields = runner === 'nsh' ? ['nsh-app', 'target'] : [];
  const supported = [...scopeFields, ...focusFields, ...targetFields];
  const { values } = parseArgs({
    args: cli,
    options: Object.fromEntries(supported.map(name => [name, { type: 'string', multiple: true }])),
  });
  for (const [name, entries] of Object.entries(values)) {
    if (entries.length !== 1 || !entries[0].trim()) throw new Error(`--${name} 必须提供唯一非空值`);
  }
  const option = name => values[name]?.[0];
  const full = scopeFields.some(name => option(name) !== undefined);
  if (full && (option('scope') !== 'full' || !option('human-authorization') ||
      focusFields.some(name => option(name) !== undefined))) throw new Error(FULL_SCOPE);

  if (runner === 'rust') {
    const rustPackage = option('rust-package');
    const test = option('rust-test');
    if (!full && (!rustPackage || !/^[A-Za-z0-9_][A-Za-z0-9_-]*$/u.test(rustPackage) ||
        !test || test.startsWith('-') || test.trim() !== test || /[\u0000-\u001f\u007f]/u.test(test))) {
      throw new Error(`Rust 定向测试要求 --rust-package <包名> --rust-test <精确用例名>。${FULL_SCOPE}`);
    }
    return { runner, full, rustPackage, test };
  }

  const target = option('target');
  if (target && (target === 'tui' ? !Object.values(NATIVE_HOSTS).includes(host) : NATIVE_HOSTS[target] !== host)) {
    throw new Error(`NSH ${target} 测试须在对应宿主运行`);
  }
  const file = option('test');
  const app = option('nsh-app');
  if (full && !app) throw new Error('NSH 全量测试还须指定 --nsh-app <项目相对应用目录>');
  if (!full && !file) throw new Error(`NSH 定向测试要求 --test <精确测试文件>。${FULL_SCOPE}`);
  if (app) exactPath(root, app, true);
  if (file) exactPath(root, file);
  if (app && file && !file.startsWith(`${app}/`)) throw new Error('所选 NSH 测试文件须位于指定应用目录内');
  return { runner, full, target, file: full ? app : file, filter: option('nsh-filter') };
}

/** 以参数数组启动已选择的工具，并保留原进程诊断。 */
function runChecked(run, command, args, options, showOutput = false) {
  const result = run(command, args, { windowsHide: true, ...options });
  if (showOutput && result.stdout) process.stdout.write(result.stdout);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 失败（${result.signal ?? result.status}）`);
  return result.stdout;
}

/** 验证包属于本机工作区并核对共享 Cargo 目录，再确认 Rust 精确选择唯一命中。 */
function runRust(scope, root, run) {
  const output = runChecked(run, 'cargo', ['metadata', '--offline', '--no-deps', '--format-version', '1'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 16 * 1024 * 1024,
  });
  const metadata = JSON.parse(output);
  if (path.resolve(metadata.workspace_root) !== root) throw new Error('Cargo 所在目录须为工作区根');
  if (!scope.full && !metadata.packages.some(pkg => pkg.name === scope.rustPackage && metadata.workspace_members.includes(pkg.id))) {
    throw new Error(`Cargo 工作区没有所选包：${scope.rustPackage}`);
  }
  resolveCargoDeviceTarget({ projectRoot: root, metadata, run });

  const targetFlags = ['--all-features', '--target', 'host-tuple'];
  if (scope.full) {
    runChecked(run, 'cargo', ['test', '--workspace', '--all-targets', ...targetFlags], { cwd: root, stdio: 'inherit' });
    return;
  }
  const command = ['test', ...targetFlags, '--package', scope.rustPackage, scope.test, '--', '--exact'];
  const listed = runChecked(run, 'cargo', [...command, '--list'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1024 * 1024,
  });
  const hits = listed.split(/\r?\n/u).filter(line => line === `${scope.test}: test`).length;
  if (hits !== 1) throw new Error(`Rust 精确用例 ${scope.test} 应唯一命中，实际 ${hits} 项`);
  const executed = runChecked(run, 'cargo', [...command, '--color', 'never'], {
    cwd: root, encoding: 'utf8', stdio: ['inherit', 'pipe', 'inherit'], maxBuffer: 8 * 1024 * 1024,
  }, true);
  if (!executed.split(/\r?\n/u).includes(`test ${scope.test} ... ok`)) {
    throw new Error(`Rust 精确用例 ${scope.test} 没有实际通过`);
  }
}

/** 从当前宿主的受管入口执行 NSH，并按官方 JUnit 核对实际通过的用例。 */
function runNsh(scope, root, run) {
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'harness-scoped-nsh-'));
  try {
    const report = path.join(scratch, 'results.xml');
    const native = scope.target ? [scope.target] : [];
    const targetArgs = scope.target ? ['--target', scope.target] : [];
    const filter = scope.filter ? [`--filter=${scope.filter}`] : [];
    runChecked(run, process.execPath, [NSH_CHECKER, ...native, '--', 'test', scope.file,
      ...targetArgs, ...filter, '--junit', report], { cwd: root, stdio: 'inherit' });
    if (!fs.lstatSync(report, { throwIfNoEntry: false })?.isFile()) throw new Error('NSH 未生成 JUnit 测试报告');
    const xml = fs.readFileSync(report, 'utf8');
    const summary = /<testsuites name="nsh test" tests="(\d+)" failures="(\d+)" errors="(\d+)" skipped="(\d+)"/u.exec(xml);
    if (!summary || !xml.trimEnd().endsWith('</testsuites>') || Number(summary[2]) ||
        Number(summary[3]) || Number(summary[1]) <= Number(summary[4])) {
      throw new Error(`NSH 测试未通过或零命中：${scope.file}`);
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 2 });
  }
}

/** 选择运行范围后才进入对应工具链，并允许专项回归替换子进程。 */
export function main(args = process.argv.slice(2), { cwd = process.cwd(), host = process.platform, run = spawnSync } = {}) {
  const root = fs.realpathSync(cwd);
  const scope = selectScope(args, root, host);
  if (scope.runner === 'rust') runRust(scope, root, run);
  else runNsh(scope, root, run);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { main(); }
  catch (error) { process.stderr.write(`测试范围门禁：${error.message}\n`); process.exitCode = 1; }
}
