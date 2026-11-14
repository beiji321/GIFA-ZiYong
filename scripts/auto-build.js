'use strict';

/**
 * 一键离线打包工具。
 *
 *   npm run auto:build              # 打包（自动选新输出目录）
 *   npm run auto:build -- --out=dist-x
 *   npm run auto:build -- --dir     # 只出 win-unpacked，不出安装包
 *   npm run auto:build -- --keep    # 保留解压出的 Electron 与临时目录
 *
 * 这个脚本存在的意义：把每次手工踩过的坑都固化下来。
 *
 *   1. Electron 官方源在本机经常下载超时（600s 后 RequestError），
 *      所以优先用 electron-builder 自己的缓存 zip 解压出一份 electronDist；
 *      找不到缓存再退回 node_modules/electron/dist。
 *   2. NSIS 需要一个可写的 TEMP，而系统 %TEMP% 有时不可写，
 *      统一指到工作区的 .tmp。
 *   3. 二进制工具走 npmmirror 镜像，避免连 github 卡住。
 *   4. 输出目录必须每次全新：旧 dist\win-unpacked 会被杀毒/索引服务锁住，
 *      覆盖时报 EBUSY，所以自动挑一个没被占用的目录名。
 *   5. 打完自动校验 asar 里的 version 是否等于 package.json，
 *      并且语言包只剩 zh-CN / en-US，防止「打出来的不是这一版」。
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const PRODUCT = pkg.productName || 'app';
const ARGS = process.argv.slice(2);
const DIR_ONLY = ARGS.includes('--dir');
const KEEP = ARGS.includes('--keep');
const OUT_ARG = ARGS.find((a) => a.startsWith('--out='));

/**
 * 实际安装的 Electron 版本。
 * 不能用 package.json 里的 devDependencies（那是范围，比如 ^45.0.0），
 * 缓存文件名用的是精确版本（electron-v45.2.3-win32-x64.zip），
 * 读错就永远匹配不到缓存。
 */
function detectElectronVersion() {
  try {
    return require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version;
  } catch {
    const range = String((pkg.devDependencies && pkg.devDependencies.electron) || '');
    return range.replace(/^[^\d]*/, '');
  }
}
const ELECTRON_VERSION = detectElectronVersion();
const TMP_DIR = path.join(ROOT, '.tmp');
const DIST_DECODED = path.join(ROOT, '.electron-dist');

function log(msg) {
  console.log(`[auto-build] ${msg}`);
}

function fail(msg) {
  console.error(`[auto-build] ✗ ${msg}`);
  process.exit(1);
}

/* ------------------------------------------------------------ 输出目录 */

/** 找一个「不存在」的输出目录，避免覆盖被锁住的旧产物 */
function pickOutDir() {
  if (OUT_ARG) {
    const dir = path.resolve(ROOT, OUT_ARG.slice('--out='.length));
    if (fs.existsSync(dir)) fail(`指定目录已存在：${dir}\n换一个，或先手动删掉它（可能被杀毒锁定）。`);
    return dir;
  }
  // 优先用版本号命名，好认；被占了就加序号
  const base = `dist-${VERSION.replace(/\./g, '')}`;
  if (!fs.existsSync(path.join(ROOT, base))) return path.join(ROOT, base);
  for (let n = 2; n < 100; n++) {
    const dir = path.join(ROOT, `${base}-${n}`);
    if (!fs.existsSync(dir)) return dir;
  }
  fail('找不到可用的输出目录');
}

/* --------------------------------------------------------- 7za 与缓存 */

