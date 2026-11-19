'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { FIXTURES, assertExternalPath } = require('../material-paths');
const { readSrc, loadAnalyzer, ad } = require('./cone-lab');

const src = readSrc();
const analyzeCone = loadAnalyzer(src);
const arrowCode = src.slice(src.indexOf('function cyanScore('), src.indexOf('/* ---------------------------------------------------------------- 扇形通道'));
const recoveryCode = src.slice(src.indexOf('function centeredPatch('), src.indexOf('function tickBearing('));
const gate = src.match(/^const MAP_CYAN_FRAC_MIN = .*;$/m)[0];
const { analyze, analyzeArrowWithRecovery, analyzeConeWithRecovery } = new Function('analyzeCone',
  `const BEARING = {};\n${gate}\n${arrowCode}\n${recoveryCode}\nreturn { analyze, analyzeArrowWithRecovery, analyzeConeWithRecovery };`)(analyzeCone);
const sampleDir = assertExternalPath(process.env.GIFA_SNOW_SAMPLES || path.join(FIXTURES, 'snow-40853573523'));

function snowFrame(size, ground, axis, seed) {
  const data = new Uint8ClampedArray(size * size * 4);
  const center = (size - 1) / 2;
  for (let row = 0; row < size; row += 1) {
    for (let col = 0; col < size; col += 1) {
      const dx = col - center;
      const dy = center - row;
      const radius = Math.hypot(dx, dy);
      const degree = Math.atan2(dy, dx) * 180 / Math.PI;
      const alpha = axis !== null && ad(degree, axis) < 45 ? 0.4 * (1 - radius / (size / 1.5)) : 0;
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const noise = (seed >>> 30) - 1;
      const offset = (row * size + col) * 4;
      for (let channel = 0; channel < 3; channel += 1) {
        data[offset + channel] = radius < size * 0.06 ? [34, 200, 232][channel]
          : ground[channel] + alpha * (255 - ground[channel]) + noise;
      }
      data[offset + 3] = 255;
    }
  }
  return { data, width: size, height: size };
}

let generated = 0;
for (const size of [165, 363]) {
  const step = size > 320 ? 2 : 1;
  for (const ground of [[238, 239, 242], [241, 241, 241], [244, 244, 244]]) {
    for (const axis of [23, 70, 147, 218, 302]) {
      const result = analyzeCone(snowFrame(size, ground, axis, 614), size, step);
      assert.ok(result.valid && ad(result.deg, axis) <= 6, `near-white ${size}/${ground}/${axis}: ${JSON.stringify(result)}`);
      generated += 1;
    }
    assert.equal(analyzeCone(snowFrame(size, ground, null, 735), size, step).valid, false, 'near-white without cone');
    generated += 1;
  }
  assert.equal(analyzeCone(snowFrame(size, [255, 255, 255], 70, 981), size, step).valid, false, 'clipped white');
  generated += 1;
}
console.log(`PASS synthetic near-white: ${generated} scenarios`);

if (!fs.existsSync(path.join(sampleDir, 'map-036.rgba'))) {
  if (process.env.GIFA_SNOW_SAMPLES) throw new Error(`缺少雪地实拍样本：${sampleDir}`);
  console.log(`SKIP snow video fixtures: ${sampleDir}`);
  process.exit(0);
}

function load(time, width) {
  const file = path.join(sampleDir, `map-${String(time).padStart(3, '0')}.rgba`);
  const rgba = fs.readFileSync(file);
  assert.equal(rgba.length, 580 * 564 * 4, `unexpected fixture size: ${time}s`);
  const data = new Uint8ClampedArray(width * width * 4);
  const left = Math.round(283 - width / 2);
  const top = Math.round(264 - width / 2);
  for (let row = 0; row < width; row += 1) {
    const start = ((top + row) * 580 + left) * 4;
    data.set(rgba.subarray(start, start + width * 4), row * width * 4);
  }
  return { data, width, height: width };
}

const coneTruth = { 120: 34, 144: 28, 156: 53, 252: 318, 264: 305, 300: 271, 384: 45, 396: 10, 408: 30, 540: 193, 552: 102, 708: 227 };
for (const [time, truth] of Object.entries(coneTruth)) {
  const img = load(time, 414);
  const base = analyzeCone(img, 414, 2);
  const result = analyzeConeWithRecovery(img, 414, 2);
  assert.ok(result.valid && ad(result.deg, truth) <= 12, `cone ${time}s: ${result.deg} vs ~${truth}`);
  console.log(`PASS cone ${time}s ~${truth}°: ${base.deg.toFixed(1)}° -> ${result.deg.toFixed(1)}°`);
}
const arrowTruth = { 36: 235, 144: 26, 264: 277, 300: 260, 540: 192, 552: 107 };
for (const [time, truth] of Object.entries(arrowTruth)) {
  const img = load(time, 171);
  const base = analyze(img, 171, 1);
  const result = analyzeArrowWithRecovery(img, 171, 1);
  assert.ok(result.valid && ad(result.angle, truth) <= 12, `arrow ${time}s: ${result.angle} vs ~${truth}`);
  console.log(`PASS arrow ${time}s ~${truth}°: ${base.valid ? base.angle.toFixed(1) + '°' : 'miss'} -> ${result.angle.toFixed(1)}°`);
}
for (const time of [420, 835]) {
  const arrow = analyzeArrowWithRecovery(load(time, 171), 171, 1);
  const cone = analyzeConeWithRecovery(load(time, 414), 414, 2);
  assert.equal(arrow.valid, false, `non-map arrow ${time}s`);
  assert.ok(!cone.valid || cone.cyanFrac < 0.0015, `non-map cone ${time}s`);
  console.log(`PASS non-map ${time}s rejected`);
}
