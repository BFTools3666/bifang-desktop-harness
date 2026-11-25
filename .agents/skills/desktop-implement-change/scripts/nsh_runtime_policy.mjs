/** 初始化、开发、升级和交付共用的 NSH 版本及目标合同。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const NSH_STABLE_VERSION = '0.7.0';
export const NSH_STABLE_REVISION = '3f8ecd8b3c55ad6274c6babbf7ee55c4cd4ae359';
export const NSH_OFFICIAL_GIT = 'https://github.com/longbridge/nsh.git';
export const NSH_CLI_VERSION = `nsh ${NSH_STABLE_VERSION} (${NSH_STABLE_REVISION.slice(0, 7)})`;
export const NSH_RUNTIME_ERROR = `Harness NSH 仅支持官方 v${NSH_STABLE_VERSION} 固定提交 ${NSH_STABLE_REVISION}。请先迁移旧工程。`;
export const NSH_TARGETS = Object.freeze(['desktop', 'mobile', 'web', 'tui']);
export const NSH_PLATFORMS = Object.freeze(['windows', 'macos', 'linux', 'android', 'ios', 'web']);
const desktopPlatforms = Object.freeze(['windows', 'macos', 'linux']);
export const NSH_HOST_DESKTOP_PLATFORMS = Object.freeze({ win32: 'windows', darwin: 'macos', linux: 'linux' });
export const NSH_TARGET_PLATFORMS = Object.freeze({
  desktop: desktopPlatforms,
  mobile: Object.freeze(['android', 'ios']),
  web: Object.freeze(['web']),
  tui: desktopPlatforms,
});

/** 目标类别必须唯一且来自正式目标集合。 */
export function validateNshTargets(targets) {
  if (!Array.isArray(targets) || !targets.length) throw new Error('NSH target selection missing');
  if (new Set(targets).size !== targets.length || targets.some(target => !NSH_TARGETS.includes(target))) throw new Error('invalid NSH targets');
}

/** 每个类别必须有具体平台，平台也必须归属于已选类别。 */
export function validateNshPlatforms(targets, platforms) {
  validateNshTargets(targets);
  const supported = new Set(targets.flatMap(target => NSH_TARGET_PLATFORMS[target]));
  if (!Array.isArray(platforms) || !platforms.length ||
      new Set(platforms).size !== platforms.length ||
      platforms.some(platform => !supported.has(platform)) ||
      targets.some(target => !NSH_TARGET_PLATFORMS[target].some(platform => platforms.includes(platform)))) {
    throw new Error('NSH targets and target-platforms mismatch');
  }
}

/** CLI 必须匹配发布标签的版本和短提交。 */
export function assertNshCliVersion(output) {
  if (output.trim() !== NSH_CLI_VERSION) throw new Error(`NSH CLI and Cargo runtime revision do not match. Expected ${NSH_CLI_VERSION}.`);
}

/** NSH 在变量缺失时回退到应用内 target，仅向其进程传递 Cargo 已解析的全局目录。 */
export function nshCargoEnvironment(targetDirectory, environment = process.env) {
  return environment.CARGO_TARGET_DIR ? environment : { ...environment, CARGO_TARGET_DIR: targetDirectory };
}

/** 按 Cargo 的旧文件名优先规则读取同一目录的配置。 */
function cargoConfigIn(directory) {
  for (const name of ['config', 'config.toml']) {
    const file = path.join(directory, name);
    if (fs.existsSync(file)) return file;
  }
}

/** 读取 Cargo 的 build 或 include 内联表。 */
function inlineCargoFields(value) {
  if (!value.startsWith('{') || !value.endsWith('}')) return null;
  return new Map(statements(value.slice(1, -1), ',').map(statement => {
    const equals = statement.indexOf('=');
    const keys = keyPath(statement.slice(0, equals).trim());
    if (equals < 0 || keys?.length !== 1) throw new Error('invalid Cargo inline config field');
    return [keys[0], statement.slice(equals + 1).trim()];
  }));
}