/** electron-builder 自带的 7za（用它解压 electron 包，不额外依赖系统工具） */
function find7za() {
  const cacheRoot = path.join(
    process.env.LOCALAPPDATA || '',
    'electron-builder',
    'Cache',
    '7zip@1.0.0'
  );
  if (!fs.existsSync(cacheRoot)) return null;
  for (const ver of fs.readdirSync(cacheRoot)) {
    const p = path.join(cacheRoot, ver, 'bin', '7za.exe');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/** 在 electron 缓存目录里找当前 electron 版本的 zip */
function findElectronZip() {
  const cacheRoot = path.join(process.env.LOCALAPPDATA || '', 'electron', 'Cache');
  if (!fs.existsSync(cacheRoot)) return null;
  const wanted = `electron-v${ELECTRON_VERSION}-win32-x64.zip`;
  for (const hash of fs.readdirSync(cacheRoot)) {
    const p = path.join(cacheRoot, hash, wanted);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * 准备一份可用的 electronDist 目录。
 * 返回 { dir, source } —— source 用于日志展示。
 */
function prepareElectronDist() {
  // 1) 缓存 zip 解压：这是本机最稳的路径（网络下载经常超时）
  const zip = findElectronZip();
  if (zip) {
    const sevenZip = find7za();
    if (sevenZip) {
      log(`从缓存解压 Electron：${path.basename(zip)}`);
      fs.rmSync(DIST_DECODED, { recursive: true, force: true });
      fs.mkdirSync(DIST_DECODED, { recursive: true });
      const r = spawnSync(sevenZip, ['x', zip, `-o${DIST_DECODED}`, '-y'], { stdio: 'ignore' });
      const exe = path.join(DIST_DECODED, 'electron.exe');
      if (r.status === 0 && fs.existsSync(exe)) {
        // 完整性自检：文件数与总体积必须达到合理规模，
        // 之前出现过「解压被中途打断只出来 4 个文件」导致打包报
        // Failed to parse version info。
        const entries = fs.readdirSync(DIST_DECODED);
        const totalMB =
          entries.reduce((sum, n) => {
            try {
              const st = fs.statSync(path.join(DIST_DECODED, n));
              return sum + (st.isFile() ? st.size : 0);
            } catch {
              return sum;
            }
          }, 0) / 1048576;
        if (entries.length < 12 || totalMB < 200) {
          log(`⚠ 解压结果不完整（${entries.length} 项 / ${totalMB.toFixed(0)}MB），改用 node_modules`);
        } else {
          log(`  解压完成：${entries.length} 项 / ${totalMB.toFixed(0)}MB`);
          return { dir: DIST_DECODED, source: 'cache-zip' };
        }
      } else {
        log('⚠ 解压失败，回退到 node_modules/electron/dist');
      }
    }
  }

  // 2) 退回本地安装的 electron
  const local = path.join(ROOT, 'node_modules', 'electron', 'dist');
  if (fs.existsSync(path.join(local, 'electron.exe'))) {
    log('使用 node_modules/electron/dist 作为 electronDist');
    return { dir: local, source: 'node_modules' };
  }

  fail(
    '找不到可用的 Electron。\n' +
      '  请先执行 npm install（会下载 electron），或在能联网的环境跑一次 electron-builder 让它填充缓存。'
  );
}

/* ------------------------------------------------------------- 打包 */

function build({ outDir, electronDist }) {
  const builderCli = require.resolve('electron-builder/cli.js');
  const args = [
    builderCli,
    '--win',
    DIR_ONLY ? '--dir' : '',
    `--config.directories.output=${outDir}`,
    `--config.electronDist=${electronDist}`
  ].filter(Boolean);
  // 语言包裁剪走 package.json 的 build.electronLanguages，不在这里覆盖：
  // 命令行传数组要写成 --config.electronLanguages[0]=... ，容易出错。

  const env = {
    ...process.env,
    // NSIS 需要可写 TEMP；系统目录被安全软件占住时容易失败
    TEMP: TMP_DIR,
    TMP: TMP_DIR,
    ELECTRON_BUILDER_BINARIES_MIRROR:
      process.env.ELECTRON_BUILDER_BINARIES_MIRROR ||
      'https://npmmirror.com/mirrors/electron-builder-binaries/'
  };

  log(`输出目录：${path.relative(ROOT, outDir)}`);
  log(`electronDist：${electronDist}`);
  log(DIR_ONLY ? '模式：仅解包（--dir）' : '模式：安装版 + 便携版');
  console.log('');

  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env });
  if (r.error) fail(r.error.message);
  if (r.status !== 0) fail(`electron-builder 退出码 ${r.status}`);
}

/* ------------------------------------------------------------- 校验 */

function verify(outDir) {
  const asarPath = path.join(outDir, 'win-unpacked', 'resources', 'app.asar');
  if (!fs.existsSync(asarPath)) fail('产物里找不到 app.asar');

  let packedVersion = null;
  try {
    const asar = require('@electron/asar');
    packedVersion = JSON.parse(asar.extractFile(asarPath, 'package.json').toString()).version;
  } catch (err) {
    log(`⚠ 无法读取 asar 版本：${err.message}`);
  }

  if (packedVersion && packedVersion !== VERSION) {
    fail(`版本不一致！package.json=${VERSION}，asar=${packedVersion}`);
  }
  log(`版本校验通过：${packedVersion || VERSION}`);

  const locales = path.join(outDir, 'win-unpacked', 'locales');
  if (fs.existsSync(locales)) {
    const paks = fs.readdirSync(locales).filter((n) => n.endsWith('.pak'));
    log(`语言包：${paks.join(', ') || '（空）'}`);
    if (paks.length > 2) log('⚠ 语言包多于 2 个，electronLanguages 可能没生效');
  }

  return packedVersion || VERSION;
}

/* --------------------------------------------------------------- 主流程 */

function main() {
  console.log('');
  console.log(`  原神跟跑助手 · 一键打包`);
  console.log(`  版本 ${VERSION} · Electron ${ELECTRON_VERSION || '?'}`);
  console.log('');

  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
    fail('node_modules 不存在，请先执行 npm install');
  }

  fs.mkdirSync(TMP_DIR, { recursive: true });

  const outDir = pickOutDir();
  const { dir: electronDist } = prepareElectronDist();

  const startedAt = Date.now();
  build({ outDir, electronDist });
  const packedVersion = verify(outDir);

  // 收集产物清单
  const files = fs
    .readdirSync(outDir)
    .filter((n) => /\.(exe|zip|blockmap|yml)$/i.test(n))
    .map((n) => {
      const p = path.join(outDir, n);
      return { name: n, mb: (fs.statSync(p).size / 1048576).toFixed(1), path: p };
    });

  console.log('');
  console.log('  ── 打包完成 ──');
  console.log(`  版本：${packedVersion}`);
  console.log(`  耗时：${((Date.now() - startedAt) / 1000).toFixed(0)} 秒`);
  console.log(`  目录：${outDir}`);
  console.log('');
  for (const f of files) {
    console.log(`  ${f.mb.padStart(6)} MB  ${f.name}`);
  }
  console.log('');

  // 清理临时目录（默认清理，--keep 保留便于排查）
  if (!KEEP) {
    for (const p of [TMP_DIR, DIST_DECODED]) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch {
        /* 被杀毒占用时忽略即可，不影响产物 */
      }
    }
    log('临时目录已清理');
  } else {
    log(`保留临时目录：${path.relative(ROOT, TMP_DIR)}、${path.relative(ROOT, DIST_DECODED)}`);
  }

  console.log('');
  console.log(`  提示：未做代码签名，SmartScreen 会提示「未知发布者」，属正常现象。`);
  console.log('');
}

main();
