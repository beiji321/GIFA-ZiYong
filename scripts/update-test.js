'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { runInNewContext } = require('node:vm');
const { pathToFileURL } = require('node:url');
const { createHash, generateKeyPairSync } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { compareVersions, parseVersion, artifactName, keyParts, fromKeyParts, verifyManifest, MANIFEST_NAME, KEY_NAME, HELPER_NAME } = require('../src/update-manifest');
const { githubClient, RELEASE_API, matchArtifact } = require('../src/update-github');
const { resolveUpdater, createUpdateController, installExitHook } = require('../src/update-controller');
const { signedManifest } = require('./sign-update');

const target = '0.2.8';
const current = '0.2.7';
const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const wrong = generateKeyPairSync('rsa', { modulusLength: 2048 });
const artifactData = { installed: Buffer.from('setup bytes'), portable: Buffer.from('zip bytes') };
const assetsBase = `https://github.com/FinalLawer/GIFA/releases/download/v${target}/`;
const cdnBase = 'https://release-assets.githubusercontent.com/';
const assetsApi = 'https://api.github.com/repos/FinalLawer/GIFA/releases/assets/';
const assets = Object.fromEntries(Object.entries(artifactData).map(([mode, data]) => [mode, {
  name: artifactName(mode, target), size: data.length, sha256: createHash('sha256').update(data).digest('hex')
}]));
const manifest = signedManifest({ schema: 1, version: target, artifacts: assets }, key.privateKey);
const rawRelease = {
  tag_name: `v${target}`, draft: false, prerelease: false, body: '测试说明 <b>纯文本</b>',
  assets: Object.values(assets).map(file => ({ ...file, digest: 'sha256:' + file.sha256 }))
    .concat({ name: MANIFEST_NAME, size: manifest.length })
    .map((file, index) => ({ ...file, id: index + 100, url: assetsApi + (index + 100), state: 'uploaded', browser_download_url: assetsBase + file.name }))
};

async function temporary(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gifa-update-test-'));
  assert.equal(path.dirname(directory), os.tmpdir());
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function mockGitHub({ release = rawRelease, manifestData = manifest, redirect = cdnBase, downloads = artifactData } = {}) {
  const requests = [];
  const client = githubClient({ infoTimeout: 500, idleTimeout: 1000, async fetchFn(url, init) {
    requests.push(url);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'manual');
    if (url === RELEASE_API) return Response.json(release);
    const item = rawRelease.assets.find(asset => asset.url === url);
    if (item) return new Response(null, { status: 302, headers: { Location: redirect + item.name } });
    if (url === cdnBase + MANIFEST_NAME) return new Response(manifestData);
    for (const mode of Object.keys(assets)) {
      if (url === cdnBase + assets[mode].name) return new Response(downloads[mode]);
    }
    throw new Error('Unexpected URL: ' + url);
  } });
  return { client, requests };
}

async function testController(context, options = {}) {
  const tempDir = await temporary(context);
  const history = [];
  const client = options.client || mockGitHub().client;
  let quitCalls = 0;
  let staging = null;
  const controller = createUpdateController({ version: current,
    updater: { mode: 'portable', helper: 'trusted-helper', key: key.publicKey }, tempDir, client,
    confirmInstall: async () => true,
    prepareInstall: async work => {
      assert.deepEqual(await fs.readFile(work.artifactPath), artifactData.portable);
      assert.deepEqual(await fs.readFile(work.manifestPath), manifest);
      staging = work;
    }, quit: () => { quitCalls++; }, onState: snapshot => history.push(snapshot), ...options });
  context.after(() => controller.dispose());
  return { controller, history, tempDir, result: () => ({ quitCalls, staging }) };
}

test('只接受规范的正式版本、公钥及匹配发行包的签名清单', () => {
  assert.equal(compareVersions('1.10.0', '1.9.99'), 1);
  for (const invalid of ['0.2.07', '0.2.7-beta.1', '0.2.70000', 'v0.2.8', '0.2', '0.2.8\n']) assert.equal(parseVersion(invalid), null);
  const trusted = fromKeyParts(keyParts(key.publicKey));
  assert.deepEqual(verifyManifest(manifest, trusted, target).artifacts, assets);
  assert.throws(() => verifyManifest(manifest, wrong.publicKey), /签名无效/);
  assert.throws(() => verifyManifest(manifest, trusted, current), /标签版本/);
  const envelope = JSON.parse(manifest.toString());
  envelope.payload = Buffer.from(JSON.stringify({ schema: 1, version: target, artifacts: { ...assets, portable: { ...assets.portable, size: assets.portable.size + 1 } } })).toString('base64');
  assert.throws(() => verifyManifest(Buffer.from(JSON.stringify(envelope)), trusted), /签名无效/);
  assert.throws(() => signedManifest({ schema: 1, version: target, artifacts: { ...assets, portable: { ...assets.portable, name: '../bad.zip' } } }, key.privateKey), /下载文件信息/);
});

