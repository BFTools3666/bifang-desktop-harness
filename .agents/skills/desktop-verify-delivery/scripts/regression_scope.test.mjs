/** 差异绑定、定向命令和零命中失败关闭的回归。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { canonicalBytes } from '../../desktop-prepare-release/scripts/release_context.mjs';
import { resolveAcceptanceScope } from './acceptance_scope.mjs';
import { loadRegressionPlan, nshPassedCases, regressionCommand, regressionPassedCases,
  runRegressionPlan, validateRegressionPlan, verifyFrontendFiles, verifyRegressionEvidence,
  resolveDevelopmentRegressionScope } from './regression_scope.mjs';

/** 隔离的真实 Git 发布历史含已发布且未变化的旧功能。 */
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'regression-scope-')));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const write = (file, bytes) => {fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true}); fs.writeFileSync(path.join(root, file), bytes);};
  const git = (...args) => {
    const result = spawnSync('git', ['-C', root, ...args], {encoding: 'utf8'});
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '--quiet', '--initial-branch=main');
  for (const [key, value] of [['user.name', 'Regression Test'], ['user.email', 'regression@example.test'],
    ['commit.gpgsign', 'false'], ['core.hooksPath', path.join(root, '.git', 'empty-hooks')]]) git('config', '--local', key, value);
  write('.gitignore', '/release/\n');
  write('Cargo.toml', '[package]\nname="sample"\nversion="1.0.0"\n');
  write('app/changed.test.tsx', 'test source');
  write('app/nsh.json', '{}');
  write('old-feature.txt', 'unchanged');
  const commit = () => {git('add', '.'); git('commit', '--quiet', '-m', 'fixture'); return git('rev-parse', 'HEAD');};
  commit();
  const releases = [];
  const release = (version, channel) => {
    const sourceHead = git('rev-parse', 'HEAD');
    const tag = `v${version}-20261124`;
    releases.unshift({releaseDate: '2026-11-24', version: `v${version}`,
      featureOptimizations: [{'zh-CN': '变化', 'en-US': 'Changed behavior'}], bugFixes: []});
    write('release-notes.json', JSON.stringify({schemaVersion: 2, releases}));
    write('.harness/release-context.json', canonicalBytes({schemaVersion: 4, sourceHead, version,
      releaseDate: '2026-11-24', expectedTag: tag, defaultBranch: 'main', releaseChannel: channel,
      releaseReview: {selection: 'disabled', status: 'Not run', scopeBase: sourceHead, sourceHead,
        scopeDiffSha256: '0'.repeat(64), reviewedSourceCommit: null, checks: [], evidenceSummary: null,
        reason: 'Fixture scope.', remainingRisk: 'Synthetic test history.'}}));
    commit(); git('tag', tag);
    return tag;
  };
  return {root, write, commit, release};
}

/** 根据真实变化映射明确用例，记录无需测试的发布元数据。 */
function planFor(resolved) {
  return {schemaVersion: 1, scope: resolved.acceptanceScope,
    tests: [{runner: 'nsh', file: 'app/changed.test.tsx', changes: ['new-feature.txt'], reason: 'Changed behavior.'}],
    excludedChanges: resolved.changedPaths.filter(file => file !== 'new-feature.txt')
      .map(file => ({changes: [file], reason: 'Release metadata only.'}))};
}

/** 构建回归绑定最近同渠道标签，不能把未改变的旧功能加入本轮变化。 */
test('candidate_plan_uses_previous_same_channel_release_and_rejects_stale_scope', t => {
  const item = fixture(t);
  const previous = item.release('1.0.0', 'release');
  item.write('new-feature.txt', 'new'); item.commit();
  item.release('1.1.0', 'beta');
  item.release('1.1.1', 'release');
  const resolved = resolveAcceptanceScope(item.root);
  assert.equal(resolved.acceptanceScope.baseline.tag, previous);
  assert.equal(resolved.changedPaths.includes('old-feature.txt'), false);
  const plan = planFor(resolved);
  const file = path.join(item.root, 'release', 'plan.json');
  fs.mkdirSync(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(plan));
  assert.deepEqual(loadRegressionPlan(item.root, file), plan);
  const output = path.join(item.root, 'release', 'evidence'); fs.mkdirSync(output);
  const result = runRegressionPlan(item.root, {...plan, tests: [],
    noTestsReason: 'Fixture checks metadata.',
    excludedChanges: resolved.changedPaths.map(file => ({changes: [file], reason: 'Fixture metadata.'}))}, {directory: output});
  const noTestsPlan = JSON.parse(fs.readFileSync(path.join(output, 'regression-plan.json'), 'utf8'));
  verifyRegressionEvidence(item.root, noTestsPlan, result);
  assert.throws(() => verifyRegressionEvidence(item.root, noTestsPlan, {...result, planSha256: '0'.repeat(64)}), /no longer matches/u);
  plan.scope.diffSha256 = 'f'.repeat(64);
  fs.writeFileSync(file, JSON.stringify(plan));
  assert.throws(() => loadRegressionPlan(item.root, file), /current release delta/u);
});

