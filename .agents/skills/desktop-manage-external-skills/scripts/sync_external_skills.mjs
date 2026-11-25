#!/usr/bin/env node
/** 按分类与项目接口将外部增强 Skills 同步至最新上游，并写入受保护来源锁与 Harness 约束旁注。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const CATALOG_PATH = path.resolve(SCRIPT_DIR, '..', 'references', 'external-skills-catalog.json');
export const LOCK_RELATIVE = '.harness/external-skills-lock.json';
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const VALID_INTERFACES = new Set(['cli', 'mcp', 'gui', 'nsh']);
const GRAPHICAL_NSH_TARGETS = new Set(['desktop', 'mobile', 'web']);
const VALID_NSH_TARGETS = new Set(['desktop', 'mobile', 'web', 'tui']);

/** 计算缓冲区 SHA-256 摘要，用于记录外部 Skill 文件清单指纹。 */
function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 仅在路径确实缺失时返回 null，避免掩盖权限或 I/O 故障。 */
function lstatOrNull(target) {
  try { return fs.lstatSync(target); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** 逐级拒绝符号链接和非目录祖先，防止同步越界写入。 */
function assertOrdinaryPath(raw, allowMissing = false) {
  const absolute = path.resolve(raw);
  const root = path.parse(absolute).root;
  let current = root;
  for (const segment of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = lstatOrNull(current);
    if (!stat) {
      if (allowMissing) return absolute;
      throw new Error(`路径不存在：${current}`);
    }
    if (stat.isSymbolicLink() || (current !== absolute && !stat.isDirectory())) {
      throw new Error(`路径包含符号链接或非目录祖先：${current}`);
    }
  }
  return absolute;
}

/** 校验单段安全相对路径，拒绝越界、反斜杠与控制字符。 */
function assertSafeRelative(relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes(':')
      || /[\x00-\x1f\x7f]/u.test(relative) || path.isAbsolute(relative)
      || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`非法相对路径：${String(relative)}`);
  }
  return relative;
}

/** 读取并校验唯一外部 Skill 分类目录清单。 */
export function loadExternalSkillsCatalog(catalogPath = CATALOG_PATH) {
  const raw = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  if (!raw || raw.schemaVersion !== 1 || !Array.isArray(raw.categories) || !Array.isArray(raw.entries)) {
    throw new Error('外部 Skills 目录清单结构非法');
  }
  const categories = new Set(raw.categories.map(item => item.id));
  for (const entry of raw.entries) {
    if (!entry.id || !categories.has(entry.category) || !['skill-repo', 'cli-tool'].includes(entry.kind)) {
      throw new Error(`外部 Skills 清单条目非法：${entry?.id ?? '<unknown>'}`);
    }
    if (!['all', 'graphical-ui'].includes(entry.applicability)) {
      throw new Error(`外部 Skills 适用范围非法：${entry.id}`);
    }
    for (const skill of entry.skills ?? []) {
      assertSafeRelative(skill.installName);
      assertSafeRelative(skill.sourceSubpath);
      if (skill.installName.includes('/')) throw new Error(`Skill 安装名必须为单段目录：${skill.installName}`);
    }
  }
  return raw;
}

/** 解析逗号分隔的接口或 NSH 目标参数，并归一化为小写去重列表。 */
function parseCsvList(raw, allowed, label) {
  if (!raw) return [];
  const items = [...new Set(raw.split(',').map(item => item.trim().toLowerCase()).filter(Boolean))];
  for (const item of items) {
    if (!allowed.has(item)) throw new Error(`未知${label}：${item}`);
  }
  return items;
}

