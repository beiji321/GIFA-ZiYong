'use strict';

/**
 * 放大提醒窗。
 *
 * 显示的是**实时画面**：主进程给一个屏幕捕获源（screen sourceId）和
 * 要显示的区域（叠加层底下那块，也就是游戏小地图），这里把那一块
 * 从屏幕流里抠出来画到 canvas 上。
 *
 * 捕获只在窗口可见时进行 —— 常驻捕获会跟游戏抢合成资源，明显掉帧。
 * 收起时停流，canvas 保留最后一帧，下次点亮立刻有画面，
 * 流在后台重连（约 200ms）之后画面恢复动态。
 */

const box = document.getElementById('box');
const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');

/** 隐藏的 video：屏幕流的载体，不参与布局 */
const video = document.createElement('video');
video.muted = true;
video.autoplay = true;
video.playsInline = true;
video.style.display = 'none';
document.body.appendChild(video);

let cfgCache = null;    // 主进程下发的 { sourceId, region, screen }
let raf = 0;
let fadeTimer = 0;

function stopLoop() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

function paint() {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  const region = cfgCache && cfgCache.region;
  const screenSize = cfgCache && cfgCache.screen;
  if (!region || !screenSize || !vw || !vh) return;

  // 流的分辨率和显示器 DIP 尺寸不一定相等（高 DPI / 缩放），按比例换算
  const sx = (region.x / Math.max(1, screenSize.width)) * vw;
  const sy = (region.y / Math.max(1, screenSize.height)) * vh;
  const sw = (region.size / Math.max(1, screenSize.width)) * vw;
  const sh = (region.size / Math.max(1, screenSize.height)) * vh;

  const side = Math.max(1, Math.round(region.size));
  if (cv.width !== side || cv.height !== side) {
    cv.width = side;
    cv.height = side;
  }

  try {
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
  } catch {
    /* 流还没就绪，下一帧再来 */
  }
}

function loop() {
  raf = 0;
  paint();
  raf = requestAnimationFrame(loop);
}

function startLoop() {
  if (!raf) raf = requestAnimationFrame(loop);
}

function stopStream() {
  const stream = video.srcObject;
  if (!stream) return;
  try {
    for (const track of stream.getTracks()) track.stop();
  } catch {
    /* 已经停了 */
  }
  video.srcObject = null;
}

async function startStream() {
  if (video.srcObject || !cfgCache || !cfgCache.sourceId) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: cfgCache.sourceId,
          /* 上限 1080p / 10fps：
           * 游戏小地图变化很慢，10fps 完全够用；
           * 30fps 4K 的捕获能吃掉好几个百分点 CPU。 */
          maxWidth: 1920,
          maxHeight: 1080,
          maxFrameRate: 10
        }
      }
    });
    video.srcObject = stream;
    await video.play();
    paint();
  } catch (err) {
    console.warn('[alert] 屏幕流启动失败：', err && err.message);
  }
}

/** 主进程下发的捕获源与区域 */
window.alertApi.onStream((cfg) => {
  const c = cfg || {};
  if (!c.sourceId) return;
  cfgCache = c;

  const side = Math.max(1, Math.round((c.region && c.region.size) || 260));
  if (cv.width !== side || cv.height !== side) {
    cv.width = side;
    cv.height = side;
  }

  // 正在显示（或有画面）时才维持流；收起状态不占资源
  if (box.classList.contains('show')) {
    startLoop();
    startStream();
  }
});

/** 方向来了：亮起来，到点淡出 */
window.alertApi.onShow((payload) => {
  const p = payload || {};

  // 立刻亮：canvas 里还留着上一帧，先给画面，流随后再接上
  box.classList.remove('fade');
  void box.offsetWidth;
  box.classList.add('show');

  startLoop();
  startStream();

  clearTimeout(fadeTimer);
  const hold = Number(p.hold) > 0 ? Number(p.hold) : 3200;
  fadeTimer = setTimeout(() => {
    box.classList.remove('show');
    box.classList.add('fade');
    // 淡出结束：停绘制、停捕获。捕获是最贵的一环，不可见时完全不该跑。
    setTimeout(() => {
      stopLoop();
      stopStream();
    }, 200);
  }, hold);
});

window.alertApi.onPlacing((on) => {
  document.body.classList.toggle('placing', !!on);
  if (on) {
    box.classList.remove('fade');
    box.classList.add('show');
    startLoop();
    startStream();
  }
});