/** 前端先确认精确文件集合，路径包含匹配不能偷偷扩展回归范围。 */
test('frontend_list_guard_rejects_ambiguous_paths_before_running_tests', t => {
  const {root, write} = fixture(t);
  write('web/package.json', JSON.stringify({devDependencies: {vitest: '^4.0.7'}}));
  write('web/src/Changed.test.tsx', 'test source');
  write('web/node_modules/vitest/vitest.mjs', '// CLI fixture, not a runtime verification.');
  const entry = {runner: 'frontend', manifest: 'web/package.json', files: ['src/Changed.test.tsx']};
  const directory = path.join(root, 'release'); fs.mkdirSync(directory);
  const calls = [];
  assert.throws(() => runRegressionPlan(root, {tests: [entry]}, {directory, run: (command, args) => {
    calls.push(args);
    assert.equal(command, process.execPath);
    return JSON.stringify([{file: path.join(root, 'web/src/Changed.test.tsx')}, {file: path.join(root, 'web/unrelated.test.tsx')}]);
  }}), /additional test files/u);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], 'list');
  verifyFrontendFiles(path.join(root, 'web'), entry.files, JSON.stringify([{file: 'src/Changed.test.tsx'}]));
  assert.throws(() => verifyFrontendFiles(root, entry.files, '[]'), /zero/u);
});

/** 本地试包从真实上一标签比较工作树，不能通过空计划掩盖未提交源码。 */
test('local_plan_binds_previous_release_and_uncommitted_source_bytes', t => {
  const item = fixture(t);
  const previous = item.release('1.0.0', 'release');
  item.write('new-feature.txt', 'local changes');
  item.write('app/changed.test.tsx', 'changed test source');
  const resolved = resolveDevelopmentRegressionScope(item.root);
  assert.equal(resolved.acceptanceScope.baseline.tag, previous);
  assert.ok(resolved.changedPaths.includes('app/changed.test.tsx'));
  const plan = planFor(resolved);
  const file = path.join(item.root, 'release', 'local-plan.json'); fs.mkdirSync(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(plan));
  assert.deepEqual(loadRegressionPlan(item.root, file, {local: true}), plan);
  assert.throws(() => validateRegressionPlan(item.root, {...plan, tests: [], noTestsReason: 'Skip code',
    excludedChanges: resolved.changedPaths.map(file => ({changes: [file], reason: 'Skipped.'}))}, resolved), /executable source/u);
  item.write('app/changed.test.tsx', 'different bytes after plan');
  assert.throws(() => loadRegressionPlan(item.root, file, {local: true}), /current release delta/u);
});

/** 未指定计划、遗漏变化和目录选择器均在测试启动前拒绝。 */
test('missing_plan_unexplained_changes_and_directory_selectors_fail_closed', t => {
  const {root, release, write, commit} = fixture(t);
  release('1.0.0', 'release'); write('new-feature.txt', 'new'); commit(); release('1.0.1', 'release');
  assert.throws(() => loadRegressionPlan(root), /regression-plan/u);
  const resolved = resolveAcceptanceScope(root);
  const plan = planFor(resolved);
  assert.throws(() => validateRegressionPlan(root, {...plan, excludedChanges: []}, resolved), /unexplained/u);
  for (const file of ['.', 'app', 'app/*.test.tsx', '../outside.test.tsx']) {
    assert.throws(() => regressionCommand(root, {...plan.tests[0], file}), /selector|ordinary/u);
  }
  assert.throws(() => regressionCommand(root, {runner: 'cargo', manifest: 'Cargo.toml', package: 'sample', target: 'lib'}), /case filter/u);
});

/** NSH 使用精确测试文件，绕过官方目录模式附带的全量 Rust 测试。 */
test('commands_are_scoped_and_zero_matches_never_retry_a_full_suite', t => {
  const {root} = fixture(t);
  const entry = {runner: 'cargo', manifest: 'Cargo.toml', package: 'sample', target: 'lib', filter: 'changed_case'};
  const invocation = regressionCommand(root, entry);
  assert.ok(invocation.args.includes('changed_case'));
  assert.equal(invocation.args.includes('--workspace'), false);
  const calls = [];
  const directory = path.join(root, 'release'); fs.mkdirSync(directory);
  assert.throws(() => runRegressionPlan(root, {tests: [entry]}, {directory,
    run: (...args) => {calls.push(args); return '0 tests';}}), /zero tests/u);
  assert.equal(calls.length, 1);
  const nsh = regressionCommand(root, {runner: 'nsh', file: 'app/changed.test.tsx'});
  assert.deepEqual(nsh.args, ['test', path.join(root, 'app/changed.test.tsx')]);
  assert.throws(() => regressionPassedCases('cargo', 'test result: ok. 0 passed; 0 failed; 12 filtered out'), /zero/u);
});

/** 实际通过数量写入证据，不能把 skip、todo 或只有 Rust 的 JUnit 当作渲染通过。 */
test('selected_nsh_cases_are_recorded_and_empty_reports_are_rejected', t => {
  const {root} = fixture(t);
  const directory = path.join(root, 'release'); fs.mkdirSync(directory);
  const report = '<testsuites name="nsh test" tests="2" failures="0" errors="0" skipped="1" time="0">' +
    '<testsuite name="app/changed.test.tsx" tests="2" failures="0" errors="0" skipped="1"></testsuite></testsuites>';
  const plan = {scope: {kind: 'release-delta'}, tests: [{runner: 'nsh', file: 'app/changed.test.tsx'}]};
  const result = runRegressionPlan(root, plan, {directory, run: (command, args) => {
    assert.equal(command, 'nsh');
    fs.writeFileSync(args[args.indexOf('--junit') + 1], report); return '';
  }});
  assert.equal(result.testCases, 1);
  assert.equal(result.status, 'passed');
  assert.ok(fs.existsSync(path.join(directory, 'regression-plan.json')));
  assert.throws(() => nshPassedCases(report.replace('skipped="1"></testsuite>', 'skipped="2"></testsuite>')), /zero/u);
  assert.throws(() => nshPassedCases(report.replace('failures="0"', 'failures="1"')), /failed/u);
});
