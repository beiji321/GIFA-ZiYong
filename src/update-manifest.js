'use strict';

const { createPublicKey, verify, constants } = require('node:crypto');
const { TextDecoder } = require('node:util');

const MANIFEST_NAME = 'GIFA-update.json';
const KEY_NAME = 'update-public-key.json';
const HELPER_NAME = 'GIFA-Updater.exe';
const MODES = Object.freeze(['installed', 'portable']);
const MAX_MANIFEST_SIZE = 64 * 1024;
const MAX_ARTIFACT_SIZE = 1024 ** 3;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const padding = constants.RSA_PKCS1_PADDING;

function parseVersion(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,4})(?:\.(?:0|[1-9]\d{0,4})){2}$/.test(value)) return null;
  const version = value.split('.').map(Number);
  return version.every(part => part <= 65535) ? version : null;
}

function compareVersions(left, right) {
  const aVersion = parseVersion(left);
  const bVersion = parseVersion(right);
  if (!aVersion || !bVersion) throw new Error('版本号无效');
  for (let index = 0; index < 3; index++) {
    if (aVersion[index] !== bVersion[index]) return aVersion[index] > bVersion[index] ? 1 : -1;
  }
  return 0;
}

function artifactName(mode, version) {
  if (!parseVersion(version) || !MODES.includes(mode)) throw new Error('更新发行版无效');
  return mode === 'installed' ? `GIFA-${version}-Setup.exe` : `GIFA-${version}-win-x64.zip`;
}

function fields(value, names) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}

function decodeBase64(value) {
  if (typeof value !== 'string' || !value.length) throw new Error('Base64 字段无效');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.toString('base64') !== value) throw new Error('Base64 字段无效');
  return bytes;
}

function fromKeyParts(parts) {
  if (!fields(parts, ['modulus', 'exponent'])) throw new Error('更新公钥格式无效');
  const modulus = decodeBase64(parts.modulus);
  const exponent = decodeBase64(parts.exponent);
  if (modulus.length < 256 || modulus.length > 512 || modulus[0] < 128 || parts.exponent !== 'AQAB') {
    throw new Error('更新公钥必须使用 2048–4096 位 RSA 和指数 65537');
  }
  return createPublicKey({ key: { kty: 'RSA', n: modulus.toString('base64url'), e: exponent.toString('base64url') }, format: 'jwk' });
}

function keyParts(key) {
  const { kty, n, e } = key.export({ format: 'jwk' });
  if (kty !== 'RSA') throw new Error('更新公钥必须使用 RSA');
  const parts = { modulus: Buffer.from(n, 'base64url').toString('base64'), exponent: Buffer.from(e, 'base64url').toString('base64') };
  fromKeyParts(parts);
  return parts;
}

function parsePayload(value) {
  if (!fields(value, ['schema', 'version', 'artifacts']) || value.schema !== 1 || !parseVersion(value.version) ||
      !fields(value.artifacts, MODES)) throw new Error('更新清单版本或格式无效');
  for (const mode of MODES) {
    const file = value.artifacts[mode];
    if (!fields(file, ['name', 'size', 'sha256']) || file.name !== artifactName(mode, value.version) ||
        !Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_ARTIFACT_SIZE ||
        typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256)) {
      throw new Error('更新清单的下载文件信息无效');
    }
  }
  return value;
}

function verifyManifest(bytes, key, expectedVersion) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_MANIFEST_SIZE || !key) throw new Error('更新清单或公钥无效');
  const envelope = JSON.parse(utf8.decode(bytes));
  if (!fields(envelope, ['payload', 'signature'])) throw new Error('更新签名格式无效');
  const payload = decodeBase64(envelope.payload);
  const signature = decodeBase64(envelope.signature);
  if (!verify('sha256', payload, { key, padding }, signature)) throw new Error('更新清单签名无效');
  const manifest = parsePayload(JSON.parse(utf8.decode(payload)));
  if (expectedVersion !== undefined && manifest.version !== expectedVersion) throw new Error('更新清单与发行标签版本不符');
  return manifest;
}

module.exports = {
  MANIFEST_NAME, KEY_NAME, HELPER_NAME, MODES, MAX_MANIFEST_SIZE, MAX_ARTIFACT_SIZE,
  artifactName, parseVersion, compareVersions, parsePayload, fromKeyParts, keyParts, verifyManifest
};
