#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEARCH_ROOTS = [path.join(ROOT, "scripts"), path.join(ROOT, ".agents", "skills")];
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "release", "target"]);

/** 递归发现 Node 原生测试文件，使用显式路径避免宿主 glob 差异。 */
export function discoverTests(roots = SEARCH_ROOTS) {
  const tests = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && /\.test\.(?:mjs|cjs|js)$/u.test(entry.name)) tests.push(absolute);
    }
  };
  for (const root of roots) {
    if (fs.existsSync(root)) visit(root);
  }
  return tests.sort();
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
export function main() {
  const tests = discoverTests();
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
