#!/usr/bin/env node
/** 候选构建只执行绑定上一同渠道发布差异的明确测试选择器。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveAcceptanceScope } from './acceptance_scope.mjs';
import { readDependencyLockPolicy } from '../../desktop-implement-change/scripts/project_lock_policy.mjs';
import { runGit, validateContext } from '../../desktop-prepare-release/scripts/release_context.mjs';

const text = value => typeof value === 'string' && value.trim().length > 0;

/** 文件选择器不能变成目录发现、glob 或命令选项，也不能越过项目根。 */
function relativeFile(root, value, suffix) {
  if (!text(value) || /[*?\[\]{}:\\\0]/u.test(value) || value.startsWith('-') ||
      value.split('/').some(part => !part || part === '.' || part === '..') || !suffix.test(value)) {
    throw new Error('expected an exact regression test file selector');
  }
  let current = root;
  for (const [index, part] of value.split('/').entries()) {
    current = path.join(current, part);
    const entry = fs.lstatSync(current, {throwIfNoEntry: false});
    if (entry?.isSymbolicLink() || !(index === value.split('/').length - 1 ? entry?.isFile() : entry?.isDirectory())) {
      throw new Error('regression selector must name an ordinary file');
    }
  }
  return current;
}

/** 计划必须逐项说明变化的测试归属或无需执行测试的原因，拒绝陈旧基线。 */
export function validateRegressionPlan(root, plan, resolved) {
  if (plan?.schemaVersion !== 1 || !isDeepStrictEqual(plan.scope, resolved.acceptanceScope) ||
      !Array.isArray(plan.tests) || !Array.isArray(plan.excludedChanges)) {
    throw new Error('regression plan must match the current release delta');
  }
  if (plan.scope.kind === 'first-release' && !text(plan.initialScopeAuthorization)) {
    throw new Error('first release requires an approved initial regression scope');
  }
  const changes = new Set(resolved.changedPaths);
  const covered = new Set();
  for (const entry of [...plan.tests, ...plan.excludedChanges]) {
    if (!text(entry.reason) || !Array.isArray(entry.changes) || !entry.changes.length ||
        entry.changes.some(file => !changes.has(file))) throw new Error('regression coverage requires changed paths and a reason');
    entry.changes.forEach(file => covered.add(file));
  }
  if ([...changes].some(file => !covered.has(file))) throw new Error('regression plan leaves changed paths unexplained');
  if (!plan.tests.length && !text(plan.noTestsReason)) throw new Error('empty regression selection requires a no-tests reason');
  if (!plan.tests.length && resolved.changedPaths.some(file => /\.(?:rs|[cm]?[jt]sx?|css|html|sql|c|cpp|h)$/u.test(file))) {
    throw new Error('changed executable source requires nonempty regression tests');
  }
  for (const entry of plan.tests) regressionCommand(root, entry);
  return plan;
}

