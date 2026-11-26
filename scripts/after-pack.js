'use strict';

// 保留必要许可并集中到资源目录；只清理 Electron 自带的开发启动文件。
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');
const { LICENSE_DIR, ELECTRON_LICENSE_FILES, verifyLicenseBundle } = require('./license-files');
const { compileGamepadHelper } = require('./build-gamepad-helper');
const { buildUpdateHelper } = require('./build-update-helper');
const gamepadHelperPath = require('../src/gamepad-helper-path');

function organizeWindowsResources(appOutDir) {
  const root = path.resolve(appOutDir);
  function outputPath(relative) {
    const target = path.resolve(root, relative);
    if (!target.startsWith(root + path.sep)) throw new Error(`拒绝操作发行目录以外的路径：${target}`);
    return target;
  }

  const archive = outputPath('resources/app.asar');
  asar.uncache(archive);
  // assets/ 是剧情识别的模板图和抓图脚本，属于产品资源，不是素材。
  const allowedRoots = new Set(['src', 'build', 'assets', 'node_modules', 'package.json']);
  const unexpected = asar.listPackage(archive)
    .map((entry) => entry.replace(/\\/g, '/').replace(/^\//, ''))
    .filter((entry) => !allowedRoots.has(entry.split('/')[0]));
  if (unexpected.length) {
    throw new Error(`app.asar 收录了应用以外的内容：${unexpected.slice(0, 5).join(', ')}；请检查 build.files 包含范围`);
  }

  fs.mkdirSync(outputPath(LICENSE_DIR), { recursive: true });
  for (const { to } of ELECTRON_LICENSE_FILES) {
    const source = outputPath(path.basename(to));
    const target = outputPath(to);
    if (!fs.existsSync(source)) {
      if (fs.existsSync(target)) continue;
      throw new Error(`缺少 Electron 随附许可：${source}`);
    }
    if (!fs.lstatSync(source).isFile() || fs.existsSync(target)) {
      throw new Error(`无法整理随附许可：${source} → ${target}`);
    }
    fs.renameSync(source, target);
  }
  verifyLicenseBundle(root);

  // 本机使用 electronDist，builder 不会执行标准下载路径里的这两项清理。
  for (const relative of ['resources/default_app.asar', 'version']) {
    const target = outputPath(relative);
    if (!fs.existsSync(target)) continue;
    if (!fs.lstatSync(target).isFile()) throw new Error(`拒绝清理非文件路径：${target}`);
    fs.unlinkSync(target);
  }
  console.log('  GIFA：许可集中到 resources/licenses，已移除 Electron 默认启动包及版本文件');
}

module.exports = async function afterPack({ appOutDir, electronPlatformName }) {
  if (electronPlatformName !== 'win32') return;
  organizeWindowsResources(appOutDir);
  const resources = path.resolve(appOutDir, 'resources');
  compileGamepadHelper(gamepadHelperPath(resources));
  buildUpdateHelper(resources);
};
module.exports.organizeWindowsResources = organizeWindowsResources;
