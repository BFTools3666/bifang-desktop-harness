import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/** 用真实子进程覆盖运行器退出后的清理，不构建任何 Rust 产物。 */
function runFixture(t, testBody) {
  const sandbox = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "harness-runner-test-"));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const temporary = path.join(sandbox, "temporary");
  const project = path.join(sandbox, "project");
  const scripts = path.join(project, "scripts");
  const sibling = path.join(temporary, "existing-fixture");
  const release = path.join(project, "release", "evidence");
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(temporary);
  fs.mkdirSync(path.dirname(release));
  fs.writeFileSync(sibling, "other task");
  fs.writeFileSync(release, "candidate evidence");
  const entry = path.join(scripts, "run_harness_tests.mjs");
  fs.copyFileSync(new URL("../run_harness_tests.mjs", import.meta.url), entry);
  fs.writeFileSync(path.join(scripts, "scratch.test.mjs"), `
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("fixture produces scratch and a visible result", () => {
  const scratch = os.tmpdir();
  assert.match(path.basename(scratch), /^harness-node-suite-/u);
  assert.equal(process.env.TMPDIR, scratch);
  assert.equal(process.env.TMP, scratch);
  assert.equal(process.env.TEMP, scratch);
  const generated = path.join(scratch, "generated");
  fs.mkdirSync(generated);
  fs.writeFileSync(path.join(generated, "fixture"), "task-owned scratch");
  ${testBody}
});
`);
  const env = { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [entry], {
    cwd: project,
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(fs.readFileSync(sibling, "utf8"), "other task");
  assert.equal(fs.readFileSync(release, "utf8"), "candidate evidence");
  return { result, temporary };
}

for (const shouldFail of [false, true]) {
  test(`suite reclaims fixture and generated scratch after ${shouldFail ? "test failure" : "success"}`, (t) => {
    const body = shouldFail ? 'assert.fail("intentional fixture failure");' : '';
    const { result, temporary } = runFixture(t, body);
    assert.equal(result.status, shouldFail ? 1 : 0, result.stdout + result.stderr);
    assert.match(result.stdout, /fixture produces scratch and a visible result/u);
    assert.deepEqual(fs.readdirSync(temporary), ["existing-fixture"]);
  });
}

test("suite preserves a replacement scratch path and reports that it could not clean it", (t) => {
  const { result, temporary } = runFixture(t, `
    fs.renameSync(scratch, scratch + "-relocated");
    fs.mkdirSync(scratch);
    fs.writeFileSync(path.join(scratch, "replacement"), "ownership unknown");
  `);
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /无法回收测试临时目录.*目录身份已改变/u);
  const relocated = fs.readdirSync(temporary).find((name) => name.endsWith("-relocated"));
  assert.ok(relocated);
  const replacement = relocated.slice(0, -"-relocated".length);
  assert.equal(fs.readFileSync(path.join(temporary, replacement, "replacement"), "utf8"), "ownership unknown");
});
