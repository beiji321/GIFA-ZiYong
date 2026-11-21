'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/* 解析真实路径必须用 native 版本：
 * Node 24 的 fs.realpathSync（libuv 实现）在 Windows 上不展开 junction，
 * 目录链接指回项目时会被当成「项目外部」放过去，素材就被写进了仓库。
 * fs.realpathSync.native 走系统 API，junction 会正确解析到真实目标。 */
const realPath = (p) => fs.realpathSync.native(p);

function assertExternalPath(value) {
  const target = path.resolve(value);
  const relative = path.relative(ROOT, target);
  if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))) {
    throw new Error('截图、视频样本及临时输出必须放在项目目录外：' + target);
  }
  let ancestor = target;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('素材目录所在位置不可用：' + target);
    ancestor = parent;
  }
  const actual = path.relative(realPath(ROOT), realPath(ancestor));
  if (!actual || (!path.isAbsolute(actual) && actual !== '..' && !actual.startsWith('..' + path.sep))) {
    throw new Error('素材目录实际指向项目内部：' + target);
  }
  return target;
}

const MATERIALS = assertExternalPath(process.env.GIFA_MATERIALS_DIR || path.join(ROOT, '..', '_materials', 'GIFA'));
const VISION = assertExternalPath(path.join(MATERIALS, 'vision-probe'));
const FIXTURES = assertExternalPath(path.join(VISION, 'fixtures'));
const REPORTS = assertExternalPath(path.join(VISION, 'reports'));
const VIDEO_CONF = assertExternalPath(path.join(VISION, 'video-conf.json'));

module.exports = { ROOT, MATERIALS, VISION, FIXTURES, REPORTS, VIDEO_CONF, assertExternalPath };
