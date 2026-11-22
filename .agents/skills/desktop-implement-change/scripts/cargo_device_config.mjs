#!/usr/bin/env node
/** 用当前设备的 Cargo 配置核实实际工作区输出目录。 */
import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** 判断候选路径是否落在同一目录或其后代中，路径可以分属不同 Windows 卷。 */
function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** 真实目录可能尚未创建，只解析已存在的祖先并保留待创建的路径部分。 */
function canonicalDirectory(directory) {
  if (!path.isAbsolute(directory)) throw new Error("Cargo target_directory must be absolute");
  const missing = [];
  for (let current = path.resolve(directory); ; current = path.dirname(current)) {
    try {
      const canonical = realpathSync(current);
      if (!statSync(canonical).isDirectory()) throw new Error("Cargo target_directory is not a directory");
      return path.join(canonical, ...missing.reverse());
    } catch (error) {
      if (error.code !== "ENOENT" || current === path.dirname(current)) throw error;
      if (lstatSync(current, { throwIfNoEntry: false })) throw error;
      missing.push(path.basename(current));
    }
  }
}

/** 使用只读、离线 metadata 查询实际 Cargo 的 target_directory。 */
function readMetadata(run, command, args, options) {
  const result = run(command, args, options);
  if (result.status !== 0) {
    const detail = result.error?.code ?? `exit ${result.status ?? "unknown"}`;
    throw new Error(`Cargo metadata could not resolve the device configuration (${detail})`);
  }
  try { return JSON.parse(result.stdout); }
  catch { throw new Error("Cargo metadata must return valid JSON"); }
}

/** 比较构建目录与仓库外 Cargo 查询，只接受同一个已配置的设备级目录。 */
export function resolveCargoDeviceTarget({
  projectRoot, manifestPath = "Cargo.toml", buildDirectory = path.dirname(manifestPath),
  metadata, locked = false, environment = process.env, run = spawnSync,
}) {
  const root = realpathSync(projectRoot);
  const manifest = realpathSync(path.resolve(root, manifestPath));
  const cwd = realpathSync(path.resolve(root, buildDirectory));
  if (!isWithin(root, manifest) || !isWithin(root, cwd) || path.basename(manifest) !== "Cargo.toml") {
    throw new Error("Cargo manifest and build directory must belong to the project");
  }
  const args = ["metadata", "--format-version", "1", "--no-deps", "--offline", "--manifest-path", manifest];
  if (locked) args.push("--locked");
  const options = { cwd, env: environment, encoding: "utf8", timeout: 30_000, maxBuffer: 32 * 1024 * 1024, windowsHide: true };
  const actual = metadata ?? readMetadata(run, "cargo", args, options);
  const actualTarget = canonicalDirectory(actual?.target_directory ?? "");
  if (isWithin(root, actualTarget)) throw new Error("Cargo requires a configured device-global target directory outside the project");

  // Cargo discovers config using cwd, while rustup may select a toolchain using the original cwd.
  const rustup = run("rustup", ["which", "cargo"], options);
  const toolchainCargo = rustup.status === 0 ? rustup.stdout.trim() : "cargo";
  if (rustup.status === 0 && !path.isAbsolute(toolchainCargo)) throw new Error("rustup returned an invalid active Cargo path");
  const global = readMetadata(run, toolchainCargo, args, { ...options, cwd: path.parse(root).root });
  const globalTarget = canonicalDirectory(global?.target_directory ?? "");
  if (path.relative(globalTarget, actualTarget) || isWithin(root, globalTarget)) {
    throw new Error("Cargo target_directory differs from the device-global configuration");
  }
  return globalTarget;
}

/** 供手动构建在真实 Rust 或 Tauri 工作目录核对目标路径。 */
function main() {
  const { values } = parseArgs({ options: {
    "project-root": { type: "string", default: "." }, manifest: { type: "string" },
    cwd: { type: "string" }, locked: { type: "boolean", default: false },
  } });
  const projectRoot = path.resolve(values["project-root"]);
  const manifestPath = values.manifest ? path.resolve(projectRoot, values.manifest) : undefined;
  const targetDirectory = resolveCargoDeviceTarget({ projectRoot, manifestPath, buildDirectory: values.cwd, locked: values.locked });
  process.stdout.write(`${JSON.stringify({ targetDirectory })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
