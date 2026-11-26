'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { MANIFEST_NAME, HELPER_NAME, KEY_NAME, MODES, artifactName, parseVersion, compareVersions, fromKeyParts, verifyManifest } = require('./update-manifest');
const { matchArtifact } = require('./update-github');

function plainFile(file) {
  return fs.lstat(file).then(stat => stat.isFile(), () => false);
}

async function resolveUpdater({ packaged, platform, arch, mode, selfExtracting, programDir, resourcesPath }) {
  if (!packaged || platform !== 'win32' || arch !== 'x64' || selfExtracting || !MODES.includes(mode)) return null;
  const installed = await plainFile(path.join(programDir, 'installed.flag'));
  const portable = await plainFile(path.join(programDir, 'portable.flag'));
  if ((mode === 'installed' && (!installed || portable)) || (mode === 'portable' && (!portable || installed))) return null;
  const helper = path.join(resourcesPath, HELPER_NAME);
  if (!(await plainFile(helper))) return { mode, helper: null, key: null };
  let key = null;
  try {
    const keyPath = path.join(resourcesPath, KEY_NAME);
    if (await plainFile(keyPath)) key = fromKeyParts(JSON.parse(await fs.readFile(keyPath, 'utf8')));
  } catch {}
  return { mode, helper, key };
}

async function removeDownload(work) {
  if (!work) return;
  try {
    if (!(await fs.lstat(work.dir)).isDirectory()) return;
    await Promise.all([work.manifestPath, work.artifactPath].map(file => fs.unlink(file).catch(() => {})));
    await fs.rmdir(work.dir);
  } catch {}
}

function errorText(error) {
  if (error.name === 'TimeoutError' || error.name === 'AbortError') return '访问 GitHub 超时，请稍后重试。';
  const message = typeof error.message === 'string' ? error.message : '';
  return /^[\u3400-\u9fff]/u.test(message) ? message.slice(0, 200) : '更新失败，请检查网络或前往官方发布页。';
}