/** 从根 Cargo.toml 的 Harness 元数据区块提取数组字段，保持脚本完全自包含。 */
function parseCargoMetadataList(cargoText, key) {
  const lines = cargoText.split(/\r?\n/u);
  let inSection = false;
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/u, '').trim();
    if (!line) continue;
    if (line.startsWith('[')) {
      inSection = line === '[workspace.metadata.agent-first-harness]';
      continue;
    }
    if (!inSection) continue;
    const match = new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]$`, 'u').exec(line);
    if (!match) continue;
    const inner = match[1].trim();
    if (!inner) return [];
    return inner.split(',').map(part => part.trim()).filter(Boolean).map(token => {
      const quoted = /^"([^"]+)"$/u.exec(token);
      if (!quoted) throw new Error(`Cargo 元数据 ${key} 包含非法字符串：${token}`);
      return quoted[1].toLowerCase();
    });
  }
  return null;
}

/** 解析当前项目接口与 NSH 目标，优先使用显式参数，其次读取根 Cargo.toml。 */
export function resolveProjectSelection(projectRoot, { interfacesRaw = '', nshTargetsRaw = '' } = {}) {
  if (interfacesRaw) {
    const interfaces = parseCsvList(interfacesRaw, VALID_INTERFACES, '接口');
    const nshTargets = parseCsvList(nshTargetsRaw, VALID_NSH_TARGETS, 'NSH 目标');
    return { interfaces, nshTargets, source: 'cli-arguments' };
  }
  const cargoPath = path.join(projectRoot, 'Cargo.toml');
  if (!lstatOrNull(cargoPath)) {
    return { interfaces: [], nshTargets: [], source: 'missing-cargo' };
  }
  const text = fs.readFileSync(cargoPath, 'utf8');
  const interfaces = parseCargoMetadataList(text, 'interfaces') ?? [];
  const nshTargets = parseCargoMetadataList(text, 'nsh-targets') ?? [];
  for (const item of interfaces) if (!VALID_INTERFACES.has(item)) throw new Error(`Cargo 未知接口：${item}`);
  for (const item of nshTargets) if (!VALID_NSH_TARGETS.has(item)) throw new Error(`Cargo 未知 NSH 目标：${item}`);
  return { interfaces, nshTargets, source: 'cargo-metadata' };
}

/** 判定外部能力条目是否适用于当前项目的接口与图形目标组合。 */
export function isEntryApplicable(entry, selection) {
  if (entry.applicability === 'all') return true;
  if (entry.applicability === 'graphical-ui') {
    if (selection.interfaces.includes('gui')) return true;
    return selection.interfaces.includes('nsh')
      && selection.nshTargets.some(target => GRAPHICAL_NSH_TARGETS.has(target));
  }
  return false;
}

/** 生成与上游 SKILL.md 并列的 Harness 叠加约束旁注，避免篡改上游原文。 */
function renderConstraintsNote(entry, skill, commit) {
  const lines = [
    `# Harness 叠加约束（${entry.name} / ${skill.installName}）`,
    '',
    `- 上游仓库：${entry.homepage}`,
    `- 同步提交：\`${commit}\``,
    `- 归类：\`${entry.category}\``,
    '- 说明：同目录 `SKILL.md` 保持上游原字节；本文件记录当前 Harness 项目必须遵守的叠加约束，与上游默认流程冲突时以本约束及项目 `docs/ENGINEERING_RULES.md` 为准。',
    '',
    '## 必须遵守的约束',
    '',
    ...(entry.constraints ?? []).map((rule, index) => `${index + 1}. ${rule}`),
    '',
  ];
  return `${lines.join('\n')}`;
}

