'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const asar = require('@electron/asar');
const { LICENSE_DIR, PROJECT_LICENSE_FILES, EXTRA_LICENSE_FILES, LICENSE_FILES, verifyLicenseBundle } = require('./license-files');
const afterPackHook = require('./after-pack');
const gamepadHelperPath = require('../src/gamepad-helper-path');
// 非 Windows 也能验证归档与许可；Windows 额外运行含编译步骤的完整钩子。
const afterPack = process.platform === 'win32' ? afterPackHook : async ({ appOutDir }) => afterPackHook.organizeWindowsResources(appOutDir);

const ROOT = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file));
const pkg = JSON.parse(read('package.json'));
let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS  ' + name);
}

async function main() {
  check('GNU GPLv3 正文与官方标准文本一致', () => {
    const text = read('LICENSE').toString('utf8').replace(/\r\n/g, '\n');
    assert.equal(crypto.createHash('sha256').update(text).digest('hex'),
      '3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986');
  });
  check('libuiohook 随附 LGPLv3 官方正文与版权、对应源码说明', () => {
    assert.equal(crypto.createHash('sha256').update(read('LICENSES/LGPL-3.0.txt').toString('utf8').replace(/\r\n/g, '\n')).digest('hex'),
      'e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118');
    const notice = read('LICENSES/libuiohook-NOTICE.txt').toString('utf8');
    assert.ok(notice.includes('Alexander Barker') && notice.includes('LGPL-3.0-or-later'));
    assert.ok(notice.includes('uiohook-napi-1.5.5.tgz'));
  });
  check('项目元数据与锁文件采用 GPL-3.0-only', () => {
    assert.equal(pkg.license, 'GPL-3.0-only');
    assert.equal(JSON.parse(read('package-lock.json')).packages[''].license, pkg.license);
  });
  check('安装器含完整许可、版权及历史授权', () => {
    const data = read('build/LICENSE.txt');
    assert.equal(data.subarray(0, 3).toString('hex'), 'efbbbf');
    const text = data.toString('utf8').replace(/\r\n/g, '\n');
    for (const file of PROJECT_LICENSE_FILES) assert.ok(text.includes(read(file.from).toString('utf8').replace(/\r\n/g, '\n').trimEnd()));
  });
  check('许可只复制到 resources/licenses，不在 app.asar 重复收录', () => {
    for (const file of EXTRA_LICENSE_FILES) {
      const to = file.to.slice('resources/'.length);
      assert.ok(pkg.build.extraResources.some((entry) => entry.from === file.from && entry.to === to));
      assert.ok(!pkg.build.files.includes(file.from));
    }
    assert.equal(pkg.build.afterPack, 'scripts/after-pack.js');
  });

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gifa-license-check-'));
  const appDir = path.join(temp, 'app');
  const bundle = path.join(temp, 'bundle');
  const archive = path.join(bundle, 'resources', 'app.asar');
  try {
    fs.mkdirSync(path.join(bundle, LICENSE_DIR), { recursive: true });
    fs.mkdirSync(appDir, { recursive: true });
    for (const file of LICENSE_FILES) fs.copyFileSync(path.join(ROOT, file.from), path.join(bundle, file.to));
    fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(pkg));
    await asar.createPackage(appDir, archive);
    check('集中布局无需归档内许可副本，全部完整正文可通过', () => assert.equal(verifyLicenseBundle(bundle), true));

    // 使用真实随附许可模拟 builder 的 afterPack 输入，避免漏拷或误清业务资源。
    for (const name of ['LICENSE.electron.txt', 'LICENSES.chromium.html']) {
      const source = path.resolve(bundle, LICENSE_DIR, name);
      const target = path.resolve(bundle, name);
      assert.equal(path.dirname(source), path.resolve(bundle, LICENSE_DIR));
      assert.equal(path.dirname(target), path.resolve(bundle));
      fs.renameSync(source, target);
    }
    fs.writeFileSync(path.join(bundle, 'resources', 'default_app.asar'), 'electron demo');
    fs.writeFileSync(path.join(bundle, 'version'), '45.2.3');
    fs.mkdirSync(path.join(bundle, 'data'));
    fs.writeFileSync(path.join(bundle, 'data', 'settings.json'), '{"keep":true}');
    await afterPack({ appOutDir: bundle, electronPlatformName: 'win32' });
    check('afterPack 整理许可、清理示例且保留业务归档和用户数据', () => {
      assert.equal(verifyLicenseBundle(bundle), true);
      assert.ok(!fs.existsSync(path.join(bundle, 'LICENSE.electron.txt')));
      assert.ok(!fs.existsSync(path.join(bundle, 'LICENSES.chromium.html')));
      assert.ok(!fs.existsSync(path.join(bundle, 'resources', 'default_app.asar')));
      assert.ok(!fs.existsSync(path.join(bundle, 'version')));
      assert.ok(fs.existsSync(archive));
      if (process.platform === 'win32') {
        const helper = gamepadHelperPath(path.join(bundle, 'resources'));
        assert.equal(fs.readFileSync(helper).toString('ascii', 0, 2), 'MZ');
      }
      assert.equal(fs.readFileSync(path.join(bundle, 'data', 'settings.json'), 'utf8'), '{"keep":true}');
    });
    await afterPack({ appOutDir: bundle, electronPlatformName: 'win32' });
    check('afterPack 重复执行幂等', () => assert.equal(verifyLicenseBundle(bundle), true));

    const notice = LICENSE_FILES.find((file) => file.from === 'NOTICE');
    fs.writeFileSync(path.join(bundle, notice.to), 'old notice');
    check('拒绝随附许可过期的旧目录', () => assert.throws(() => verifyLicenseBundle(bundle), /许可缺失或过期/));
    fs.copyFileSync(path.join(ROOT, notice.from), path.join(bundle, notice.to));

    const legacy = LICENSE_FILES.find((file) => file.from === 'LICENSES/MIT-legacy.txt');
    const legacyPath = path.resolve(bundle, legacy.to);
    assert.equal(path.dirname(legacyPath), path.resolve(bundle, LICENSE_DIR));
    fs.unlinkSync(legacyPath);
    check('拒绝缺少历史 MIT 声明的目录', () => assert.throws(() => verifyLicenseBundle(bundle), /许可缺失或过期/));
    fs.copyFileSync(path.join(ROOT, legacy.from), legacyPath);

    fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ ...pkg, license: 'MIT' }));
    await asar.createPackage(appDir, archive);
    check('拒绝仍含 MIT 元数据的旧归档', () => assert.throws(() => verifyLicenseBundle(bundle), /版本或许可与当前源码不一致/));
    fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(pkg));
    await asar.createPackage(appDir, archive);

    const strayDir = path.resolve(appDir, 'dist-old');
    assert.equal(path.dirname(strayDir), path.resolve(appDir));
    fs.mkdirSync(strayDir);
    fs.writeFileSync(path.join(strayDir, 'previous.zip'), 'must not ship');
    await asar.createPackage(appDir, archive);
    await assert.rejects(afterPack({ appOutDir: bundle, electronPlatformName: 'win32' }), /app.asar 收录了应用以外的内容/);
    passed++;
    console.log('PASS  afterPack 拒绝归档混入旧发行包等项目外内容');
    fs.unlinkSync(path.join(strayDir, 'previous.zip'));
    fs.rmdirSync(strayDir);
    await asar.createPackage(appDir, archive);

    const chromium = LICENSE_FILES.find((file) => file.to.endsWith('LICENSES.chromium.html'));
    fs.writeFileSync(path.join(bundle, chromium.to), 'truncated');
    check('拒绝被删减的 Chromium 第三方声明', () => assert.throws(() => verifyLicenseBundle(bundle), /许可缺失或过期/));
  } finally {
    assert.equal(path.dirname(temp), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temp).startsWith('gifa-license-check-'));
    fs.rmSync(temp, { recursive: true, force: true });
  }
  console.log(`\n${passed} PASS / 0 FAIL`);
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
