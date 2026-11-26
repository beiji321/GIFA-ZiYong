'use strict';

// 不依赖实拍素材。用排序与逐行复制的参考值，检查识别器读到的原始像素。
const assert = require('node:assert/strict');
const test = require('node:test');
const { readSrc } = require('./cone-lab');

const source = readSrc();
const start = source.indexOf('const BEARING = {');
const end = source.indexOf('function startBearingLoop()', start);
assert.ok(start >= 0 && end > start, '找不到方位识别模块');
const video = { videoWidth: 0, videoHeight: 0 };
const api = new Function('video', 'clamp', source.slice(start, end) + `
  return { cyanP99, centerWindow, cropCenterWindow, centeredPatch, analyzeArrowWithRecovery, analyzeConeWithRecovery };
`)(video, (n, lo, hi) => Math.min(hi, Math.max(lo, n)));

function image(width, height, color) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(color(x, y), (y * width + x) * 4);
  }
  return { data, width, height };
}

// 参考路径只读紧密的原始图，拷贝后可直接传给旧版或新版分析函数。
function copySquare(src, x, y, size) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let row = 0; row < size; row++) {
    const offset = ((y + row) * src.width + x) * 4;
    data.set(src.data.subarray(offset, offset + size * 4), row * size * 4);
  }
  return { data, width: size, height: size };
}

function sortedP99(img, step) {
  const scores = [];
  const stride = Math.max(step, 4);
  for (let y = 0; y < img.height; y += stride) {
    for (let x = 0; x < img.width; x += stride) {
      const i = (y * img.width + x) * 4;
      scores.push(Math.min(img.data[i + 1], img.data[i + 2]) - img.data[i]);
    }
  }
  scores.sort((a, b) => a - b);
  return scores[Math.floor(scores.length * 0.99)] ?? -Infinity;
}

function colors(x, y) {
  return [(x * 73 + y * 7) & 255, (x * 3 + y * 41) & 255, (x ^ (y * 17)) & 255, 255];
}

test('青色 p99 与精确排序一致，含极值、重复值、取整边界和缓存复用', () => {
  const histogram = new Uint32Array(511).fill(100);
  for (const size of [0, 1, 39, 40, 41, 64, 171, 320]) {
    for (const color of [colors, () => [255, 0, 0, 255], () => [0, 255, 255, 255],
      (x, y) => y === 0 && x < 4 ? [0, 255, 255, 255] : [42, 142, 143, 255]]) {
      const img = image(size, size, color);
      for (const step of [1, 2, 5]) {
        assert.equal(api.cyanP99(img, size, step, histogram), sortedP99(img, step), `size=${size}, step=${step}`);
      }
    }
  }
});

test('小窗和微移恢复窗使用同一批原始像素，覆盖奇偶尺寸和边缘布局', () => {
  video.videoWidth = 643;
  video.videoHeight = 535;
  const src = image(video.videoWidth, video.videoHeight, colors);
  for (const roi of [{ cx: 0.5, cy: 0.49, r: 0.45 }, { cx: 0.109, cy: 0.119, r: 0.25 }]) {
    const outer = api.centerWindow(roi, 1.5, 512);
    const big = { ...outer, img: copySquare(src, outer.sx, outer.sy, outer.size) };
    const inner = api.centerWindow(roi, 0.62, 320, -1, 2);
    const small = api.cropCenterWindow(big, roi, 0.62, 320, -1, 2);
    assert.ok(small);
    function check(patch, x, y) {
      const size = patch.width;
      const ref = copySquare(src, x, y, size);
      const stride = patch.stride ?? size * 4;
      const offset = patch.offset ?? 0;
      for (let row = 0; row < size; row++) {
        const begin = offset + row * stride;
        assert.deepEqual(patch.data.subarray(begin, begin + size * 4), ref.data.subarray(row * size * 4, (row + 1) * size * 4));
      }
      const step = size > 320 ? 2 : 1;
      assert.equal(api.cyanP99(patch, size, step, new Uint32Array(511)), sortedP99(ref, step));
      assert.deepEqual(api.analyzeArrowWithRecovery(patch, size, step), api.analyzeArrowWithRecovery(ref, size, step));
      assert.deepEqual(api.analyzeConeWithRecovery(patch, size, step), api.analyzeConeWithRecovery(ref, size, step));
    }
    check(small.img, inner.sx, inner.sy);
    const width = small.size - 9;
    const delta = Math.round((small.size - width) / 2);
    for (const [dx, dy] of [[-4, 3], [3, -4]]) {
      check(api.centeredPatch(small.img, small.size, width, dx, dy), inner.sx + delta + dx, inner.sy + delta + dy);
    }
    assert.equal(api.cropCenterWindow(big, { cx: 0.98, cy: 0.98, r: roi.r }), null);
  }
});

test('大窗隔点采样与近白背景复核使用局部坐标', () => {
  const full = 419;
  const size = 383;
  const dx = 3;
  const dy = -5;
  const x0 = (full - size) / 2 + dx;
  const y0 = (full - size) / 2 + dy;
  for (const pale of [false, true]) {
    const src = image(full, full, (x, y) => {
      if ((x - 130) ** 2 + (y - 150) ** 2 < 20 ** 2) return [25, 200, 232, 255];
      if ((x + 2 * y) % 53 < 3) return [255, 255, 255, 255];
      return pale ? [236, 242, 245, 255] : [70, 95, 105, 255];
    });
    const packed = copySquare(src, x0, y0, size);
    const patch = api.centeredPatch(src, full, size, dx, dy);
    const reference = api.analyzeConeWithRecovery(packed, size, 2);
    assert.ok(reference.cyanFrac > 0.0015, '让弱边缘样本进入短半径复核');
    assert.deepEqual(api.analyzeConeWithRecovery(patch, size, 2), reference);
  }
});
