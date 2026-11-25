#!/usr/bin/env node
/** 延迟到下游项目创建或真实故障恢复时检查并安装 deslop-please 及其依赖的 rust-analyzer 组件。 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

/** 解析只读检查或缺失安装参数，拒绝危险测试覆盖在生产环境生效。 */
export function parseDeslopOptions(argv = process.argv.slice(2), env = process.env) {
  if (env.AFH_PREREQ_PATH && env.AFH_TEST_MODE !== '1') {
    throw new Error('生产模式禁止设置 AFH_PREREQ_PATH，仅在 AFH_TEST_MODE=1 隔离测试中允许');
  }
  const { values } = parseArgs({
    args: argv,
    options: {
      'check-only': { type: 'boolean', default: false },
      'install-missing': { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values['check-only'] && values['install-missing']) {
    throw new Error('--check-only 与 --install-missing 不能同时传入');
  }
  return { install: values['install-missing'] };
}

/** 在受控 PATH 下执行命令，统一返回退出码与裁剪后的标准输出/错误。 */
function execTool(command, args, env) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env,
    timeout: 600_000,
  });
  return {
    missing: result.error?.code === 'ENOENT',
    error: result.error ? result.error.message : null,
    status: result.status,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
  };
}

/** 探测 rust-analyzer 可用性；deslop-please 依赖 rust-analyzer scip 生成索引。 */
function probeRustAnalyzer(env) {
  const result = execTool('rust-analyzer', ['--version'], env);
  if (result.missing) return { status: 'missing', version: null, detail: 'rust-analyzer 未在 PATH 中找到' };
  if (result.status !== 0 || !result.stdout) {
    return { status: 'missing', version: null, detail: result.stderr || result.error || 'rust-analyzer 不可用' };
  }
  return { status: 'passed', version: result.stdout.split(/\r?\n/u)[0], detail: null };
}

/** 探测 deslop-please 可用性；上游 CLI 不支持 --version，故以 --help 退出码与用法文本核验。 */
function probeDeslopPlease(env) {
  const result = execTool('deslop-please', ['--help'], env);
  if (result.missing) return { status: 'missing', detail: 'deslop-please 未在 PATH 中找到' };
  const combined = `${result.stdout}\n${result.stderr}`;
  if (result.status !== 0 || !combined.includes('usage: deslop-please')) {
    return { status: 'missing', detail: combined.trim().slice(-400) || result.error || 'deslop-please 探测失败' };
  }
  return { status: 'passed', detail: null };
}

/** 检查并在写入模式下安装缺失的 rust-analyzer 与 deslop-please，安装后强制复探。 */
export function ensureDeslopPlease({ install = false } = {}, baseEnv = process.env) {
  const env = baseEnv.AFH_TEST_MODE === '1' && baseEnv.AFH_PREREQ_PATH
    ? { ...baseEnv, PATH: baseEnv.AFH_PREREQ_PATH }
    : { ...baseEnv };

  let rustAnalyzer = probeRustAnalyzer(env);
  let rustAnalyzerChange = 'existing';
  if (rustAnalyzer.status !== 'passed' && install) {
    const add = execTool('rustup', ['component', 'add', 'rust-analyzer'], env);
    if (add.missing || add.status !== 0) {
      throw new Error(`安装 rust-analyzer 组件失败：${add.stderr || add.stdout || add.error || 'rustup 不可用'}`);
    }
    rustAnalyzer = probeRustAnalyzer(env);
    if (rustAnalyzer.status !== 'passed') {
      throw new Error(`安装 rust-analyzer 后复探失败：${rustAnalyzer.detail ?? '未知原因'}`);
    }
    rustAnalyzerChange = 'installed';
  }

  let deslopPlease = probeDeslopPlease(env);
  let deslopChange = 'existing';
  if (deslopPlease.status !== 'passed' && install) {
    const installed = execTool('cargo', ['install', '--locked', 'deslop-please'], env);
    if (installed.missing || installed.status !== 0) {
      throw new Error(`安装 deslop-please 失败：${installed.stderr || installed.stdout || installed.error || 'cargo 不可用'}`);
    }
    deslopPlease = probeDeslopPlease(env);
    if (deslopPlease.status !== 'passed') {
      throw new Error(`安装 deslop-please 后复探失败：${deslopPlease.detail ?? '未知原因'}`);
    }
    deslopChange = 'installed';
  }

  const passed = rustAnalyzer.status === 'passed' && deslopPlease.status === 'passed';
  return {
    tool: 'deslop-please',
    deferredToProjectCreation: true,
    mode: install ? 'install' : 'check',
    status: passed ? 'passed' : 'missing',
    rustAnalyzer: { ...rustAnalyzer, change: rustAnalyzer.status === 'passed' ? rustAnalyzerChange : 'missing' },
    deslopPlease: { ...deslopPlease, change: deslopPlease.status === 'passed' ? deslopChange : 'missing' },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const options = parseDeslopOptions();
    const report = ensureDeslopPlease(options);
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.status !== 'passed') process.exitCode = 20;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: 'error', message: error.message })}\n`);
    process.exitCode = 1;
  }
}
