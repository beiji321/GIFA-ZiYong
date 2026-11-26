'use strict';

const { createHash } = require('node:crypto');
const { createWriteStream } = require('node:fs');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { TextDecoder } = require('node:util');
const { MANIFEST_NAME, MAX_MANIFEST_SIZE, MAX_ARTIFACT_SIZE, parseVersion } = require('./update-manifest');

const REPO = 'FinalLawer/GIFA';
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const ASSET_PREFIX = `https://github.com/${REPO}/releases/download/`;
const ASSET_API_PREFIX = `https://api.github.com/repos/${REPO}/releases/assets/`;
const ASSET_HOSTS = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const MAX_RELEASE_SIZE = 512 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function allowedDownload(url, original) {
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash &&
    (url.href === original || ASSET_HOSTS.has(url.hostname));
}

async function discard(response) {
  try { await response.body?.cancel(); } catch {}
}

async function get(fetchFn, original, signal, isAsset) {
  let url = new URL(original);
  const apiAsset = url.href.startsWith(ASSET_API_PREFIX) && /^[1-9]\d*$/.test(url.href.slice(ASSET_API_PREFIX.length));
  if (isAsset && ((!url.href.startsWith(ASSET_PREFIX) && !apiAsset) || url.search)) {
    throw new Error('GitHub 返回了不受信任的更新地址');
  }
  for (let redirects = 0; redirects <= 4; redirects++) {
    if (isAsset ? !allowedDownload(url, original) : url.href !== RELEASE_API) {
      throw new Error('GitHub 返回了不受信任的更新地址');
    }
    const response = await fetchFn(url.href, {
      method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store', signal,
      headers: isAsset ? { Accept: 'application/octet-stream' } : {
        Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'
      }
    });
    if (response.status === 200 && response.body) return response.body;
    const location = response.headers.get('location');
    await discard(response);
    if (isAsset && REDIRECTS.has(response.status) && location) {
      url = new URL(location, url);
      continue;
    }
    if (response.status === 403 || response.status === 429) throw new Error('GitHub 暂时无法响应或已限流，请稍后重试');
    throw new Error(`GitHub 请求失败（HTTP ${response.status}）`);
  }
  throw new Error('GitHub 下载重定向次数过多');
}

async function readSmall(body, maxBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of body) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error('GitHub 返回的更新信息过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, bytes);
}

function parseRelease(raw) {
  const tag = raw?.tag_name;
  if (typeof tag !== 'string' || !tag.startsWith('v') || !parseVersion(tag.slice(1)) ||
      raw.draft !== false || raw.prerelease !== false || !Array.isArray(raw.assets)) {
    throw new Error('GitHub 正式发行版格式无效');
  }
  return { tag, version: tag.slice(1), notes: typeof raw.body === 'string' ? raw.body.trim().slice(0, 4500) : '', assets: raw.assets };
}

function releaseAsset(release, name) {
  const matches = release.assets.filter(asset => asset?.name === name);
  if (!matches.length) return null;
  if (matches.length !== 1) throw new Error('GitHub 发行资产重复');
  const asset = matches[0];
  const browserUrl = `${ASSET_PREFIX}${release.tag}/${name}`;
  if (asset.state !== 'uploaded' || asset.browser_download_url !== browserUrl || !Number.isSafeInteger(asset.size) ||
      asset.size < 1 || asset.size > MAX_ARTIFACT_SIZE || !Number.isSafeInteger(asset.id) || asset.id < 1 ||
      asset.url !== `${ASSET_API_PREFIX}${asset.id}`) throw new Error('GitHub 发行资产信息无效');
  return { url: asset.url, size: asset.size, digest: asset.digest };
}

function matchArtifact(release, artifact) {
  const remote = releaseAsset(release, artifact.name);
  if (!remote || remote.size !== artifact.size ||
      (remote.digest != null && remote.digest !== `sha256:${artifact.sha256}`)) {
    throw new Error('GitHub 发行资产与签名清单不一致');
  }
  return remote;
}

function githubClient({ fetchFn = globalThis.fetch, infoTimeout = 15000, idleTimeout = 30000 } = {}) {
  return {
    async latest() {
      const body = await get(fetchFn, RELEASE_API, AbortSignal.timeout(infoTimeout), false);
      return parseRelease(JSON.parse(utf8.decode(await readSmall(body, MAX_RELEASE_SIZE))));
    },
    async manifest(release) {
      const asset = releaseAsset(release, MANIFEST_NAME);
      if (!asset) return null;
      if (asset.size > MAX_MANIFEST_SIZE) throw new Error('签名清单过大');
      const body = await get(fetchFn, asset.url, AbortSignal.timeout(infoTimeout), true);
      const bytes = await readSmall(body, MAX_MANIFEST_SIZE);
      if (bytes.length !== asset.size) throw new Error('签名清单长度错误');
      return bytes;
    },
    async download(remote, artifact, destination, signal, onProgress) {
      const idle = new AbortController();
      const timedSignal = AbortSignal.any([signal, idle.signal, AbortSignal.timeout(3600000)]);
      const touch = () => setTimeout(() => idle.abort(), idleTimeout).unref();
      let timer = touch();
      const hash = createHash('sha256');
      let received = 0;
      try {
        const body = await get(fetchFn, remote.url, timedSignal, true);
        const meter = new Transform({
          transform(chunk, _encoding, callback) {
            clearTimeout(timer);
            timer = touch();
            received += chunk.length;
            if (received > artifact.size) return callback(new Error('下载内容超过签名清单的大小'));
            hash.update(chunk);
            onProgress(received);
            callback(null, chunk);
          }
        });
        await pipeline(body, meter, createWriteStream(destination, { flags: 'wx' }), { signal: timedSignal });
        if (received !== artifact.size || hash.digest('hex') !== artifact.sha256) throw new Error('下载文件大小或 SHA-256 校验失败');
      } finally {
        clearTimeout(timer);
      }
    }
  };
}

module.exports = { RELEASE_API, RELEASES_PAGE, githubClient, matchArtifact };
