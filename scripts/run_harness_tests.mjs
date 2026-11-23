#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEARCH_ROOTS = [path.join(ROOT, "scripts"), path.join(ROOT, ".agents", "skills")];
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "release", "target"]);
const TEST_FILE = /\.test\.(?:mjs|cjs|js)$/u;
const TEST_SCOPE_USAGE = "请重复使用 --test <仓库相对测试文件>，或使用 --scope full --human-authorization <本次人工授权引用>。";

/** 递归发现 Node 原生测试文件，使用显式路径避免宿主 glob 差异。 */
export function discoverTests(roots = SEARCH_ROOTS) {
  const tests = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && TEST_FILE.test(entry.name)) tests.push(absolute);
    }
  };
  for (const root of roots) {
    if (fs.existsSync(root)) visit(root);
  }
  return tests.sort();
}

/** 按路径逐段检查，避免发现整个测试集、跟随符号链接或进入忽略目录。 */
function validateTestPath(relative) {
  const segments = relative.split("/");
  const absolute = path.join(ROOT, ...segments);
  if (/[*?\[\]{}:\\\0]|[!+@]\(/u.test(relative)
      || !TEST_FILE.test(relative)
      || segments.some((segment) => !segment || segment === "." || segment === ".." || IGNORED_DIRECTORIES.has(segment))
      || !SEARCH_ROOTS.some((root) => absolute.startsWith(root + path.sep))) {
    throw new Error(`无效的测试路径 ${JSON.stringify(relative)}。请传入 scripts/ 或 .agents/skills/ 中的精确相对文件路径。`);
  }

  let current = ROOT;
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    const entry = fs.lstatSync(current, { throwIfNoEntry: false });
    const matched = index === segments.length - 1 ? entry?.isFile() : entry?.isDirectory();
    if (!matched) throw new Error(`无效的测试路径 ${JSON.stringify(relative)}。所选路径必须指向普通测试文件。`);
  }
  return absolute;
}

/** 先确定本次范围，只有提供独立人工授权引用的全量请求才遍历测试目录。 */
function selectTests(args) {
  const { values } = parseArgs({
    args,
    options: {
      test: { type: "string", multiple: true },
      scope: { type: "string", multiple: true },
      "human-authorization": { type: "string", multiple: true },
    },
  });
  const tests = values.test ?? [];
  const scopes = values.scope ?? [];
  const authorizations = values["human-authorization"] ?? [];
  if (tests.length && scopes.length === 0 && authorizations.length === 0) {
    return [...new Set(tests.map(validateTestPath))];
  }
  if (tests.length === 0 && scopes.length === 1 && scopes[0] === "full"
      && authorizations.length === 1 && authorizations[0].trim()) {
    return discoverTests();
  }
  throw new Error(TEST_SCOPE_USAGE);
}

/** 只清理由此次运行创建、且仍可确认归属的测试临时根。 */
function removeTestScratch(directory, owner) {
  const current = fs.lstatSync(directory, { bigint: true, throwIfNoEntry: false });
  if (!current) return;
  if (!current.isDirectory() || current.dev !== owner.dev || current.ino !== owner.ino) {
    throw new Error("目录身份已改变");
  }
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 2 });
  if (fs.lstatSync(directory, { throwIfNoEntry: false })) throw new Error("删除后路径仍存在");
}

/** 按 Node 默认文件级并发运行 Harness 回归，并回收本次套件的系统临时目录。 */
export function main(args = process.argv.slice(2)) {
  let tests;
  try {
    tests = selectTests(args);
  } catch (error) {
    console.error(`ERROR: ${error.message}`);
    return 2;
  }
  if (tests.length === 0) {
    console.error("ERROR: 未发现任何 Node 回归测试");
    return 1;
  }
  let directory;
  let owner;
  let result;
  try {
    directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "harness-node-suite-"));
    owner = fs.lstatSync(directory, { bigint: true });
    const env = { ...process.env, TMPDIR: directory, TMP: directory, TEMP: directory };
    console.error(`Harness 回归临时目录 ${directory}`);
    result = spawnSync(process.execPath, ["--test", ...tests], {
      cwd: ROOT, stdio: "inherit", env, windowsHide: true,
    });
  } catch (error) {
    result = { error };
  }

  let status = result.status ?? 2;
  if (result.error) {
    console.error(`ERROR: 无法运行 Node 回归: ${result.error.message}`);
  }
  if (directory) {
    if (!owner || result.signal) {
      const reason = result.signal ? `测试进程因 ${result.signal} 退出，仍可能有子进程` : "目录归属未确认";
      console.error(`WARN: 保留测试临时目录 ${directory}（${reason}）`);
    } else {
      try {
        removeTestScratch(directory, owner);
      } catch (error) {
        console.error(`ERROR: 无法回收测试临时目录 ${directory}：${error.message}`);
        if (status === 0) status = 2;
      }
    }
  }
  return status;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exitCode = main();
}
