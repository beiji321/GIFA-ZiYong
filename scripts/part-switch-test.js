'use strict';

/* 自动连播换 P 的离线回归：只做源码结构校验，不启动 Electron。
 *
 * 背景：自动连播是访客页自己跳 URL，主进程只收到一个新的分 P 号。
 * 曾经这里只改了界面上的 p，没动主进程里的 cid，
 * 结果全屏弹幕一直放上一 P 的（手动切 P 走 bili:load，看不出来）。
 *
 * 这条链路有四个点，断任何一个都会复发，所以逐个盯住：
 *   访客导航 → 渲染层 syncPartFromGuest → setCurrentPart → window.api.part
 *            → preload 的 'bili:part' → 主进程 handler → switchPartData
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const mainSource = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'src', 'preload.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(root, 'src', 'renderer', 'app.js'), 'utf8');

let passed = 0;
const failures = [];

function check(name, run) {
  try {
    run();
    passed += 1;
    console.log('PASS ' + name);
  } catch (err) {
    failures.push(name);
    console.log('FAIL ' + name);
    console.log(String((err && err.message) || err).split('\n').map((l) => '    ' + l).join('\n'));
  }
}

/** 取出某个函数体，找不到就报错 */
function bodyOf(source, signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, '找不到 ' + signature);
  return source.slice(start, start + 4000);
}

check('主进程只在 bili:part 里按新的分 P 换 cid', () => {
  assert.match(mainSource, /ipcMain\.handle\('bili:part'/, '缺少 bili:part 处理器');
  const handler = bodyOf(mainSource, "ipcMain.handle('bili:part'");
  assert.match(handler, /switchPartData\(/, 'bili:part 没有调用 switchPartData');
  assert.match(handler, /currentPages\.find/, 'bili:part 没有从分 P 列表里查 cid');
});

check('bili:load 与 bili:part 共用同一条换 P 数据清理', () => {
  const load = bodyOf(mainSource, "ipcMain.handle('bili:load'");
  assert.match(load, /switchPartData\(/, 'bili:load 没有调用 switchPartData');
  // 清空弹幕列表的地方只能有一处，否则两条路会慢慢走偏
  // （danmakuSentAt 另有 seek 时的正常重置，不在此列）
  assert.equal(
    (mainSource.match(/^\s+danmakuList = \[\];/gm) || []).length,
    1,
    '弹幕清理逻辑散落成了多份'
  );
  assert.equal((mainSource.match(/function switchPartData/g) || []).length, 1, 'switchPartData 重复定义');
});

check('switchPartData 会清掉上一 P 的弹幕和字幕', () => {
  const fn = bodyOf(mainSource, 'function switchPartData');
  for (const token of ['danmakuCid = 0', 'danmakuList = []', 'subtitleCues = []', 'subtitleGen += 1']) {
    assert.ok(fn.includes(token), 'switchPartData 少了 ' + token);
  }
  assert.match(fn, /fetchDanmakuList\(cid\)/, 'switchPartData 没有按新 cid 重拉弹幕');
  assert.match(fn, /fetchSubtitleCues\(id, cid, gen\)/, 'switchPartData 没有按新 cid 重拉字幕');
});

check('cid 相同不重复清理，避免心跳回调把弹幕刷没', () => {
  const handler = bodyOf(mainSource, "ipcMain.handle('bili:part'");
  assert.match(handler, /cid === currentCid/, '缺少 cid 去重');
  assert.match(handler, /unchanged/, '缺少 unchanged 短路返回');
});

check('preload 把 part 转发到 bili:part', () => {
  assert.match(preloadSource, /part:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('bili:part'/, 'preload 没有暴露 part');
});

check('渲染层切分 P 时会通知主进程', () => {
  const fn = bodyOf(rendererSource, 'function setCurrentPart');
  assert.match(fn, /window\.api\.part\(/, 'setCurrentPart 没有调用 api.part');
  // 必须是在 auto 分支里，手动切 P 走 bili:load，重复调用会把弹幕清两遍
  const autoAt = fn.indexOf('if (!auto) return;');
  const callAt = fn.indexOf('window.api.part(');
  assert.ok(autoAt !== -1 && callAt > autoAt, 'api.part 不在自动分支里');
});

check('访客导航与心跳两条自动连播通道都汇到 setCurrentPart', () => {
  assert.match(rendererSource, /addEventListener\('did-navigate-in-page', onNav\)/, '缺少 SPA 导航监听');
  assert.match(rendererSource, /addEventListener\('did-navigate', onNav\)/, '缺少整页跳转监听');
  const applyState = bodyOf(rendererSource, 'function applyState');
  assert.match(applyState, /syncPartFromGuest\(v, true\)/, '心跳没有校准分 P');
  const sync = bodyOf(rendererSource, 'function syncPartFromGuest');
  assert.match(sync, /setCurrentPart\(n, true\)/, 'syncPartFromGuest 没有落到 setCurrentPart');
});

const total = passed + failures.length;
console.log('\npart-switch: ' + passed + ' PASS / ' + failures.length + ' FAIL');
if (failures.length) process.exitCode = 1;