/** 运行非交互 Git 子进程并返回输出；失败时抛出包含诊断的错误。 */
function runGit(args, cwd = undefined) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
  });
  if (result.error) throw new Error(`执行 git 失败：${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().slice(-600);
    throw new Error(`git ${args[0]} 失败（退出码 ${result.status}）：${detail}`);
  }
  return result.stdout.trim();
}

/** 递归收集上游 Skill 子目录中的普通文件，拒绝符号链接、特殊文件与超大文件。 */
function collectRegularTree(rootDir, baseRelative = '') {
  const files = new Map();
  const walk = (currentDir, prefix) => {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const fullPath = path.join(currentDir, entry.name);
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      assertSafeRelative(rel);
      const stat = fs.lstatSync(fullPath);
      if (stat.isSymbolicLink()) throw new Error(`上游 Skill 含禁止的符号链接：${rel}`);
      if (stat.isDirectory()) {
        walk(fullPath, rel);
      } else if (stat.isFile()) {
        if (stat.size > MAX_FILE_BYTES) throw new Error(`上游文件超出大小上限（16 MiB）：${rel}`);
        const bytes = fs.readFileSync(fullPath);
        files.set(rel, { bytes, mode: stat.mode & 0o755, sha256: sha256(bytes) });
      } else {
        throw new Error(`上游 Skill 含非法特殊文件：${rel}`);
      }
    }
  };
  walk(rootDir, baseRelative);
  return files;
}

/** 将收集好的文件集安全写入暂存目录并原子替换目标 Skill 目录，出错时回滚旧目录。 */
function installSkillAtomically(skillsRoot, installName, files) {
  fs.mkdirSync(skillsRoot, { recursive: true });
  assertOrdinaryPath(skillsRoot);
  const destination = path.join(skillsRoot, installName);
  const existing = lstatOrNull(destination);
  if (existing && (existing.isSymbolicLink() || !existing.isDirectory())) {
    throw new Error(`目标 Skill 路径不是普通目录：${destination}`);
  }
  const suffix = randomBytes(6).toString('hex');
  const staging = path.join(skillsRoot, `.sync-staging-${installName}-${suffix}`);
  const backup = path.join(skillsRoot, `.sync-backup-${installName}-${suffix}`);
  try {
    fs.mkdirSync(staging, { recursive: true });
    for (const [relative, file] of files) {
      const outPath = path.join(staging, ...relative.split('/'));
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, file.bytes, { mode: file.mode || 0o644 });
    }
    if (existing) fs.renameSync(destination, backup);
    try {
      fs.renameSync(staging, destination);
    } catch (swapError) {
      if (lstatOrNull(backup) && !lstatOrNull(destination)) fs.renameSync(backup, destination);
      throw swapError;
    }
    if (lstatOrNull(backup)) fs.rmSync(backup, { recursive: true, force: true });
  } finally {
    if (lstatOrNull(staging)) fs.rmSync(staging, { recursive: true, force: true });
  }
}

/** 以原子替换方式写入外部 Skill 来源锁，避免中途写入留下损坏 JSON。 */
function writeLockAtomically(projectRoot, lockData) {
  const lockPath = path.join(projectRoot, ...LOCK_RELATIVE.split('/'));
  const dir = path.dirname(lockPath);
  fs.mkdirSync(dir, { recursive: true });
  assertOrdinaryPath(dir);
  const existing = lstatOrNull(lockPath);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new Error(`来源锁路径不是普通文件：${lockPath}`);
  }
  const tempPath = path.join(dir, `.external-skills-lock-${randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(lockData, null, 2)}\n`, 'utf8');
    fs.renameSync(tempPath, lockPath);
  } finally {
    if (lstatOrNull(tempPath)) fs.rmSync(tempPath, { force: true });
  }
}

/** 读取已有外部 Skill 来源锁；缺失返回 null，结构非法时明确报错。 */
function readLockOrNull(projectRoot) {
  const lockPath = path.join(projectRoot, ...LOCK_RELATIVE.split('/'));
  const stat = lstatOrNull(lockPath);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`来源锁路径非法：${lockPath}`);
  return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
}

/** 只读检查外部增强 Skills 分类、适用性与本地安装/锁状态。 */
export function inspectExternalSkills(projectRootRaw, options = {}) {
  const projectRoot = assertOrdinaryPath(projectRootRaw);
  const catalog = loadExternalSkillsCatalog(options.catalogPath);
  const selection = resolveProjectSelection(projectRoot, options);
  const lock = readLockOrNull(projectRoot);
  const categories = Object.fromEntries(catalog.categories.map(item => [item.id, item]));
  const items = catalog.entries.map(entry => {
    const applicable = isEntryApplicable(entry, selection);
    const lockEntry = lock?.entries?.[entry.id] ?? null;
    const installedSkills = (entry.skills ?? []).map(skill => {
      const skillDir = path.join(projectRoot, '.agents', 'skills', skill.installName);
      const skillFile = path.join(skillDir, 'SKILL.md');
      const noteFile = path.join(skillDir, 'HARNESS-CONSTRAINTS.md');
      return {
        installName: skill.installName,
        path: `.agents/skills/${skill.installName}`,
        installed: Boolean(lstatOrNull(skillFile)?.isFile()),
        hasConstraintsNote: Boolean(lstatOrNull(noteFile)?.isFile()),
      };
    });
    return {
      id: entry.id,
      name: entry.name,
      category: entry.category,
      categoryTitle: categories[entry.category].title,
      kind: entry.kind,
      homepage: entry.homepage,
      applicable,
      deferredToProjectCreation: Boolean(entry.environment?.deferredToProjectCreation),
      lockedCommit: lockEntry?.commit ?? null,
      lockedStatus: lockEntry?.status ?? null,
      skills: installedSkills,
      constraints: entry.constraints ?? [],
    };
  });
  return {
    schemaVersion: 1,
    action: 'inspect',
    projectRoot,
    selection,
    lockPresent: Boolean(lock),
    lockUpdatedAt: lock?.updatedAt ?? null,
    items,
  };
}

/** 从最新上游同步所有适用外部 Skills，写入约束旁注并更新受保护来源锁。 */
export function syncExternalSkills(projectRootRaw, options = {}) {
  const projectRoot = assertOrdinaryPath(projectRootRaw);
  const catalog = loadExternalSkillsCatalog(options.catalogPath);
  const selection = resolveProjectSelection(projectRoot, options);
  if (!selection.interfaces.length) {
    throw new Error('未能解析项目接口：请先完成根 Cargo 元数据初始化或显式传入 --interfaces');
  }
  const sourceOverride = options.sourceOverride ?? null;
  if (sourceOverride !== null && process.env.AFH_TEST_MODE !== '1') {
    throw new Error('仅在 AFH_TEST_MODE=1 的隔离测试中允许使用 --source-override');
  }
  const categoryFilter = options.category || null;
  const skillsRoot = path.join(projectRoot, '.agents', 'skills');
  const existingLock = readLockOrNull(projectRoot);
  const lockEntries = { ...(existingLock?.entries ?? {}) };
  const results = [];

  for (const entry of catalog.entries) {
    if (categoryFilter && entry.category !== categoryFilter) continue;
    const applicable = isEntryApplicable(entry, selection);
    if (!applicable) {
      const record = {
        id: entry.id,
        category: entry.category,
        kind: entry.kind,
        repository: entry.homepage,
        status: 'skipped-inapplicable',
        commit: null,
        skills: [],
        constraints: entry.constraints ?? [],
      };
      lockEntries[entry.id] = record;
      results.push(record);
      continue;
    }
    if (entry.kind === 'cli-tool') {
      const record = {
        id: entry.id,
        category: entry.category,
        kind: entry.kind,
        repository: entry.homepage,
        status: 'deferred-environment-tool',
        installerHelper: entry.environment?.installerHelper ?? null,
        requiredTools: entry.environment?.requiredTools ?? [],
        commit: null,
        skills: [],
        constraints: entry.constraints ?? [],
      };
      lockEntries[entry.id] = record;
      results.push(record);
      continue;
    }

    const repoUrl = sourceOverride?.[entry.id] ?? entry.repository;
    const tempParent = fs.mkdtempSync(path.join(os.tmpdir(), `afh-ext-${entry.id}-`));
    const cloneDir = path.join(tempParent, 'repo');
    try {
      runGit(['clone', '--depth', '1', '--no-tags', '--single-branch', '--config', 'core.symlinks=false', '--', repoUrl, cloneDir]);
      const commit = runGit(['rev-parse', 'HEAD'], cloneDir);
      if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error(`无法解析 40 位上游提交摘要：${entry.id}`);
      const rootLicensePath = ['LICENSE', 'LICENSE.md', 'LICENSE.txt']
        .map(name => path.join(cloneDir, name))
        .find(candidate => lstatOrNull(candidate)?.isFile());
      const rootLicenseBytes = rootLicensePath ? fs.readFileSync(rootLicensePath) : null;

      const syncedSkills = [];
      for (const skill of entry.skills) {
        const sourceDir = path.join(cloneDir, ...skill.sourceSubpath.split('/'));
        const sourceStat = lstatOrNull(sourceDir);
        if (!sourceStat || sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
          throw new Error(`上游仓库缺少声明的 Skill 目录：${entry.id}/${skill.sourceSubpath}`);
        }
        const files = collectRegularTree(sourceDir);
        const skillMd = files.get('SKILL.md');
        if (!skillMd || skillMd.bytes.length === 0) {
          throw new Error(`上游 Skill 缺少非空 SKILL.md：${entry.id}/${skill.sourceSubpath}`);
        }
        if (rootLicenseBytes && !files.has('LICENSE') && !files.has('LICENSE.md')) {
          files.set('LICENSE', { bytes: rootLicenseBytes, mode: 0o644, sha256: sha256(rootLicenseBytes) });
        }
        if ((entry.constraints ?? []).length > 0) {
          const noteBytes = Buffer.from(renderConstraintsNote(entry, skill, commit), 'utf8');
          files.set('HARNESS-CONSTRAINTS.md', { bytes: noteBytes, mode: 0o644, sha256: sha256(noteBytes) });
        }
        installSkillAtomically(skillsRoot, skill.installName, files);
        const manifestList = [...files.entries()]
          .sort(([a], [b]) => a.localeCompare(b, 'en'))
          .map(([relative, file]) => ({ path: relative, sha256: file.sha256 }));
        syncedSkills.push({
          installName: skill.installName,
          installPath: `.agents/skills/${skill.installName}`,
          sourceSubpath: skill.sourceSubpath,
          fileCount: manifestList.length,
          manifestSha256: sha256(JSON.stringify(manifestList)),
          skillMdSha256: skillMd.sha256,
        });
      }
      const record = {
        id: entry.id,
        category: entry.category,
        kind: entry.kind,
        repository: entry.homepage,
        status: 'synced',
        commit,
        skills: syncedSkills,
        constraints: entry.constraints ?? [],
      };
      lockEntries[entry.id] = record;
      results.push(record);
    } finally {
      fs.rmSync(tempParent, { recursive: true, force: true });
    }
  }

  const updatedAt = new Date().toISOString();
  const lockData = {
    schemaVersion: 1,
    updatedAt,
    interfaces: selection.interfaces,
    nshTargets: selection.nshTargets,
    entries: lockEntries,
  };
  writeLockAtomically(projectRoot, lockData);
  return {
    schemaVersion: 1,
    action: 'sync',
    projectRoot,
    selection,
    updatedAt,
    lockPath: LOCK_RELATIVE,
    results,
  };
}

/** CLI 入口：支持 inspect 与 sync 两种明确操作，单行 JSON 输出。 */
export function main(argv = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      'project-root': { type: 'string' },
      interfaces: { type: 'string', default: '' },
      'nsh-targets': { type: 'string', default: '' },
      category: { type: 'string', default: '' },
      'source-override': { type: 'string', default: '' },
    },
    allowPositionals: true,
    strict: true,
  });
  if (positionals.length !== 1 || !['inspect', 'sync'].includes(positionals[0])) {
    throw new Error('用法：sync_external_skills.mjs <inspect|sync> --project-root <dir> [--interfaces <csv>] [--nsh-targets <csv>]');
  }
  if (!values['project-root']) throw new Error('必须提供 --project-root');
  const sourceOverride = values['source-override'] ? JSON.parse(values['source-override']) : null;
  const options = {
    interfacesRaw: values.interfaces,
    nshTargetsRaw: values['nsh-targets'],
    category: values.category,
    sourceOverride,
  };
  return positionals[0] === 'inspect'
    ? inspectExternalSkills(values['project-root'], options)
    : syncExternalSkills(values['project-root'], options);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(main())}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: 'error', message: error.message })}\n`);
    process.exitCode = 1;
  }
}