function createUpdateController({ version, updater, client, tempDir, confirmInstall, prepareInstall, quit, onState, updated = false }) {
  const mode = updater?.mode || null;
  const supported = mode && parseVersion(version);
  const trustedKey = updater?.key;
  let state = {
    phase: supported ? updated ? 'updated' : 'idle' : 'unsupported',
    mode, version, targetVersion: null, size: null, received: 0, notes: '', canDownload: false, revision: 0,
    message: supported ? updated ? `已更新到 v${version}。` : '' : '当前运行方式不支持应用内更新。'
  };
  let offer = null;
  let pending = null;
  let downloadAbort = null;
  let downloadFinished = null;
  let disposed = false;
  let handedOff = false;
  const snapshot = () => ({ ...state });
  function set(patch) {
    state = { ...state, ...patch, revision: state.revision + 1 };
    if (!disposed) onState(snapshot());
  }

  async function check() {
    if (!supported || disposed || ['checking', 'downloading', 'ready', 'installing'].includes(state.phase)) return snapshot();
    offer = null;
    set({ phase: 'checking', targetVersion: null, size: null, received: 0, notes: '', message: '', canDownload: false });
    try {
      const release = await client.latest();
      if (compareVersions(release.version, version) <= 0) {
        set({ phase: 'current', targetVersion: release.version, message: '当前已是最新正式版。' });
        return snapshot();
      }
      const details = { targetVersion: release.version, notes: release.notes };
      const bytes = trustedKey ? await client.manifest(release) : null;
      if (!bytes) {
        set({ ...details, phase: 'available', message: '此版本没有可验证的应用内更新包。' });
        return snapshot();
      }
      const manifest = verifyManifest(bytes, trustedKey, release.version);
      const artifact = manifest.artifacts[mode];
      const remote = matchArtifact(release, artifact);
      offer = { artifact, remote, version: release.version, bytes };
      set({ ...details, phase: 'available', size: artifact.size, canDownload: true });
    } catch (error) {
      set({ phase: 'error', message: errorText(error) });
    }
    return snapshot();
  }

  async function download() {
    if (disposed || !offer || !['available', 'error'].includes(state.phase) || !state.canDownload) return snapshot();
    const { artifact, remote, bytes } = offer;
    const controller = new AbortController();
    downloadAbort = controller;
    let finish;
    downloadFinished = new Promise(resolve => { finish = resolve; });
    set({ phase: 'downloading', received: 0, message: '' });
    let work = null;
    let lastProgress = 0;
    try {
      const dir = await fs.mkdtemp(path.join(tempDir, 'gifa-download-'));
      work = { dir, manifestPath: path.join(dir, MANIFEST_NAME), artifactPath: path.join(dir, artifact.name) };
      await fs.writeFile(work.manifestPath, bytes, { flag: 'wx', mode: 0o600 });
      await client.download(remote, artifact, work.artifactPath, controller.signal, received => {
        const now = Date.now();
        if (now - lastProgress < 150 && received !== artifact.size) return;
        lastProgress = now;
        set({ received });
      });
      controller.signal.throwIfAborted();
      pending = work;
      work = null;
      set({ phase: 'ready', received: artifact.size, message: '' });
    } catch (error) {
      await removeDownload(work);
      const canceled = controller.signal.aborted;
      set({ phase: canceled ? 'available' : 'error', received: 0, message: canceled ? '下载已取消。' : errorText(error) });
    } finally {
      downloadAbort = null;
      downloadFinished = null;
      finish();
    }
    return snapshot();
  }

  async function cancel() {
    const completion = downloadFinished;
    downloadAbort?.abort();
    await completion;
    return snapshot();
  }

  async function install() {
    if (disposed || state.phase !== 'ready' || !offer || !pending) return snapshot();
    set({ phase: 'installing', message: '正在复查发布版本并准备更新。' });
    try {
      if (!(await confirmInstall(offer.version))) {
        set({ phase: 'ready', message: '' });
        return snapshot();
      }
      const release = await client.latest();
      const bytes = release.version === offer.version ? await client.manifest(release) : null;
      if (!bytes) throw new Error('发布版本已变更，请重新检查更新。');
      const liveArtifact = verifyManifest(bytes, trustedKey, release.version).artifacts[mode];
      matchArtifact(release, liveArtifact);
      if (liveArtifact.sha256 !== offer.artifact.sha256 || liveArtifact.size !== offer.artifact.size) {
        throw new Error('发布文件已变更，请重新下载更新。');
      }
      await prepareInstall({ ...pending, targetVersion: offer.version, updater });
      handedOff = true;
      const work = pending;
      pending = null;
      await removeDownload(work);
      set({ message: '准备完成，正在退出并启动更新器。' });
      quit();
    } catch (error) {
      const work = pending;
      pending = null;
      offer = null;
      await removeDownload(work);
      set({ phase: 'error', received: 0, canDownload: false, message: errorText(error) });
    }
    return snapshot();
  }

  function dispose() {
    disposed = true;
    downloadAbort?.abort();
    const work = pending;
    pending = null;
    return Promise.all([removeDownload(work), downloadFinished]);
  }

  return { snapshot, check, download, cancel, install, dispose, isPreparing: () => state.phase === 'installing' && !handedOff };
}

function installExitHook(app, controller) {
  let shutdown = 'idle';
  app.on('before-quit', event => {
    if (controller.isPreparing()) {
      event.preventDefault();
      return;
    }
    if (shutdown === 'done') return;
    event.preventDefault();
    if (shutdown === 'waiting') return;
    shutdown = 'waiting';
    let timer;
    Promise.race([controller.dispose(), new Promise(resolve => { timer = setTimeout(resolve, 1500); })]).finally(() => {
      clearTimeout(timer);
      shutdown = 'done';
      app.quit();
    });
  });
}

module.exports = { createUpdateController, installExitHook, resolveUpdater };
