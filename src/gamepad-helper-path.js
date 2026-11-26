'use strict';

const path = require('node:path');

// 发行版传入 Electron 自己的 resourcesPath。开发版使用仓库内被忽略的构建目录。
module.exports = function gamepadHelperPath(resourcesDir = path.resolve(__dirname, '..', 'dist-gamepad-dev')) {
  return path.join(resourcesDir, 'GIFA.Gamepad.exe');
};