/** NSH 子进程会直接运行未传目标的 Cargo 命令，要求配置保留默认宿主。 */
export function assertNshDefaultCargoBuildTarget(directory, environment = process.env) {
  const message = 'NSH host builds require the default Cargo host target without build.target or CARGO_BUILD_TARGET overrides';
  if (environment.CARGO_BUILD_TARGET?.trim()) throw new Error(message);
  const seen = new Set();
  const visit = (file, optional = false) => {
    let source;
    try { source = fs.readFileSync(file, 'utf8'); }
    catch (error) {
      if (optional && error.code === 'ENOENT') return;
      throw error;
    }
    const identity = fs.realpathSync(file);
    if (seen.has(identity)) return;
    seen.add(identity);
    let section = [];
    for (const statement of statements(source)) {
      if (statement.startsWith('[')) {
        section = keyPath(statement.slice(1, -1));
        continue;
      }
      const equals = statement.indexOf('=');
      if (equals < 0 || !section) continue;
      const keys = keyPath(statement.slice(0, equals).trim());
      if (!keys) continue;
      const field = [...section, ...keys];
      const value = statement.slice(equals + 1).trim();
      if (equalPath(field, ['build', 'target']) || equalPath(field, ['build'])) {
        const target = field.length === 2 ? value : inlineCargoFields(value)?.get('target');
        if (target !== undefined && !/^\[\s*\]$/u.test(target)) throw new Error(message);
      }
      if (!equalPath(field, ['include']) || !value.startsWith('[') || !value.endsWith(']')) continue;
      for (const item of statements(value.slice(1, -1), ',')) {
        const fields = inlineCargoFields(item);
        const includeFile = stringValue(fields ? fields.get('path') : item, 'config include.path');
        visit(path.resolve(path.dirname(file), includeFile), fields?.get('optional') === 'true');
      }
    }
  };
  const global = cargoConfigIn(path.resolve(directory, environment.CARGO_HOME || path.join(os.homedir(), '.cargo')));
  if (global) visit(global);
  for (let current = directory; ; current = path.dirname(current)) {
    const local = cargoConfigIn(path.join(current, '.cargo'));
    if (local) visit(local);
    if (current === path.dirname(current)) break;
  }
}

/** 开发与目标测试只能在实际支持该桌面或终端目标的本机执行。 */
export function assertNshNativeDevelopmentTarget(selection, target, host = process.platform) {
  const current = NSH_HOST_DESKTOP_PLATFORMS[host];
  const capability = target === 'tui' ? 'tui' : 'desktop';
  if (!current || ![capability, current].includes(target) ||
      !selection['nsh-targets'].includes(capability) || !selection['target-platforms'].includes(current)) {
    throw new Error(`NSH ${target} requires a selected native host platform`);
  }
}

/** 检查 Cargo 实际报告的成员和直接依赖，包括改名、开发和目标特定依赖。 */
export function assertNshCargoRuntime(root, metadata) {
  const facts = metadata.metadata?.['agent-first-harness'];
  if (path.resolve(metadata.workspace_root) !== root ||
      !Array.isArray(facts?.interfaces) || facts.interfaces.length !== 1 ||
      facts.interfaces[0] !== 'nsh' || Object.hasOwn(facts, 'gui-framework')) {
    throw new Error('requires NSH workspace with interfaces = ["nsh"]');
  }
  validateNshPlatforms(facts['nsh-targets'], facts['target-platforms']);
  const id = facts['project-id'];
  if (typeof id !== 'string' || !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/u.test(id)) throw new Error('invalid project-id');
  const name = id + '_nsh';
  const workspace = metadata.packages.filter(pkg => metadata.workspace_members.includes(pkg.id));
  const app = workspace.find(pkg => pkg.name === name && path.dirname(pkg.manifest_path) === path.join(root, name));
  if (!app) throw new Error('NSH member missing');
  const dependencies = workspace.flatMap(pkg => pkg.dependencies).filter(dep => dep.name.startsWith('nsh-'));
  const source = 'git+' + NSH_OFFICIAL_GIT + '?rev=' + NSH_STABLE_REVISION;
  const pinnedVersions = [`^${NSH_STABLE_VERSION}`, `=${NSH_STABLE_VERSION}`];
  if (!app.dependencies.some(dep => dep.name === 'nsh-core' && !dep.kind && !dep.optional && !dep.target) ||
      dependencies.some(dep => dep.source !== source || !pinnedVersions.includes(dep.req))) {
    throw new Error(NSH_RUNTIME_ERROR);
  }
  return app;
}

/** 只读查询 Cargo 实际使用的工作区。 */
export function readNshCargoMetadata(root) {
  const result = spawnSync('cargo', ['metadata', '--offline', '--no-deps', '--format-version', '1'], {
    cwd: root, encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  });
  if (result.status !== 0) throw new Error(`Cargo metadata failed: ${result.error?.message ?? result.stderr.trim()}`);
  return JSON.parse(result.stdout);
}

/** 只读确认本地 Cargo 元数据并定位 Mixed 成员。 */
export function readNshCargoApp(root) {
  return assertNshCargoRuntime(root, readNshCargoMetadata(root));
}