/** 本地试包也绑定上一发布及当前工作树字节，不接受调用方自报的变化集合。 */
export function resolveDevelopmentRegressionScope(projectRoot) {
  const root = fs.realpathSync(projectRoot);
  if (fs.realpathSync(runGit(root, ['rev-parse', '--show-toplevel']).stdout.trim()) !== root) {
    throw new Error('development regression requires an independent Git root');
  }
  const sourceCommit = runGit(root, ['rev-parse', 'HEAD']).stdout.trim();
  let baseline = null;
  const contextFile = path.join(root, '.harness/release-context.json');
  if (fs.existsSync(contextFile)) {
    if (!fs.lstatSync(contextFile).isFile()) throw new Error('development release context must be an ordinary file');
    const bytes = fs.readFileSync(contextFile);
    const context = validateContext(JSON.parse(bytes));
    const commit = runGit(root, ['rev-parse', '--verify', `refs/tags/${context.expectedTag}^{commit}`]).stdout.trim();
    runGit(root, ['merge-base', '--is-ancestor', commit, sourceCommit]);
    if (!runGit(root, ['show', `${commit}:.harness/release-context.json`], {text: false}).stdout.equals(bytes)) {
      throw new Error('development baseline must use the verified previous release context');
    }
    baseline = {tag: context.expectedTag, commit, version: context.version};
  }
  const base = baseline?.commit ?? runGit(root, ['hash-object', '-t', 'tree', '--stdin']).stdout.trim();
  const flags = ['--no-renames', '--no-ext-diff', '--no-textconv', '--no-relative', '--ignore-submodules=none'];
  const diff = runGit(root, ['diff', '--binary', ...flags, base, '--'], {text: false}).stdout;
  const changed = runGit(root, ['diff', '--name-only', '-z', ...flags, base, '--'], {text: false}).stdout.toString('utf8').split('\0').filter(Boolean);
  const untracked = runGit(root, ['ls-files', '--others', '--exclude-standard', '-z'], {text: false}).stdout.toString('utf8').split('\0').filter(Boolean).sort();
  const hash = createHash('sha256').update(diff);
  for (const file of untracked) {
    const absolute = path.join(root, file);
    const entry = fs.lstatSync(absolute);
    hash.update(JSON.stringify([file, entry.mode, entry.isSymbolicLink() ? fs.readlinkSync(absolute)
      : createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')]));
  }
  return {acceptanceScope: {kind: 'development', sourceCommit, baseline, diffSha256: hash.digest('hex')},
    changedPaths: [...new Set([...changed, ...untracked])].sort()};
}

/** 固定参数由类型化选择器生成；没有自由命令或无筛选的 workspace 回退。 */
export function regressionCommand(root, entry) {
  const filter = entry.filter;
  if (filter !== undefined && (!text(filter) || filter.startsWith('-') || /[*?\[\]{}\0]/u.test(filter))) {
    throw new Error('invalid regression case filter');
  }
  if (entry.runner === 'cargo') {
    relativeFile(root, entry.manifest, /(?:^|\/)Cargo\.toml$/u);
    if (!text(entry.package) || !/^[A-Za-z0-9_-]+$/u.test(entry.package) || !text(filter) ||
        !/^(?:lib|(?:test|bin):[A-Za-z0-9_-]+)$/u.test(entry.target)) {
      throw new Error('cargo regression requires package, target and nonempty case filter');
    }
    const [kind, name] = entry.target.split(':');
    return {command: 'cargo', cwd: root, args: ['test', '--manifest-path', entry.manifest, '-p', entry.package,
      ...(kind === 'lib' ? ['--lib'] : ['--' + kind, name]), '--all-features', '--target', 'host-tuple',
      ...(readDependencyLockPolicy(root) === 'tracked' ? ['--locked'] : []), filter]};
  }
  if (entry.runner === 'nsh') {
    const file = relativeFile(root, entry.file, /\.test\.tsx?$/u);
    let cwd = path.dirname(file);
    while (!fs.existsSync(path.join(cwd, 'nsh.json')) && cwd !== root) cwd = path.dirname(cwd);
    relativeFile(root, path.relative(root, path.join(cwd, 'nsh.json')).split(path.sep).join('/'), /(?:^|\/)nsh\.json$/u);
    // NSH 0.7.1 只为目录路径发现 Rust crates；精确测试文件避免隐式 cargo 全量。
    return {command: 'nsh', cwd, args: ['test', file, ...(filter ? ['--filter', filter] : [])]};
  }
  if (entry.runner === 'frontend') {
    const manifest = relativeFile(root, entry.manifest, /(?:^|\/)package\.json$/u);
    const directory = path.dirname(manifest);
    const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    if (!pkg.devDependencies?.vitest || !Array.isArray(entry.files) || !entry.files.length) {
      throw new Error('frontend regression requires declared local Vitest and exact test files');
    }
    for (const file of entry.files) relativeFile(directory, file, /\.(?:test|spec)\.[cm]?[jt]sx?$/u);
    const cli = path.join(directory, 'node_modules', 'vitest', 'vitest.mjs');
    if (!fs.statSync(cli, {throwIfNoEntry: false})?.isFile()) throw new Error('declared project-local Vitest is not installed');
    return {command: process.execPath, cwd: directory, args: [cli, 'run', ...entry.files,
      ...(filter ? ['--testNamePattern', filter] : [])]};
  }
  throw new Error('unsupported regression test runner');
}

/** 从报告的实际通过数量认定非空执行，零命中不升级成全量重跑。 */
export function regressionPassedCases(runner, output) {
  const pattern = runner === 'cargo' ? /test result: ok\. (\d+) passed/gu : /Tests\s+(\d+) passed/gu;
  const passed = [...output.replace(/\x1b\[[0-9;]*m/gu, '').matchAll(pattern)]
    .reduce((sum, match) => sum + Number(match[1]), 0);
  if (!passed) throw new Error('regression selector matched zero passing tests; refusing full-suite fallback');
  return passed;
}

/** Vitest 的路径参数是包含匹配，预列出文件并拒绝扩展到未选择的文件。 */
export function verifyFrontendFiles(cwd, selected, output) {
  const report = JSON.parse(output);
  const listed = Array.isArray(report) ? report.map(entry => typeof entry === 'string' ? entry : entry?.file) : [];
  if (!listed.length || listed.some(file => typeof file !== 'string') ||
      !isDeepStrictEqual([...new Set(listed.map(file => path.resolve(cwd, file)))].sort(),
        [...new Set(selected.map(file => path.resolve(cwd, file)))].sort())) {
    throw new Error('frontend regression selectors matched zero or additional test files');
  }
}

/** NSH 官方报告以实际 TSX 测试为准，排除 todo、skip 和只有 Rust 的报告。 */
export function nshPassedCases(report) {
  if (!report.trimEnd().endsWith('</testsuites>') || !/<testsuites name="nsh test"/u.test(report) ||
      /(?:failures|errors)="[1-9]\d*"/u.test(report)) throw new Error('NSH regression tests failed or report is incomplete');
  const passed = [...report.matchAll(/<testsuite name="[^"]+\.test\.tsx?" tests="(\d+)" failures="0" errors="0" skipped="(\d+)"/gu)]
    .reduce((sum, match) => sum + Number(match[1]) - Number(match[2]), 0);
  if (passed <= 0) throw new Error('regression selector matched zero passing NSH tests');
  return passed;
}

/** 在任何测试进程前读取并复核计划；本地试包也必须显式指定受影响用例。 */
export function loadRegressionPlan(root, file, {local = false} = {}) {
  if (!text(file)) throw new Error('explicit --regression-plan is required; unfiltered regression is forbidden');
  const absolute = path.resolve(root, file);
  if (!fs.lstatSync(absolute).isFile()) throw new Error('regression plan must be an ordinary file');
  const plan = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  const resolved = local ? resolveDevelopmentRegressionScope(root) : resolveAcceptanceScope(root);
  validateRegressionPlan(root, plan, resolved);
  return plan;
}

/** 逐一运行精确选择器并保存计划与执行证据，任何失败或零命中立即停止。 */
export function runRegressionPlan(root, plan, {env = process.env, directory, run = runCommand} = {}) {
  const results = [];
  for (const [index, entry] of plan.tests.entries()) {
    const invocation = regressionCommand(root, entry);
    const {command, cwd} = invocation;
    const args = [...invocation.args];
    const report = path.join(directory, `nsh-tests-${index}.xml`);
    if (entry.runner === 'nsh') args.push('--junit', report);
    if (entry.runner === 'cargo') {
      const list = run(command, [...args, '--', '--list'], cwd, env, true);
      if (!/^.+: test$/mu.test(list)) throw new Error('regression selector matched zero tests');
    }
    if (entry.runner === 'frontend') {
      const listed = run(command, [args[0], 'list', ...entry.files, '--filesOnly', '--json'], cwd, env, true);
      verifyFrontendFiles(cwd, entry.files, listed);
    }
    const output = run(command, args, cwd, env, true) ?? '';
    const testCases = entry.runner === 'nsh' ? nshPassedCases(fs.readFileSync(report, 'utf8'))
      : regressionPassedCases(entry.runner, output);
    results.push({runner: entry.runner, selection: entry, command, args, testCases, status: 'passed'});
  }
  const bytes = JSON.stringify(plan, null, 2) + '\n';
  fs.writeFileSync(path.join(directory, 'regression-plan.json'), bytes, {flag: 'wx'});
  const result = {status: results.length ? 'passed' : 'not-applicable', scope: plan.scope,
    planSha256: createHash('sha256').update(bytes).digest('hex'),
    testCases: results.reduce((sum, entry) => sum + entry.testCases, 0), results,
    ...(results.length ? {} : {reason: plan.noTestsReason})};
  fs.writeFileSync(path.join(directory, 'regression-results.json'), JSON.stringify(result, null, 2) + '\n', {flag: 'wx'});
  return result;
}

/** 候选复用测试证据前，重新绑定范围、计划字节和实际记录。 */
export function verifyRegressionEvidence(root, plan, result) {
  validateRegressionPlan(root, plan, resolveAcceptanceScope(root));
  verifyRegressionResult(plan, result);
}

/** 执行记录与计划按字节和选择器逐项相符，供本地和已核验渠道的 CI 共用。 */
export function verifyRegressionResult(plan, result) {
  const bytes = JSON.stringify(plan, null, 2) + '\n';
  if (!isDeepStrictEqual(result?.scope, plan.scope) ||
      result.planSha256 !== createHash('sha256').update(bytes).digest('hex') ||
      result.results?.length !== plan.tests.length || result.results.some((entry, index) =>
        entry.status !== 'passed' || !Number.isSafeInteger(entry.testCases) || entry.testCases <= 0 ||
        !isDeepStrictEqual(entry.selection, plan.tests[index])) ||
      result.testCases !== result.results.reduce((sum, entry) => sum + entry.testCases, 0) ||
      (plan.tests.length ? result.status !== 'passed' : result.status !== 'not-applicable' || result.reason !== plan.noTestsReason)) {
    throw new Error('candidate regression evidence no longer matches the release plan');
  }
}

/** 共享执行器不经 shell，沿用宿主全局工具和项目声明的依赖。 */
function runCommand(command, args, cwd, env) {
  const result = spawnSync(command, args, {cwd, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024});
  if (result.stdout) process.stderr.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`regression command failed: ${command} (${result.status ?? result.error?.code})`);
  return result.stdout + result.stderr;
}

/** resolve 仅生成真实差异；run 不允许常驻策略或打包请求隐式触发全量。 */
export function main(argv) {
  const [command, ...args] = argv;
  const {values} = parseArgs({args, options: {'project-root': {type: 'string', default: '.'}, plan: {type: 'string'},
    'evidence-directory': {type: 'string'}, local: {type: 'boolean'}}});
  const root = fs.realpathSync(values['project-root']);
  if (command === 'resolve') return values.local ? resolveDevelopmentRegressionScope(root) : resolveAcceptanceScope(root);
  if (!['verify', 'run'].includes(command)) throw new Error('expected regression_scope.mjs resolve|verify|run');
  const plan = loadRegressionPlan(root, values.plan, {local: values.local});
  if (command === 'verify') return {status: 'verified', scope: plan.scope, tests: plan.tests.length};
  const temporary = values['evidence-directory'] ? null : fs.mkdtempSync(path.join(os.tmpdir(), 'harness-regression-'));
  try { return runRegressionPlan(root, plan, {directory: temporary ?? path.resolve(values['evidence-directory'])}); }
  finally { if (temporary) fs.rmSync(temporary, {recursive: true}); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(JSON.stringify(main(process.argv.slice(2))) + '\n'); }
  catch (error) { process.stderr.write(`Regression scope: ${error.message}\n`); process.exitCode = 1; }
}
