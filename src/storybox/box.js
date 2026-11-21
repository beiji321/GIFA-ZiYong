'use strict';

/* 识别结果遮罩：在主屏上画两个框
 *   黄框  当前识别的区域（游戏窗口左上角 1/3 × 1/8）
 *   红框  模板实际匹配到位置，旁边跟一个分数
 *
 * 参考 BetterGI 的「识别结果遮罩」：排查时能直接看到程序在看哪儿、
 * 匹配落在哪儿，比翻日志快得多。
 *
 * 这一层是纯展示：鼠标穿透、不抢焦点、不参与任何点击。
 */

const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');

let last = null;
let flashAt = 0;

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  cv.style.width = w + 'px';
  cv.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function strokeBox(rect, color, width, label) {
  if (!rect || rect.w <= 0 || rect.h <= 0) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash([]);
  ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w, rect.h);

  if (label) {
    ctx.font = '600 13px "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';
    const padX = 6;
    const tw = ctx.measureText(label).width;
    const th = 20;
    // 标签放在框上方；顶到屏幕外就放进框里
    let ly = rect.y - th - 2;
    if (ly < 2) ly = rect.y + 2;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
    ctx.fillRect(rect.x, ly, tw + padX * 2, th);
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.fillText(label, rect.x + padX, ly + th / 2);
  }
  ctx.restore();
}

function draw() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  ctx.clearRect(0, 0, w, h);
  if (!last || !last.found) return;

  // 识别区域
  strokeBox(last.roi, 'rgba(255, 210, 60, 0.9)', 1.5, '识别区域');

  // 命中位置：超过阈值用红色，否则用浅蓝，一眼能看出「差多少」
  if (last.hit) {
    const hit = !!last.hitHit;
    strokeBox(
      last.hit,
      hit ? 'rgba(255, 60, 60, 0.95)' : 'rgba(120, 200, 255, 0.85)',
      hit ? 2 : 1.5,
      `score ${last.score.toFixed(3)}`
    );
  }
}

window.boxApi.onDraw((data) => {
  last = data;
  draw();
});

window.addEventListener('resize', resize);
resize();
