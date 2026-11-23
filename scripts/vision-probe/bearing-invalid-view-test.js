'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../../src/webview-preload.js'), 'utf8').replace(/\r\n/g, '\n');

/* markInvalid 会调用 sendBearing，sendBearing 又依赖 noteBearingResult /
 * bearingStats。三者都在源码里，且定义顺序是「后定义的覆盖先定义的」，
 * 所以必须一起抽出来，否则注入的函数根本不是文件里那一份。 */
function slice(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`源码锚点没找到：${startMarker}`);
  const end = endMarker ? source.indexOf(endMarker, start) : source.length;
  if (end <= start) throw new Error(`源码锚点没找到：${endMarker}`);
  return source.slice(start, end);
}

const markInvalidCode = slice('function markInvalid(', '\nfunction tickBearing(');
const noteBearingResultCode = slice('function noteBearingResult(', '\nfunction bearingStats(');
const bearingStatsCode = slice('function bearingStats(', '\nfunction sendBearing(');
/* sendBearing 是文件里最后一个函数，后面没有锚点，切到文件末尾。 */
const sendBearingCode = slice('function sendBearing(', null);

const sent = [];
const BEARING = {
  raw: [], smooth: 12, ab: { theta: 12, omega: 4, suspect: 0 }, lastAngle: 12,
  invalidSince: 0, reportedValid: true, lastSentAt: 0, view: { sent: 30 }
};
const BEARING_STATS = { ring: [], window: 60, total: 0, lastReason: '', lastOkAt: 0, lastBadAt: 0 };
const ipcRenderer = { sendToHost: (_channel, payload) => sent.push(payload) };
const angDiff = (a, b) => ((a - b + 540) % 360) - 180;
const Date = class extends globalThis.Date { static now() { return 1000; } };

const code = [noteBearingResultCode, bearingStatsCode, sendBearingCode, markInvalidCode].join('\n');
const markInvalid = new Function(
  'BEARING', 'BEARING_STATS', 'ipcRenderer', 'Date', 'angDiff',
  `${code}; return markInvalid;`
)(BEARING, BEARING_STATS, ipcRenderer, Date, angDiff);

BEARING.invalidSince = 0;
markInvalid('箭头暂时丢失', { view: 70, viewConfidence: 0.8, viewSource: 'cone' });
assert.equal(sent.length, 1);
assert.equal(sent[0].angle, null);
assert.equal(sent[0].view, 70);
assert.equal(sent[0].reason, undefined);
console.log('PASS 箭头漏检时视角独立上报');
markInvalid('箭头暂时丢失', { view: 60, viewConfidence: 0.7, viewSource: 'hold' });
assert.equal(sent.length, 1);
console.log('PASS 相同视角不重复上报');
