/** 将官方桌面应用形成真实安装载体；不把压缩归档改扩展名冒充安装器。 */
import fs from 'node:fs';
import path from 'node:path';

/** Windows 要求官方 Inno 安装器；macOS 用系统工具创建含拖拽目标的只读 DMG。 */
export function prepareNshDesktopInstaller({target, stage, packageRoot, name}, run) {
  if (target === 'windows') {
    const files = fs.readdirSync(packageRoot).filter(file => file.endsWith('-setup.exe'));
    if (files.length !== 1 || !fs.lstatSync(path.join(packageRoot, files[0])).isFile()) {
      throw new Error('NSH Windows requires exactly one official setup.exe; install the official Inno Setup prerequisite and rebuild');
    }
    return {artifact: path.posix.join('package', files[0]), bundleFormat: 'exe'};
  }
  if (target !== 'macos') throw new Error('desktop installer requires macOS or Windows');
  const app = path.join(packageRoot, name + '.app');
  if (!fs.lstatSync(app).isDirectory()) throw new Error('NSH macOS application bundle is missing');
  const input = path.join(stage, '.dmg-input');
  fs.mkdirSync(input);
  try {
    run('ditto', [app, path.join(input, name + '.app')], stage);
    run('codesign', ['--verify', '--deep', '--strict', path.join(input, name + '.app')], stage);
    fs.symlinkSync('/Applications', path.join(input, 'Applications'));
    for (const license of ['LICENSE.zh-CN.md', 'LICENSE.en.md']) {
      const source = path.join(stage, license);
      if (fs.existsSync(source)) fs.copyFileSync(source, path.join(input, license));
    }
    const image = path.join(stage, 'application.dmg');
    run('hdiutil', ['create', '-volname', name, '-srcfolder', input, '-format', 'UDZO', image], stage);
    run('hdiutil', ['verify', image], stage);
    if (!fs.lstatSync(image).isFile()) throw new Error('NSH DMG was not generated');
    return {artifact: 'application.dmg', bundleFormat: 'dmg'};
  } finally { fs.rmSync(input, {recursive: true, force: true}); }
}