test('只信任固定仓库、HTTPS 的发布文件下载节点，拒绝预览包和跨源链接', async () => {
  const external = mockGitHub({ redirect: 'https://evil.example/' });
  await assert.rejects(external.client.manifest(await external.client.latest()), /不受信任/);
  assert.equal(external.requests.length, 2);
  await assert.rejects(mockGitHub({ release: { ...rawRelease, prerelease: true } }).client.latest(), /格式无效/);
  const bad = mockGitHub({ release: { ...rawRelease, assets: [{ ...rawRelease.assets[0], browser_download_url: 'https://evil.example/foo' }] } });
  const release = await bad.client.latest();
  assert.throws(() => matchArtifact(release, assets.installed), /发行资产信息/);
  const mismatch = mockGitHub({ release: { ...rawRelease, assets: [{ ...rawRelease.assets[0], digest: 'sha256:00' }] } });
  const wrongDigest = await mismatch.client.latest();
  assert.throws(() => matchArtifact(wrongDigest, assets.installed), /与签名清单不一致/);
  await assert.rejects(githubClient({ fetchFn: async () => new Response(null, { status: 403 }) }).latest(), /限流/);
});

test('两个发行形态均可按签名流式下载；错误摘要、大小会报错', async context => {
  const directory = await temporary(context);
  const { client } = mockGitHub();
  const release = await client.latest();
  assert.deepEqual(await client.manifest(release), manifest);
  for (const [mode, artifact] of Object.entries(assets)) {
    const file = path.join(directory, artifact.name);
    let received = 0;
    await client.download(matchArtifact(release, artifact), artifact, file, new AbortController().signal, size => { received = size; });
    assert.equal(received, artifact.size);
    assert.deepEqual(await fs.readFile(file), artifactData[mode]);
  }
  const remote = matchArtifact(release, assets.portable);
  const broken = mockGitHub({ downloads: { ...artifactData, portable: Buffer.from('ZIP bytes') } }).client;
  await assert.rejects(broken.download(remote, assets.portable, path.join(directory, 'bad-hash'), new AbortController().signal, () => {}), /SHA-256/);
  const oversized = mockGitHub({ downloads: { ...artifactData, portable: Buffer.alloc(32) } }).client;
  await assert.rejects(oversized.download(remote, assets.portable, path.join(directory, 'bad-size'), new AbortController().signal, () => {}), /超过签名清单/);
});

test('安装版和 ZIP 绿色版识别，拒绝开发模式、自解压和混用标记', async context => {
  const root = await temporary(context);
  const resourcesPath = path.join(root, 'resources');
  await fs.mkdir(resourcesPath);
  const input = { packaged: true, platform: 'win32', arch: 'x64', mode: 'portable', programDir: root, resourcesPath };
  assert.equal(await resolveUpdater(input), null);
  await fs.writeFile(path.join(root, 'portable.flag'), 'portable\n');
  assert.equal((await resolveUpdater(input)).key, null);
  await fs.writeFile(path.join(resourcesPath, HELPER_NAME), 'test');
  await fs.writeFile(path.join(resourcesPath, KEY_NAME), JSON.stringify(keyParts(key.publicKey)));
  assert.equal((await resolveUpdater(input)).key.type, 'public');
  for (const override of [{ packaged: false }, { selfExtracting: true }, { mode: 'fallback' }, { arch: 'arm64' }]) {
    assert.equal(await resolveUpdater({ ...input, ...override }), null);
  }
  await fs.writeFile(path.join(root, 'installed.flag'), 'installed\n');
  assert.equal(await resolveUpdater(input), null);
  await fs.unlink(path.join(root, 'portable.flag'));
  assert.equal((await resolveUpdater({ ...input, mode: 'installed' })).mode, 'installed');
});

