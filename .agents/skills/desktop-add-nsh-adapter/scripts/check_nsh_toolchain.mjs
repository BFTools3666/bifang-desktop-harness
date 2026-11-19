/** 从下游根校验 npm 开发脚本将使用的 Cargo 运行时和 CLI。 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertNshCliVersion, assertNshWorkspacePin, readNshCargoApp, readNshMixedConfig } from '../../desktop-implement-change/scripts/nsh_runtime_policy.mjs';

try {
  const root = fs.realpathSync(process.cwd());
  assertNshWorkspacePin(fs.readFileSync(path.join(root, 'Cargo.toml'), 'utf8'));
  readNshMixedConfig(path.dirname(readNshCargoApp(root).manifest_path));
  const result = spawnSync('nsh', ['--version'], {
    cwd: root, encoding: 'utf8', timeout: 10_000, windowsHide: true,
  });
  if (result.status !== 0) throw new Error(result.error?.message ?? result.stderr.trim());
  assertNshCliVersion(result.stdout);
} catch (error) {
  process.stderr.write(`NSH: ${error.message}\n`);
  process.exitCode = 1;
}
