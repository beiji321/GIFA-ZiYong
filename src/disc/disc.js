'use strict';

/**
 * 八方向圆盘浮窗渲染层。没有动画循环 —— 主进程只在状态变化时发一帧，
 * 平时这个窗根本不可见（L3 松开就 hide），常驻 rAF 只会白烧 CPU。
 *
 * 画法本身在 disc-draw.js，和启动器里的参考图共用。
 */

const { drawDisc } = window.GdiscDraw;

const canvas = document.getElementById('disc');
const ctx = canvas.getContext('2d');
let state = { highlight: '', labels: {}, hold: false };

function setup() {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, window.innerWidth);
  const h = Math.max(1, window.innerHeight);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function draw() {
  drawDisc(ctx, {
    width: window.innerWidth,
    height: window.innerHeight,
    highlight: state.highlight,
    labels: state.labels,
    hold: state.hold
  });
}

window.discApi.onState((payload) => {
  if (!payload) return;
  state = {
    highlight: typeof payload.highlight === 'string' ? payload.highlight : '',
    labels: payload.labels && typeof payload.labels === 'object' ? payload.labels : state.labels,
    hold: !!payload.hold
  };
  draw();
});

window.addEventListener('resize', setup);
setup();
