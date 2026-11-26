'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { createZip } = require('./zip-writer');

const portableName = 'GIFA-0.2.8-win-x64.zip';
const setupName = 'GIFA-0.2.8-Setup.exe';
const roots = [
  'chrome_100_percent.pak', 'chrome_200_percent.pak', 'd3dcompiler_47.dll', 'dxcompiler.dll',
  'electron_wer.dll', 'ffmpeg.dll', 'icudtl.dat', 'resources.pak', 'snapshot_blob.bin',
  'v8_context_snapshot.bin', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll', 'README-绿色版.txt',
];

function fixturePath(root, relative) {
  const target = path.resolve(root, relative);
  assert(target.startsWith(root + path.sep), `Not a fixture path: ${relative}`);
  return target;
}

function write(root, relative, data) {
  const target = fixturePath(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
  return target;
}

function artifact(name, bytes) {
  return { name, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

function manifests(root, zip, setup, privateKey) {
  const manifest = { schema: 1, version: '0.2.8', artifacts: { installed: artifact(setupName, setup), portable: artifact(portableName, zip) } };
  function signed(payload) {
    const bytes = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8');
    return { payload: bytes.toString('base64'), signature: crypto.sign('sha256', bytes, privateKey).toString('base64') };
  }
  const valid = signed(manifest);
  write(root, 'valid.json', JSON.stringify(valid));
  const altered = structuredClone(manifest);
  altered.artifacts.portable.size++;
  const renamed = structuredClone(manifest);
  renamed.artifacts.installed.name = 'not-GIFA.exe';
  const hashCase = structuredClone(manifest);
  hashCase.artifacts.portable.sha256 = 'A'.repeat(64);
  const oversize = structuredClone(manifest);
  oversize.artifacts.portable.size = 1024 ** 3 + 1;
  const signature = Buffer.from(valid.signature, 'base64');
  signature[0] ^= 1;
  const bad = {
    payload: { ...valid, payload: Buffer.from(JSON.stringify(altered)).toString('base64') },
    signature: { ...valid, signature: signature.toString('base64') },
    'noncanonical-base64': { ...valid, payload: valid.payload + '\n' },
    'duplicate-field': signed(JSON.stringify(manifest).replace('{', '{"version":"0.2.9",')),
    'wide-version': signed({ ...manifest, version: '65536.0.0' }),
    'leading-zero': signed({ ...manifest, version: '0.02.8' }),
    prerelease: signed({ ...manifest, version: '0.2.8-pre' }),
    'other-artifact-name': signed(renamed),
    'non-integer-size': signed(JSON.stringify(manifest).replace(/"size":(\d+)/, '"size":$1.0')),
    'oversize-artifact': signed(oversize),
    'uppercase-hash': signed(hashCase),
  };
  for (const [name, body] of Object.entries(bad)) write(root, `bad-manifest-${name}.json`, JSON.stringify(body));
  write(root, 'bad-manifest-too-large.json', JSON.stringify(valid) + ' '.repeat(64 * 1024));
}

function zipMember(zip, name) {
  const last = zip.length - 22;
  let central = zip.readUInt32LE(last + 16);
  for (let index = 0; index < zip.readUInt16LE(last + 10); index++) {
    const nameSize = zip.readUInt16LE(central + 28);
    if (zip.toString('utf8', central + 46, central + 46 + nameSize) === name) {
      const local = zip.readUInt32LE(central + 42);
      return { central, local, nameSize, data: local + 30 + nameSize, descriptor: local + 30 + nameSize + zip.readUInt32LE(central + 20) };
    }
    central += 46 + nameSize;
  }
  throw new Error(`Missing fixture ZIP entry ${name}`);
}

function replaceName(zip, source, replacement) {
  const member = zipMember(zip, source);
  const name = Buffer.from(replacement);
  assert.equal(name.length, member.nameSize);
  name.copy(zip, member.central + 46);
  name.copy(zip, member.local + 30);
}

function badZips(root, pristine) {
  const member = 'GIFA/resources/GIFA-Updater.exe';
  const caseEntry = 'GIFA/resources/case-B.bin';
  const traversal = '../../escape.bin';
  const nameless = 'GIFA/resources/' + 'x'.repeat(traversal.length);
  const copies = {
    prefix: zip => replaceName(zip, 'GIFA/', 'XXXX/'),
    traversal: zip => replaceName(zip, nameless, 'GIFA/resources/' + traversal),
    'case-collision': zip => replaceName(zip, caseEntry, 'GIFA/resources/CASE-a.bin'),
    'reserved-device': zip => replaceName(zip, caseEntry, 'GIFA/resources/CON.aa.bin'),
    'trailing-dot': zip => replaceName(zip, caseEntry, 'GIFA/resources/case-B.bi.'),
    'short-name': zip => replaceName(zip, caseEntry, 'GIFA/resources/CASET~.bin'),
    'alternate-stream': zip => replaceName(zip, caseEntry, 'GIFA/resources/case:B.bin'),
    'unexpected-root': zip => replaceName(zip, 'GIFA/ffmpeg.dll', 'GIFA/random.dll'),
    'untrusted-data': zip => replaceName(zip, caseEntry, 'GIFA/data/case-B-file.bin'),
    'local-name-conflict': zip => { zip[zipMember(zip, member).local + 30] = 88; },
    'symlink-mode': zip => { zip.writeUInt32LE(0xa1ff0000, zipMember(zip, caseEntry).central + 38); },
    reparse: zip => { zip.writeUInt32LE(0x400, zipMember(zip, caseEntry).central + 38); },
    'crc-conflict': zip => {
      const info = zipMember(zip, member);
      const incorrect = (zip.readUInt32LE(info.central + 16) ^ 1) >>> 0;
      zip.writeUInt32LE(incorrect, info.central + 16);
      zip.writeUInt32LE(incorrect, info.descriptor + 4);
    },
  };
  for (const [name, mutate] of Object.entries(copies)) {
    const candidate = Buffer.from(pristine);
    mutate(candidate);
    write(root, `unsafe-${name}.zip`, candidate);
  }
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') {
    console.log('Skip native updater tests: Windows x64 required.');
    return;
  }
  const { compileUpdateHelper } = require('./build-update-helper');
  const temp = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temp, 'gifa-native-update-fixtures-'));
  const assertTemporaryRoot = () => {
    assert.equal(path.dirname(root), temp);
    assert.match(path.basename(root), /^gifa-native-update-fixtures-[a-z0-9]{6}$/i);
    assert(fs.lstatSync(root).isDirectory() && !fs.lstatSync(root).isSymbolicLink());
    assert.equal(fs.realpathSync(root), root);
  };
  assertTemporaryRoot();
  try {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const harness = compileUpdateHelper(fixturePath(root, 'UpdateHelperTests.exe'), publicKey,
      { entryPoint: 'UpdateHelperTests', sourceFiles: [path.join(__dirname, 'UpdateHelperTests.cs')], target: 'exe' });
    if (process.argv.length > 2) {
      assert(process.argv.length === 4 && process.argv[2] === '--verify-zip', 'Expected --verify-zip <package.zip>');
      const extracted = fixturePath(root, 'real-package');
      fs.mkdirSync(extracted);
      execFileSync(harness, ['--verify-zip', fs.realpathSync(process.argv[3]), extracted], { stdio: 'inherit', windowsHide: true, timeout: 120000 });
      return;
    }
    const unsigned = compileUpdateHelper(fixturePath(root, 'GIFA-Updater.exe'));
    const blocked = spawnSync(unsigned, ['--apply', 'portable', root, String(process.pid), '0.2.7', 'manifest.json', 'asset.zip'],
      { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    assert.ifError(blocked.error);
    assert.equal(blocked.status, 1, 'production unsigned binary must fail closed');
    assert.match(blocked.stderr, /^GIFA_UPDATE_ERROR NO_KEY\r?\n$/);

    const incoming = fixturePath(root, 'incoming');
    fs.mkdirSync(incoming);
    for (const runtimeFile of roots) write(incoming, runtimeFile, 'new runtime ' + runtimeFile);
    for (const member of ['locales/en-US.pak', 'locales/zh-CN.pak', 'resources/GIFA-Updater.exe', 'resources/GIFA.Gamepad.exe',
      'resources/licenses/说明.txt', 'resources/case-A.bin', 'resources/case-B.bin', 'resources/' + 'x'.repeat('../../escape.bin'.length)]) {
      write(incoming, member, 'new member ' + member);
    }
    write(incoming, 'portable.flag', 'portable\n绿色版数据保留\n');
    write(incoming, 'resources/app.asar', 'new asar');
    fs.mkdirSync(fixturePath(incoming, 'data'));
    fs.copyFileSync(harness, fixturePath(incoming, 'GIFA.exe'));
    await createZip(incoming, fixturePath(root, portableName), { prefix: 'GIFA' });
    const zip = fs.readFileSync(fixturePath(root, portableName));
    const setup = Buffer.from('test fixture; never executed as a setup');
    write(root, setupName, setup);
    manifests(root, zip, setup, privateKey);
    const corrupted = Buffer.from(zip);
    corrupted[0] ^= 1;
    write(root, 'bad-hash.zip', corrupted);
    write(root, 'bad-size.zip', zip.subarray(1));
    badZips(root, zip);
    const outside = path.dirname(write(root, 'outside/kept.txt', 'outside'));
    fs.symlinkSync(outside, fixturePath(root, 'linked-folder'), 'junction');
    fs.linkSync(write(root, 'hardlink-source', 'source'), fixturePath(root, 'linked-file'));
    execFileSync(harness, [root], { stdio: 'inherit', windowsHide: true, timeout: 45000 });
  } finally {
    assertTemporaryRoot();
    const junction = fixturePath(root, 'linked-folder');
    if (fs.lstatSync(junction, { throwIfNoEntry: false })) {
      assert(fs.lstatSync(junction).isSymbolicLink());
      assert.equal(fs.realpathSync(junction), fixturePath(root, 'outside'));
      fs.unlinkSync(junction);
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
