'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

// 通过真实 IPC 接收回调驱动两路补间，以画布清屏次数统计完整重绘。
function overlay() {
  const frames = new Map();
  let next = 0;
  let draws = 0;
  let receive;
  const gradient = () => ({ addColorStop() {} });
  const context = new Proxy({
    clearRect() { draws++; }, createRadialGradient: gradient, createLinearGradient: gradient
  }, { get: (ctx, name) => ctx[name] ?? (() => {}) });
  const canvas = { style: {}, getContext: () => context };
  const world = vm.createContext({
    window: { innerWidth: 240, innerHeight: 240, addEventListener() {}, overlayApi: {
      onBearing(callback) { receive = callback; }, onMode() {}
    } },
    document: { getElementById: () => canvas },
    requestAnimationFrame(callback) { frames.set(++next, callback); return next; },
    cancelAnimationFrame(id) { frames.delete(id); }, setTimeout() {}, clearTimeout() {}
  });
  const source = fs.readFileSync(path.join(__dirname, '../src/overlay/overlay.js'), 'utf8');
  vm.runInContext(source, world);
  return { receive, draws: () => draws, pending: () => frames.size, angle: key => vm.runInContext(`tween.${key}.shown`, world),
    frame() { const callbacks = [...frames.values()]; frames.clear(); for (const callback of callbacks) callback(); }
  };
}

test('箭头和视角各走原有的补间步长，两者同动时每个显示帧只重绘一次', () => {
  const app = overlay();
  app.receive({ angle: 350, view: 10 });
  app.receive({ angle: 10, view: 350 });
  const initial = app.draws();
  app.frame();
  assert.equal(app.angle('arrow'), 359);
  assert.equal(app.angle('view'), 1);
  assert.equal(app.draws(), initial + 1);
  assert.equal(app.pending(), 1);
  app.receive({ clearAngle: true, view: 340 });
  app.frame();
  assert.equal(app.angle('arrow'), null);
  assert.ok(app.angle('view') > 340);
  for (let i = 0; i < 20; i++) app.frame();
  assert.equal(app.angle('view'), 340);
  assert.equal(app.pending(), 0);
  app.receive({ angle: 20, view: 150 });
  assert.equal(app.angle('view'), 150);
  app.receive({ angle: 22, view: 151 });
  app.receive({ clear: true });
  assert.equal(app.angle('view'), null);
  assert.equal(app.angle('arrow'), null);
  assert.equal(app.pending(), 0);
});
