/** 外部增强 Skills 分类、适用性过滤、最新上游同步与安全门禁隔离回归测试。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sync_external_skills.mjs');

/** 在临时目录初始化本地 Git 仓库并提交文件，模拟上游 GitHub 仓库。 */
function createMockRepo(parent, name, files) {
  const repoDir = path.join(parent, name);
  fs.mkdirSync(repoDir, { recursive: true });
  const git = (...args) => {
    const res = spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout.trim();
  };
  git('init', '--initial-branch=main');
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(repoDir, ...relative.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'initial');
  return { repoDir, commit: git('rev-parse', 'HEAD'), git };
}

/** 构造带隔离上游仓库和项目根目录的测试夹具。 */
function setupFixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ext_skills_test_')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true });
  const repos = path.join(root, 'repos');
  fs.mkdirSync(repos, { recursive: true });
  const beautiful = createMockRepo(repos, 'BeautifulRust', {
    LICENSE: 'MIT License\n',
    'skills/rust-best-practices/SKILL.md': '---\nname: rust-best-practices\ndescription: best\n---\n# v1\n',
    'skills/rust-review/SKILL.md': '---\nname: rust-review\ndescription: review\n---\n# v1\n',
    'skills/rust-port/SKILL.md': '---\nname: rust-port\ndescription: port\n---\n# v1\n',
  });
  const taste = createMockRepo(repos, 'taste-skill', {
    LICENSE: 'MIT License\n',
    'skills/taste-skill/SKILL.md': '---\nname: design-taste-frontend\ndescription: taste\n---\n# taste v1\n',
    'skills/taste-skill/references/guide.md': '# guide\n',
  });
  const rustAnything = createMockRepo(repos, 'rust-anything', {
    LICENSE: 'MIT License\n',
    'skills/rust-anything/SKILL.md': '---\nname: rust-anything\ndescription: migrate\n---\n# rust-anything v1\n',
    'skills/rust-anything/whole-app.md': '# whole app\n',
  });
  const override = JSON.stringify({
    'beautiful-rust': beautiful.repoDir,
    'taste-skill': taste.repoDir,
    'rust-anything': rustAnything.repoDir,
  });
  return { root, project, beautiful, taste, rustAnything, override };
}

/** 运行同步脚本并解析 JSON 输出。 */
function runSync(args, { testMode = true, expectedStatus = 0 } = {}) {
  const env = { ...process.env };
  if (testMode) env.AFH_TEST_MODE = '1';
  else delete env.AFH_TEST_MODE;
  const res = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env });
  assert.equal(res.status, expectedStatus, res.stderr || res.stdout);
  return JSON.parse((res.stdout || res.stderr).trim());
}

test('纯 CLI 项目同步 Rust 与迁移外部 Skill，跳过图形设计 Skill 并保留延迟工具标记', (t) => {
  const { project, beautiful, rustAnything, override } = setupFixture(t);
  fs.writeFileSync(path.join(project, 'Cargo.toml'), '[workspace.metadata.agent-first-harness]\ninterfaces = ["cli"]\n', 'utf8');

  const out = runSync(['sync', '--project-root', project, '--source-override', override]);
  assert.equal(out.action, 'sync');
  const byId = Object.fromEntries(out.results.map(item => [item.id, item]));
  assert.equal(byId['beautiful-rust'].status, 'synced');
  assert.equal(byId['beautiful-rust'].commit, beautiful.commit);
  assert.equal(byId['deslop-please'].status, 'deferred-environment-tool');
  assert.equal(byId['taste-skill'].status, 'skipped-inapplicable');
  assert.equal(byId['rust-anything'].status, 'synced');
  assert.equal(byId['rust-anything'].commit, rustAnything.commit);

  assert.ok(fs.existsSync(path.join(project, '.agents/skills/rust-best-practices/SKILL.md')));
  assert.ok(fs.existsSync(path.join(project, '.agents/skills/rust-review/SKILL.md')));
  assert.ok(fs.existsSync(path.join(project, '.agents/skills/rust-port/SKILL.md')));
  assert.ok(fs.existsSync(path.join(project, '.agents/skills/rust-anything/SKILL.md')));
  assert.equal(fs.existsSync(path.join(project, '.agents/skills/design-taste-frontend')), false);

  const constraint = fs.readFileSync(path.join(project, '.agents/skills/rust-anything/HARNESS-CONSTRAINTS.md'), 'utf8');
  assert.match(constraint, /纯 Rust 实现/u);
  assert.match(constraint, /严禁.*包装兼容层/u);
  assert.ok(fs.existsSync(path.join(project, '.harness/external-skills-lock.json')));
});

test('GUI 项目同步全部外部 Skill，且上游推进提交后再次同步可更新至最新 commit', (t) => {
  const { project, taste, override } = setupFixture(t);
  const first = runSync(['sync', '--project-root', project, '--interfaces', 'gui', '--source-override', override]);
  assert.equal(first.results.find(item => item.id === 'taste-skill').commit, taste.commit);
  assert.match(fs.readFileSync(path.join(project, '.agents/skills/design-taste-frontend/SKILL.md'), 'utf8'), /# taste v1/u);
  assert.match(fs.readFileSync(path.join(project, '.agents/skills/design-taste-frontend/HARNESS-CONSTRAINTS.md'), 'utf8'), /ui_foundation\.md/u);

  fs.writeFileSync(path.join(taste.repoDir, 'skills/taste-skill/SKILL.md'), '---\nname: design-taste-frontend\ndescription: taste\n---\n# taste v2\n', 'utf8');
  taste.git('add', '.');
  taste.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'v2');
  const nextCommit = taste.git('rev-parse', 'HEAD');

  const second = runSync(['sync', '--project-root', project, '--interfaces', 'gui', '--source-override', override]);
  assert.equal(second.results.find(item => item.id === 'taste-skill').commit, nextCommit);
  assert.match(fs.readFileSync(path.join(project, '.agents/skills/design-taste-frontend/SKILL.md'), 'utf8'), /# taste v2/u);

  const inspected = runSync(['inspect', '--project-root', project, '--interfaces', 'gui']);
  assert.equal(inspected.lockPresent, true);
  assert.equal(inspected.items.find(item => item.id === 'taste-skill').lockedCommit, nextCommit);
});

test('非测试模式下拒绝 --source-override，且纯 TUI NSH 跳过图形设计 Skill', (t) => {
  const { project, override } = setupFixture(t);
  const err = runSync(['sync', '--project-root', project, '--interfaces', 'cli', '--source-override', override], { testMode: false, expectedStatus: 1 });
  assert.match(err.message, /AFH_TEST_MODE=1/u);

  const tuiInspect = runSync(['inspect', '--project-root', project, '--interfaces', 'nsh', '--nsh-targets', 'tui']);
  assert.equal(tuiInspect.items.find(item => item.id === 'taste-skill').applicable, false);
  const desktopInspect = runSync(['inspect', '--project-root', project, '--interfaces', 'nsh', '--nsh-targets', 'desktop']);
  assert.equal(desktopInspect.items.find(item => item.id === 'taste-skill').applicable, true);
});
