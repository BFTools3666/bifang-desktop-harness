/** 验证活跃 Cargo、设备输出和实际构建目录的选择，不执行任何 Rust 构建。 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveCargoDeviceTarget } from "./cargo_device_config.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), "cargo-device-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, "project");
  const member = path.join(project, "gui", "src-tauri");
  fs.mkdirSync(member, { recursive: true });
  for (const directory of [project, member]) fs.writeFileSync(path.join(directory, "Cargo.toml"), "# metadata fixture\n");
  return { root, project, member };
}

function probe(actualTarget, globalTarget, activeCargo) {
  const calls = [];
  const reply = stdout => ({ status: 0, stdout });
  function run(command, args, options) {
    calls.push({ command, args, ...options });
    if (command === "rustup") return activeCargo ? reply(activeCargo + "\n") : { status: 1, stdout: "" };
    const target = options.cwd === path.parse(options.cwd).root ? globalTarget : actualTarget;
    return reply(JSON.stringify({ target_directory: target }));
  }
  return { run, calls };
}

test("follows the actual Cargo scope and active toolchain with file-only device configuration", t => {
  const { root, project, member } = fixture(t);
  const target = path.join(root, "Rust output range", "uncreated");
  const active = path.join(root, "toolchain", process.platform === "win32" ? "cargo.exe" : "cargo");
  const environment = { CARGO_HOME: path.join(root, "user cargo config") };
  const manifest = path.join(member, "Cargo.toml");
  const { run, calls } = probe(target, target, active);
  assert.equal(resolveCargoDeviceTarget({ projectRoot: project, manifestPath: manifest, environment, locked: true, run }), target);
  assert.deepEqual(calls.map(({ command, cwd }) => [command, cwd]), [["cargo", member], ["rustup", member], [active, path.parse(project).root]]);
  for (const call of calls) assert.equal(call.env, environment);
  for (const call of [calls[0], calls[2]]) {
    assert.deepEqual(call.args, ["metadata", "--format-version", "1", "--no-deps", "--offline", "--manifest-path", manifest, "--locked"]);
  }
  assert.equal(fs.existsSync(target), false);
});

test("accepts an existing environment choice and rejects external and local workspace redirects", t => {
  const { root, project } = fixture(t);
  const global = path.join(root, "user-selected location");
  const environment = { CARGO_TARGET_DIR: global };
  const { run, calls } = probe(global, global);
  assert.equal(resolveCargoDeviceTarget({ projectRoot: path.relative(process.cwd(), project), environment, run }), global);
  assert.equal(calls.at(-1).command, "cargo");
  const alternate = probe(path.join(root, "workspace-specific location"), global);
  assert.throws(() => resolveCargoDeviceTarget({ projectRoot: project, run: alternate.run }), /differs from the device-global configuration/u);
  const fallback = probe(path.join(project, "target"), path.join(project, "target"));
  assert.throws(() => resolveCargoDeviceTarget({ projectRoot: project, run: fallback.run }), /outside the project/u);
});

test("resolves a configured link to the shared directory and rejects a link into the project", t => {
  const { root, project } = fixture(t);
  const real = path.join(root, "cargo-storage");
  const alias = path.join(root, "configured alias");
  const local = path.join(root, "local alias");
  fs.mkdirSync(real);
  fs.symlinkSync(real, alias, process.platform === "win32" ? "junction" : "dir");
  fs.symlinkSync(project, local, process.platform === "win32" ? "junction" : "dir");
  const choices = probe(path.join(alias, "cache"), path.join(real, "cache"));
  assert.equal(resolveCargoDeviceTarget({ projectRoot: project, run: choices.run }), path.join(real, "cache"));
  const override = probe(path.join(local, "cache"), path.join(real, "cache"));
  assert.throws(() => resolveCargoDeviceTarget({ projectRoot: project, run: override.run }), /outside the project/u);
});
