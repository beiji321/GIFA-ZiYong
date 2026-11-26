'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const gamepadHelperPath = require('../src/gamepad-helper-path');

const SOURCE = path.resolve(__dirname, '../native/GamepadPoller.cs');
const INPUT_SOURCES = ['RawGamepadInput.cs', 'SonyGamepad.cs'].map((file) => path.join(path.dirname(SOURCE), file));

function compileGamepadHelper(output, source = SOURCE, { entryPoint } = {}) {
  if (process.platform !== 'win32') throw new Error('编译手柄辅助程序需要 Windows 自带的 .NET Framework 4.x');
  const windows = process.env.SystemRoot || 'C:\\Windows';
  const compiler = ['Framework64', 'Framework']
    .map(dir => path.join(windows, 'Microsoft.NET', dir, 'v4.0.30319', 'csc.exe'))
    .find(file => fs.existsSync(file));
  if (!compiler) throw new Error('未找到 .NET Framework 4.x 的 csc.exe，无法编译手柄辅助程序');

  const directory = path.dirname(output);
  fs.mkdirSync(directory, { recursive: true });
  // 编译失败或开发者同时启动时，正在使用的完整程序仍在原位置。
  const staging = fs.mkdtempSync(path.join(directory, '.gamepad-build-'));
  try {
    const binary = path.join(staging, path.basename(output));
    const flags = ['/nologo', '/noconfig', '/target:winexe', '/platform:anycpu', '/optimize+',
      '/debug-', '/codepage:65001', '/reference:System.dll', `/out:${binary}`];
    if (entryPoint) flags.push(`/main:${entryPoint}`);
    execFileSync(compiler, [...flags, source, ...INPUT_SOURCES], { windowsHide: true, stdio: 'inherit' });
    fs.renameSync(binary, output);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return output;
}

function ensureDevGamepadHelper() {
  const binary = gamepadHelperPath();
  const existing = fs.statSync(binary, { throwIfNoEntry: false });
  const newestSource = Math.max(...[SOURCE, ...INPUT_SOURCES, __filename].map((file) => fs.statSync(file).mtimeMs));
  if (existing?.isFile() && existing.mtimeMs >= newestSource) return binary;
  return compileGamepadHelper(binary);
}

if (require.main === module) {
  try {
    console.log(ensureDevGamepadHelper());
  } catch (error) {
    console.error('构建手柄辅助程序失败：', error.message);
    process.exitCode = 1;
  }
}

module.exports = { SOURCE, compileGamepadHelper, ensureDevGamepadHelper };
