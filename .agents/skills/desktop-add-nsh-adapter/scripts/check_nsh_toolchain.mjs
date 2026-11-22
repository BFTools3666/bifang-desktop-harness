/** 从下游根验证 Cargo 与 CLI，并用系统 Cargo 目录执行 NSH 开发入口。 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveCargoDeviceTarget } from '../../desktop-implement-change/scripts/cargo_device_config.mjs';
import {
  assertNshCargoRuntime, assertNshCliVersion, assertNshDefaultCargoBuildTarget,
  assertNshNativeDevelopmentTarget, assertNshWorkspacePin, nshCargoEnvironment,
  readNshCargoMetadata, readNshMixedConfig,
} from '../../desktop-implement-change/scripts/nsh_runtime_policy.mjs';

try {
  const args = process.argv.slice(2);
  const separator = args.indexOf('--');
  const selectors = separator < 0 ? args : args.slice(0, separator);
  const command = separator < 0 ? null : args.slice(separator + 1);
  if (selectors.length > 1 || (command && !['build', 'check', 'run', 'test'].includes(command[0]))) {
    throw new Error('use [native target] -- <build|check|run|test> to run NSH');
  }
  const root = fs.realpathSync(process.cwd());
  assertNshWorkspacePin(fs.readFileSync(path.join(root, 'Cargo.toml'), 'utf8'));
  const metadata = readNshCargoMetadata(root);
  const member = path.dirname(assertNshCargoRuntime(root, metadata).manifest_path);
  assertNshDefaultCargoBuildTarget(member);
  readNshMixedConfig(member);
  const [nativeTarget] = selectors;
  if (nativeTarget) assertNshNativeDevelopmentTarget(metadata.metadata['agent-first-harness'], nativeTarget);
  const targetDirectory = resolveCargoDeviceTarget({ projectRoot: root, metadata });
  if (!command && !process.env.CARGO_TARGET_DIR) {
    throw new Error('use this helper followed by -- and the NSH command to forward the configured system Cargo directory');
  }
  const env = nshCargoEnvironment(targetDirectory);
  const result = spawnSync('nsh', ['--version'], {
    cwd: root, env, encoding: 'utf8', timeout: 10_000, windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.error?.message ?? result.stderr.trim());
  assertNshCliVersion(result.stdout);
  if (command) {
    const execution = spawnSync('nsh', command, { cwd: root, env, stdio: 'inherit' });
    if (execution.error) throw execution.error;
    process.exitCode = execution.status ?? 1;
  }
} catch (error) {
  process.stderr.write(`NSH: ${error.message}\n`);
  process.exitCode = 1;
}