test('检查、下载、复核到独立更新器交接，未确认安装前不停应用', async context => {
  const { controller, history, tempDir, result } = await testController(context);
  const offer = await controller.check();
  assert.equal(offer.phase, 'available');
  assert.equal(offer.canDownload, true);
  assert.equal(offer.size, assets.portable.size);
  assert.equal(result().quitCalls, 0);
  assert.equal((await controller.download()).phase, 'ready');
  assert.equal(result().quitCalls, 0);
  await controller.install();
  assert.equal(result().quitCalls, 1);
  assert.equal(result().staging.targetVersion, target);
  assert.equal(controller.isPreparing(), false);
  assert.deepEqual(await fs.readdir(tempDir), []);
  assert.ok(history.some(state => state.phase === 'downloading' && state.received === assets.portable.size));
});

test('未签名或未配置公钥仅手动下载；版本回退不触发更新', async context => {
  const unsigned = await testController(context, { client: mockGitHub({ release: { ...rawRelease, assets: rawRelease.assets.slice(0, 2) } }).client });
  assert.equal((await unsigned.controller.check()).phase, 'available');
  assert.equal((await unsigned.controller.download()).canDownload, false);
  const noKey = await testController(context, { updater: { mode: 'installed', helper: 'unconfigured' } });
  assert.equal((await noKey.controller.check()).canDownload, false);
  const old = await testController(context, { version: '0.3.0' });
  assert.equal((await old.controller.check()).phase, 'current');
});

test('取消下载与取消安装不退出，清理取消的临时文件', async context => {
  const original = mockGitHub().client;
  const client = { ...original, async download(_remote, _artifact, file, signal) {
    await fs.writeFile(file, 'partial data');
    await delay(10000, null, { signal });
  } };
  const canceled = await testController(context, { client });
  await canceled.controller.check();
  const download = canceled.controller.download();
  assert.equal((await canceled.controller.cancel()).phase, 'available');
  await download;
  assert.deepEqual(await fs.readdir(canceled.tempDir), []);
  const declined = await testController(context, { confirmInstall: async () => false });
  await declined.controller.check();
  await declined.controller.download();
  assert.equal((await declined.controller.install()).phase, 'ready');
  assert.equal(declined.result().quitCalls, 0);
});

test('只接受本地启动器主框架的更新 IPC', async () => {
  const sourcePath = path.resolve(__dirname, '../src/main.js');
  const main = await fs.readFile(sourcePath, 'utf8');
  const source = /^function updateSender\(event\) \{[\s\S]*?^\}/m.exec(main)[0];
  const context = { path, pathToFileURL, __dirname: path.dirname(sourcePath) };
  const mainFrame = { url: pathToFileURL(path.resolve(context.__dirname, 'console/index.html')).href };
  const webContents = { mainFrame };
  context.consoleWin = { isDestroyed: () => false, webContents };
  const authorize = runInNewContext(`${source}\nupdateSender`, context);
  assert.equal(authorize({ sender: webContents, senderFrame: mainFrame }), true);
  assert.equal(!!authorize({ sender: webContents, senderFrame: { ...mainFrame } }), false);
  assert.equal(!!authorize({ sender: {}, senderFrame: mainFrame }), false);
  mainFrame.url = 'https://www.bilibili.com/';
  assert.equal(!!authorize({ sender: webContents, senderFrame: mainFrame }), false);
});

test('正在准备时阻止退出；普通退出只清理一次', async () => {
  const app = new EventEmitter();
  let preparing = true;
  let disposed = 0;
  let quit = 0;
  app.quit = () => { quit++; };
  installExitHook(app, { isPreparing: () => preparing, dispose: async () => { disposed++; } });
  const attempt = () => {
    let prevented = false;
    app.emit('before-quit', { preventDefault: () => { prevented = true; } });
    return prevented;
  };
  assert.equal(attempt(), true);
  assert.equal(disposed, 0);
  preparing = false;
  assert.equal(attempt(), true);
  assert.equal(attempt(), true);
  await delay(0);
  assert.equal(quit, 1);
  assert.equal(disposed, 1);
  assert.equal(attempt(), false);
});

test('下载后版本撤回和更新器准备失败都不启动安装', async context => {
  const client = mockGitHub().client;
  const fetchLatest = client.latest;
  let checks = 0;
  client.latest = async () => ++checks > 1 ? { version: current } : fetchLatest();
  for (const options of [{ client }, { prepareInstall: async () => { throw new Error('文件被占用'); } }]) {
    const fixture = await testController(context, options);
    await fixture.controller.check();
    await fixture.controller.download();
    assert.equal((await fixture.controller.install()).phase, 'error');
    assert.equal(fixture.result().quitCalls, 0);
    assert.deepEqual(await fs.readdir(fixture.tempDir), []);
  }
});