/** 当前模板的 Mixed 入口由同一应用目录中的 nsh.json 和 App.tsx 构成。 */
export function readNshMixedConfig(directory) {
  const configFile = path.join(directory, 'nsh.json');
  if (!fs.lstatSync(directory, { throwIfNoEntry: false })?.isDirectory() ||
      !fs.lstatSync(configFile, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('NSH config 必须是应用目录中的普通文件');
  }
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (config?.rust !== '.' || Object.hasOwn(config, 'root')) throw new Error('NSH Mixed/Rust 入口无效');
  if (!fs.lstatSync(path.join(directory, 'App.tsx'), { throwIfNoEntry: false })?.isFile()) {
    throw new Error('NSH Mixed TSX 入口 App.tsx 缺失或不是普通文件');
  }
  return config;
}

/** 以字符串和数组边界分句，防止注释、多行文本伪装成接口元数据。 */
export function statements(source, delimiter = "\n") {
  const result = [];
  let current = "";
  let quote = null;
  let triple = false;
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (quote !== null) {
      current += character;
      if (quote === '"' && escaped) escaped = false;
      else if (quote === '"' && character === "\\") escaped = true;
      else if (character === quote && (!triple || source.slice(index, index + 3) === quote.repeat(3))) {
        if (triple) { current += quote.repeat(2); index += 2; }
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      triple = source.slice(index, index + 3) === character.repeat(3);
      current += triple ? character.repeat(3) : character;
      if (triple) index += 2;
    } else if (character === "#") {
      while (index + 1 < source.length && source[index + 1] !== "\n") index += 1;
    } else if (character === delimiter && depth === 0) {
      if (current.trim()) result.push(current.trim());
      current = "";
    } else {
      if (character === "[" || character === "{") depth += 1;
      if (character === "]" || character === "}") depth -= 1;
      current += character;
    }
  }
  if (quote !== null || depth !== 0) throw new Error("Cargo 接口元数据包含未结束的字符串或数组");
  if (current.trim()) result.push(current.trim());
  return result;
}

/** 支持 Cargo 常见裸键与引号键，未知键语法不猜测。 */
export function keyPath(value) {
  const parts = [];
  let remaining = value.trim();
  while (remaining) {
    const matched = /^(?:([A-Za-z0-9_-]+)|'([^']*)'|("(?:[^"\\]|\\.)*"))\s*/u.exec(remaining);
    if (!matched) return null;
    let part;
    try { part = matched[1] ?? matched[2] ?? JSON.parse(matched[3]); }
    catch { return null; }
    parts.push(part);
    remaining = remaining.slice(matched[0].length);
    if (!remaining) return parts;
    if (!remaining.startsWith(".")) return null;
    remaining = remaining.slice(1).trimStart();
    if (!remaining) return null;
  }
  return null;
}

export function equalPath(left, right) {
  return left?.length === right.length && left.every((value, index) => value === right[index]);
}

/** 受管 Cargo 字段只接受明确的字符串值。 */
export function stringValue(value, label) {
  if (/^'[^'\r\n]*'$/u.test(value)) return value.slice(1, -1);
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "string") return parsed;
  } catch { /* 下方统一报告受管字段类型错误。 */ }
  throw new Error(`Cargo ${label} 必须是字符串`);
}

/** 读取工作区依赖的固定字段，覆盖内联表、子表、点分键和包别名。 */
export function readNshWorkspaceDependencies(source) {
  const dependencies = new Map();
  const pinFields = new Set(["package", "version", "git", "rev", "branch", "tag", "path", "registry"]);
  const record = (key, field, value) => {
    if (!pinFields.has(field)) return;
    if (!dependencies.has(key)) dependencies.set(key, new Map());
    const fields = dependencies.get(key);
    if (fields.has(field)) throw new Error(`Cargo 依赖 ${key} 重复声明 ${field}`);
    fields.set(field, stringValue(value.trim(), field));
  };

  let section = [];
  for (const statement of statements(source)) {
    if (statement.startsWith("[")) {
      const array = statement.startsWith("[[");
      section = keyPath(statement.slice(array ? 2 : 1, array ? -2 : -1));
      continue;
    }
    const separator = statement.indexOf("=");
    if (separator < 0) continue;
    const keys = keyPath(statement.slice(0, separator));
    if (!section || !keys) continue;
    const fullPath = [...section, ...keys];
    if (!equalPath(fullPath.slice(0, 2), ["workspace", "dependencies"])) continue;
    const value = statement.slice(separator + 1).trim();
    const [, , key, field] = fullPath;
    if (fullPath.length === 4) record(key, field, value);
    if (fullPath.length !== 3) continue;
    if (!dependencies.has(key)) dependencies.set(key, new Map());
    if (!(value.startsWith("{") && value.endsWith("}"))) continue;
    for (const item of statements(value.slice(1, -1), ",")) {
      const equals = item.indexOf("=");
      if (equals < 0) continue;
      const fieldPath = keyPath(item.slice(0, equals));
      if (fieldPath?.length === 1) record(key, fieldPath[0], item.slice(equals + 1));
    }
  }
  return new Map([...dependencies].filter(([key, fields]) => [key, fields.get("package")]
    .some(name => typeof name === "string" && /^nsh-[a-z0-9_-]+$/u.test(name))));
}

/** 根清单必须声明 nsh-core；所有 NSH 工作区依赖都使用唯一正式版本。 */
export function assertNshWorkspacePin(source) {
  const declarations = readNshWorkspaceDependencies(source);
  if (!declarations.has("nsh-core") || [...declarations].some(([key, fields]) =>
    (key === "nsh-core" && fields.has("package") && fields.get("package") !== "nsh-core") ||
    ![NSH_STABLE_VERSION, `=${NSH_STABLE_VERSION}`].includes(fields.get("version")) ||
    fields.get("git") !== NSH_OFFICIAL_GIT || fields.get("rev") !== NSH_STABLE_REVISION ||
    ["branch", "tag", "path", "registry"].some(field => fields.has(field)))) {
    throw new Error(NSH_RUNTIME_ERROR);
  }
}
