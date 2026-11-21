'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const moduleFile = require.resolve('./material-paths');
const originalCwd = process.cwd();
const originalEnv = process.env.GIFA_MATERIALS_DIR;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gifa-material-paths-'));
let passed = 0;
function check(name, fn) { fn(); passed++; console.log('PASS  ' + name); }
/* 目录链接（Windows junction）要用 rmdir 拆，unlink 会 EPERM 把测试直接挂掉。
 * 先试 unlink（真符号链接），失败再 rmdir（junction）。 */
function removeLink(target) {
  try {
    fs.unlinkSync(target);
  } catch {
    fs.rmdirSync(target);
  }
}
function load(directory) {
  if (directory === undefined) delete process.env.GIFA_MATERIALS_DIR;
  else process.env.GIFA_MATERIALS_DIR = directory;
  delete require.cache[moduleFile];
  return require(moduleFile);
}
try {
  const defaults = load();
  check('默认素材路径基于项目父目录', () => {
    assert.equal(defaults.MATERIALS, path.resolve(ROOT, '..', '_materials', 'GIFA'));
    assert.equal(defaults.FIXTURES, path.join(defaults.MATERIALS, 'vision-probe', 'fixtures'));
  });
  process.chdir(temp);
  check('切换工作目录不改变默认素材位置', () => assert.equal(load().MATERIALS, defaults.MATERIALS));
  const custom = path.join(temp, '未创建的素材目录');
  const configured = load(custom);
  check('允许外部自定义目录且导入不创建目录', () => {
    assert.equal(configured.MATERIALS, custom);
    assert.equal(fs.existsSync(custom), false);
  });
  check('拒绝项目根目录和内部子目录', () => {
    assert.throws(() => configured.assertExternalPath(ROOT), /项目目录外/);
    assert.throws(() => configured.assertExternalPath(path.join(ROOT, 'fixtures', 'sample.png')), /项目目录外/);
  });
  check('拒绝经父级跳转回到项目的路径', () => {
    assert.throws(() => configured.assertExternalPath(path.join(ROOT, '..', path.basename(ROOT), 'sample.png')), /项目目录外/);
  });
  check('拒绝将素材环境变量设置在项目内部', () => {
    assert.throws(() => load(path.join(ROOT, 'local-materials')), /项目目录外/);
  });
  check('相似名称的相邻目录可作为外部素材路径', () => {
    assert.equal(configured.assertExternalPath(path.resolve(ROOT, '..', path.basename(ROOT) + '-other', 'sample.png')),
      path.resolve(ROOT, '..', path.basename(ROOT) + '-other', 'sample.png'));
  });
  const junction = path.join(temp, 'project-link');
  fs.symlinkSync(ROOT, junction, process.platform === 'win32' ? 'junction' : 'dir');
  check('拒绝经目录链接指回项目的输出', () => {
    assert.throws(() => configured.assertExternalPath(path.join(junction, 'sample.png')), /实际指向项目内部/);
  });
  assert.equal(path.dirname(junction), temp);
  removeLink(junction);
  fs.mkdirSync(custom, { recursive: true });
  const nestedLink = path.join(custom, 'vision-probe');
  fs.symlinkSync(ROOT, nestedLink, process.platform === 'win32' ? 'junction' : 'dir');
  check('拒绝外部素材目录中的子目录链接指回项目', () => {
    assert.throws(() => load(custom), /实际指向项目内部/);
  });
  assert.equal(path.dirname(nestedLink), custom);
  removeLink(nestedLink);
  load(custom);
  const { Canvas } = require('./vision-probe/cone-lab');
  const canvas = new Canvas(1, 1);
  check('对照图拒绝写回仓库', () => assert.throws(() => canvas.save(path.join(ROOT, 'test-preview.png')), /项目目录外/));
  check('对照图允许外部输出且自动创建目录', () => {
    const output = path.join(custom, 'preview', 'tiny.png');
    canvas.save(output);
    assert.equal(fs.readFileSync(output).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  });
  console.log(`\n${passed} PASS / 0 FAIL`);
} finally {
  process.chdir(originalCwd);
  if (originalEnv === undefined) delete process.env.GIFA_MATERIALS_DIR;
  else process.env.GIFA_MATERIALS_DIR = originalEnv;
  delete require.cache[moduleFile];
  assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temp).startsWith('gifa-material-paths-'));
  fs.rmSync(temp, { recursive: true, force: true });
}
