'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, createPrivateKey, createPublicKey, sign, constants } = require('node:crypto');
const { MANIFEST_NAME, KEY_NAME, MODES, artifactName, keyParts, parsePayload, verifyManifest } = require('../src/update-manifest');
const { verifyZip } = require('./zip-writer');

async function artifactInfo(file, name = path.basename(file)) {
  const { size } = fs.statSync(file);
  const digest = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
  return { name, size, sha256: digest.digest('hex') };
}

function signedManifest(payload, privateKey) {
  const bytes = Buffer.from(JSON.stringify(parsePayload(payload)), 'utf8');
  const signature = sign('sha256', bytes, { key: privateKey, padding: constants.RSA_PKCS1_PADDING });
  return Buffer.from(JSON.stringify({ payload: bytes.toString('base64'), signature: signature.toString('base64') }) + '\n');
}

async function main() {
  const arg = process.argv.slice(2).find(value => value.startsWith('--out='));
  if (!arg || !arg.slice(6) || !process.env.GIFA_UPDATE_PRIVATE_KEY) {
    throw new Error('指定 --out=<发行目录>，并让 GIFA_UPDATE_PRIVATE_KEY 指向仓库外的 RSA 私钥 PEM');
  }
  const root = path.resolve(__dirname, '..');
  const output = path.resolve(root, arg.slice(6));
  const keyPath = fs.realpathSync(process.env.GIFA_UPDATE_PRIVATE_KEY);
  const repoPath = fs.realpathSync(root);
  const localPath = path.relative(repoPath, keyPath);
  if (!path.isAbsolute(localPath) && localPath !== '..' && !localPath.startsWith('..' + path.sep)) {
    throw new Error('签名私钥不可存放在项目仓库内');
  }
  const privateKey = createPrivateKey({ key: fs.readFileSync(keyPath), passphrase: process.env.GIFA_UPDATE_KEY_PASSPHRASE });
  const publicKey = createPublicKey(privateKey);
  const expectedKey = keyParts(publicKey);
  const { version } = require('../package.json');
  const artifacts = {};
  for (const mode of MODES) {
    const name = artifactName(mode, version);
    artifacts[mode] = await artifactInfo(path.join(output, name), name);
  }
  const embedded = [fs.readFileSync(path.join(output, 'win-unpacked', 'resources', KEY_NAME)),
    verifyZip(path.join(output, artifacts.portable.name)).read(`GIFA/resources/${KEY_NAME}`)];
  for (const bytes of embedded) {
    const key = bytes && JSON.parse(bytes.toString('utf8'));
    if (key?.modulus !== expectedKey.modulus || key?.exponent !== expectedKey.exponent) {
      throw new Error('私钥与两个发行包内的更新公钥必须匹配');
    }
  }
  const bytes = signedManifest({ schema: 1, version, artifacts }, privateKey);
  verifyManifest(bytes, publicKey, version);
  const file = path.join(output, MANIFEST_NAME);
  fs.writeFileSync(file, bytes, { flag: 'wx' });
  console.log(`已签名：${file}`);
}

if (require.main === module) main().catch(error => {
  console.error('[sign-update]', error.message);
  process.exitCode = 1;
});

module.exports = { artifactInfo, signedManifest };
