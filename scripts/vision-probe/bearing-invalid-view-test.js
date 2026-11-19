'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../../src/webview-preload.js'), 'utf8').replace(/\r\n/g, '\n');
const start = source.indexOf('function markInvalid(');
const end = source.indexOf('\nfunction tickBearing(', start);
const code = source.slice(start, end);
const sent = [];
const BEARING = {
  raw: [], smooth: 12, ab: { theta: 12, omega: 4, suspect: 0 }, lastAngle: 12,
  invalidSince: 0, reportedValid: true, lastSentAt: 0, view: { sent: 30 }
};
const ipcRenderer = { sendToHost: (_channel, payload) => sent.push(payload) };
const angDiff = (a, b) => ((a - b + 540) % 360) - 180;
const Date = class extends globalThis.Date { static now() { return 1000; } };
new Function('BEARING', 'ipcRenderer', 'Date', 'angDiff', code)(BEARING, ipcRenderer, Date, angDiff);
BEARING.invalidSince = 0;
const markInvalid = new Function('BEARING', 'ipcRenderer', 'Date', 'angDiff', `${code}; return markInvalid;`)(BEARING, ipcRenderer, Date, angDiff);
markInvalid('箭头暂时丢失', { view: 70, viewConfidence: 0.8, viewSource: 'cone' });
assert.equal(sent.length, 1);
assert.equal(sent[0].angle, null);
assert.equal(sent[0].view, 70);
assert.equal(sent[0].reason, undefined);
console.log('PASS 箭头漏检时视角独立上报');
markInvalid('箭头暂时丢失', { view: 60, viewConfidence: 0.7, viewSource: 'hold' });
assert.equal(sent.length, 1);
console.log('PASS 相同视角不重复上报');
