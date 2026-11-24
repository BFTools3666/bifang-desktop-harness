#!/usr/bin/env node
/** 保留已发布的名称 CLI 路径，实际规则由所有接口保留的工程模块维护。 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../../desktop-implement-change/scripts/installer_artifact_name.mjs';
export { installerArtifactName, main } from '../../desktop-implement-change/scripts/installer_artifact_name.mjs';
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { process.stderr.write(`Installer name: ${error.message}\n`); process.exitCode = 1; }
}
