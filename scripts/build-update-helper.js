'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createPublicKey } = require('node:crypto');
const { HELPER_NAME, KEY_NAME, keyParts, fromKeyParts } = require('../src/update-manifest');

const SOURCE = path.resolve(__dirname, '../native/Updater.cs');
const REFERENCES = ['System.dll', 'System.Core.dll', 'System.Web.Extensions.dll', 'System.Windows.Forms.dll', 'System.IO.Compression.dll', 'System.IO.Compression.FileSystem.dll'];

function compileUpdateHelper(output, key, { entryPoint, sourceFiles = [], target = 'winexe' } = {}) {
  if (process.platform !== 'win32') throw new Error('编译更新器需要 Windows 的 .NET Framework 4.x');
  const windows = process.env.SystemRoot || 'C:\\Windows';
  const compiler = path.join(windows, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  if (!fs.existsSync(compiler)) throw new Error('找不到 .NET Framework 4.x x64 编译器');
  const parts = key ? key.type ? keyParts(key) : key : { modulus: '', exponent: '' };
  if (key) fromKeyParts(parts);
  const dir = path.dirname(output);
  fs.mkdirSync(dir, { recursive: true });
  const staging = fs.mkdtempSync(path.join(dir, '.update-build-'));
  try {
    const keySource = path.join(staging, 'UpdateBuildKey.cs');
    fs.writeFileSync(keySource, `internal static class UpdateBuildKey { internal const string Modulus = "${parts.modulus}"; internal const string Exponent = "${parts.exponent}"; }\n`);
    const binary = path.join(staging, path.basename(output));
    const flags = ['/nologo', '/noconfig', `/target:${target}`, '/platform:x64', '/optimize+', '/debug-', '/codepage:65001', `/out:${binary}`,
      ...REFERENCES.map(assembly => `/reference:${assembly}`)];
    if (entryPoint) flags.push(`/main:${entryPoint}`);
    execFileSync(compiler, [...flags, SOURCE, keySource, ...sourceFiles], { windowsHide: true, stdio: 'inherit' });
    fs.renameSync(binary, output);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return output;
}

function readBuildKey(publicPemPath) {
  if (!publicPemPath) return null;
  const pem = fs.readFileSync(publicPemPath, 'utf8').trim();
  if (!/^-----BEGIN (?:RSA )?PUBLIC KEY-----\r?\n/.test(pem)) throw new Error('GIFA_UPDATE_PUBLIC_KEY 必须指向 RSA 公钥 PEM，不可传入私钥');
  return keyParts(createPublicKey(pem));
}

function buildUpdateHelper(resources, publicPemPath = process.env.GIFA_UPDATE_PUBLIC_KEY) {
  const key = readBuildKey(publicPemPath);
  const keyFile = path.join(resources, KEY_NAME);
  const existing = fs.lstatSync(keyFile, { throwIfNoEntry: false });
  const contents = key ? JSON.stringify(key) + '\n' : null;
  if (existing && (!existing.isFile() || !contents || fs.readFileSync(keyFile, 'utf8') !== contents)) {
    throw new Error('构建目录已有不同的更新公钥，请使用全新的输出目录');
  }
  const helper = compileUpdateHelper(path.join(resources, HELPER_NAME), key);
  if (contents && !existing) fs.writeFileSync(keyFile, contents, { flag: 'wx' });
  return helper;
}

module.exports = { compileUpdateHelper, buildUpdateHelper, readBuildKey };
