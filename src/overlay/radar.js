'use strict';

/**
 * 方位标记叠加层。
 *
 * 画两个**独立**的量：
 *   · 红箭头   行进方向 —— 青色三角解出来的，人往哪走
 *   · 绿弧段   视角方向 —— 白色扇形（镜头视锥）解出来的，镜头朝哪看
 *
 * 这两者在原神里本来就能不一致：站着不动把鼠标往后拉，人没动、视角转了 180°。
 * 所以绝不能合成一个角度 —— 一旦合并，两种状态都会被对方带歪。各算各的、
 * 各补各的间、各画各的。
 *
 * 坐标约定：两者都是罗盘角（0°=北、顺时针），画到 canvas 上要减 90°。
 */

const cv = document.getElementById('cv');
const ctx = cv.getContext('2d');

let placing = false;

/* 两路角度各有一套补间状态，互不干扰 */
const tween = {
  arrow: { target: null, shown: null, raf: 0 },
  view: { target: null, shown: null, raf: 0, conf: 0, width: 0, at: 0 }
};

// 视觉常量：与浮窗的深色主题保持同一套红
const RED = '#ff2f2f';
const RED_DEEP = '#c4121d'; // 箭尾：往深处压一档，整支箭有「从暗到亮射出去」的方向感
const RED_TIP = '#ff5a48'; // 箭尖：略偏暖，最亮的一点落在指向上
const RED_SOFT = 'rgba(255, 47, 47, 0.72)';
const WHITE = 'rgba(255, 255, 255, 0.96)';
const GREEN = '#35d96b';
const GREEN_LIGHT = '#93f7b4'; // 弧内缘高光
const GREEN_DEEP = '#1fae52'; // 弧外缘
const GREEN_EDGE = 'rgba(4, 36, 17, 0.8)'; // 绿弧的暗描边
const SHADOW = 'rgba(0, 0, 0, 0.5)';

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/** 视角多久没更新就把绿弧收起来，避免画面里明明没视锥却挂一段假绿 */
const VIEW_STALE_MS = 1500;

function shortAngle(a, b) {
  return ((a - b + 540) % 360) - 180;
}

/* ---------------------------------------------------- 雷达圈 / 方位文字
 *
 * 美术风格取自参考项目 GenshinImpactVT（genshinimpactvt/compass.py）：
 * 它的高亮**不是实心扇形**，而是一个「环带 + 角度羽化」的光：
 *   · 径向渐变：0~58% 全透明，70% 起亮，**84% 处最亮（190/255）**，94% 回落到 165，边缘归零
 *     —— 所以看到的是一圈贴着边缘的光环，圆心区域始终干净
 *   · 再用锥形渐变做 DestinationIn 遮罩：±28° 实心、±42° 渐隐
 *     —— 得到「一段圆周被点亮」的效果，而不是一个点光源
 * 下面用 Canvas 的 radial/conic 渐变一比一复刻这两层，再加一层呼吸脉动。
 */
/* 高亮时长由主进程通过 radar:config 下发（见 pushRadarConfig）。
 * 放大提醒窗要和雷达同亮同灭，两边必须是同一份数值 ——
 * 各写一个常量迟早对不上，所以这里只留默认值兜底。 */
const CUE_HOLD_DEFAULT = 3200;
const CUE_FADE_DEFAULT = 450;

const RADAR = {
  /** 标定圆半径（视频坐标系里的逻辑值），0 表示还没标定 */
  radius: 0,
  /** 标定过才显示雷达圈与方位文字 */
  visible: false,
  /** 当前被字幕点亮的方位（罗盘角），-1 表示没有 */
  cueDeg: -1,
  cueLabel: '',
  /** 当前方位对应的轴标签（斜向两个，正方向一个） */
  cueAxes: [],
  cueAt: 0,
  /** 高亮保持时长与淡出时长（ms），由主进程下发 */
  hold: CUE_HOLD_DEFAULT,
  fade: CUE_FADE_DEFAULT,
  /** 双闪动画的起点：只在方位变化时重置，同方位续期不重播 */
  cuePulseAt: 0,
  /** 呼吸动画的 rAF 句柄 */
  raf: 0
};

/**
 * 雷达圈相对标定圆的偏移。
 *   0    → 环与小地图边缘重合（贴合，不外溢到游戏 UI）
 *   +15  → 环套在小地图外面一圈
 * 实测：外扩会把八向文字推到技能图标/队伍头像上，挡住游戏界面，
 * 所以改成与标定圈同尺寸，让整套雷达完全落在地图范围内。
 */
const RING_OFFSET = 0;
/**
 * 方位文字相对雷达圈的偏移。
 *   负值 → 画在圈**内侧**（压在小地图边缘上，不影响外面 UI）
 *   正值 → 画到圈外面
 * 用户要求「再贴近点」，这里收到 −14：字几乎贴着环线。
 */
const LABEL_OFFSET = -14;

/* 字幕点亮的持续时间与淡出时长（用户要求 2.5 秒后缓缓淡出） */
/* 八向文字与罗盘角（0°=北，顺时针） */
/**
 * 只画四个轴：北 / 东 / 南 / 西。
 *
 * 斜向不做单独标签 —— 指向「东南」时让**东和南两个轴同时亮**，
 * 光晕落在两轴之间的 45° 位置。好处是：
 *   · 圈上只有 4 个字，视觉干净（8 个字挤在圈上很吵）
 *   · 和字幕解析的「原子模型」天然对齐：字幕只抽 东/西/南/北 四个字，
 *     合成出角度，显示端再拆回两个轴，全程没有「东北」这个中间词
 * 做法参考 GenshinImpactVT 的 compass.py。
 */
const DIRS4 = [
  { deg: 0, label: '北' },
  { deg: 90, label: '东' },
  { deg: 180, label: '南' },
  { deg: 270, label: '西' }
];

/**
 * 罗盘角 → 需要高亮的轴标签。
 * 正方向返回一个轴，斜向返回相邻两个轴。
 */
function axesForDeg(deg) {
  // 防 NaN：typeof NaN === 'number'，上层的类型检查拦不住它，
  // 而 Math.round(NaN) 会一路传染到 DIRS4.find(...).label 直接抛异常
  if (!Number.isFinite(deg)) return [];
  const bucket = ((Math.round(deg / 45) * 45) % 360 + 360) % 360;
  const at = (d) => DIRS4.find((x) => x.deg === d).label;
  if (bucket % 90 === 0) return [at(bucket)];
  // 斜向：左右各退/进 45° 就是相邻的两个轴
  return [at((bucket - 45 + 360) % 360), at((bucket + 45) % 360)];
}

/* 高亮配色：与参考项目默认的 #4080ff 一致 */
/* 方位强调色。
 * 原来是蓝色，和原神自己的 UI / 小地图配色撞得太厉害，
 * 点亮效果经常被当成界面的一部分。换成琥珀黄：
 * 蓝色背景、青色地形、绿色植被上都是最强的反差色，也不会和红箭头混。 */
const RADAR_ACCENT = '255, 200, 0';

/**
 * 箭头 / 雷达圈的绘制半径。
 *
 * 保持原作者的比例映射（窗口半边长 × 0.86），**不要**改成直接取
 * settings.bearing.radius —— 那样同一个滑块值画出来的圈会大 4px，
 * 用户之前对齐好的标定全部偏移，看起来就是「圈突然变大、对不齐」。
 */
function radius(w, h) {
  return (Math.min(w, h) / 2) * 0.86;
}

/** 雷达光环半径 = 标定半径 + RING_OFFSET（默认贴合） */
function rimRadius(w, h) {
  return radius(w, h) + RING_OFFSET;
}

/**
 * 补间一帧。
 *
 * 识别端已经做到「有新帧才算」，但 IPC 到这边是一跳一跳的。
 * 每帧追 45% 的差值，大约 3~4 帧收敛，视觉上是连续转动而不是硬切，代价 ~50ms。
 */
function step(key) {
  const t = tween[key];
  t.raf = 0;
  if (t.shown === null || t.target === null) return;

  const d = shortAngle(t.target, t.shown);
  if (Math.abs(d) < 0.25) {
    t.shown = t.target;
    draw();
    return;
  }
  t.shown = (t.shown + d * 0.45 + 360) % 360;
  draw();
  t.raf = requestAnimationFrame(() => step(key));
}

/**
 * 设目标角度。大跳（>90°，比如切镜头、认到别处）不补间，直接就位，
 * 否则会看到画面绕一整圈转过去，比硬切还难看。
 */
function setTarget(key, deg) {
  const t = tween[key];
  t.target = deg;
  if (t.shown === null || Math.abs(shortAngle(deg, t.shown)) > 90) {
    t.shown = deg;
    draw();
    return;
  }
  if (!t.raf) t.raf = requestAnimationFrame(() => step(key));
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;

  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  cv.style.width = `${w}px`;
  cv.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  draw();
}

function drawRing(cx, cy, r) {
  ctx.save();
  ctx.setLineDash([6, 7]);
  ctx.strokeStyle = RED_SOFT;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.strokeStyle = RED_SOFT;
  ctx.beginPath();
  ctx.moveTo(cx - 9, cy);
  ctx.lineTo(cx + 9, cy);
  ctx.moveTo(cx, cy - 9);
  ctx.lineTo(cx, cy + 9);
  ctx.stroke();
  ctx.restore();
}

/**
 * 外环绿弧：一段带圆头的弧，标出视角朝向。
 *
 * 弧的半张角不直接照搬实体视锥（用户确认恒为 90°），而是夹在 18°~34°：
 * 太长会把整圈环糊掉，太短又看不出朝向。按参考图的比例，
 * 整段弧大约占圆周的 1/6 到 1/5，一眼能读出方向又不抢戏。
 *
 * 造型：中段等厚、两端收细并圆头的「月牙」，正中向外顶出一个小尖。
 * 等宽粗线只能读出「大概这一片」，中间的小尖才是精确朝向；两端收细
 * 则让视线自然落回中段，不会把弧的端点误当成方向。
 *
 * 所有尺寸都按 r 缩放 —— 标记大小可在 50~400 之间调，写死像素会在
 * 大标记上细得看不见、小标记上糊成一团。
 */
function drawViewArc(cx, cy, r, deg, conf, width) {
  const dpr = window.devicePixelRatio || 1;
  const half = Math.max(18, Math.min(34, (width > 0 ? width : 60) * 0.45));
  const halfRad = (half * Math.PI) / 180;
  const mid = ((deg - 90) * Math.PI) / 180;

  const lw = Math.max(4.5, r * 0.085); // 中段厚度
  const edge = clamp(r * 0.013, 1.25, 2.5); // 暗描边宽度
  const alpha = 0.5 + 0.5 * clamp(conf, 0, 1);

  // 正中的小尖：两侧内凹、平滑地从弧面收成一个尖（见 outerR 里的平方项）。
  // 直边三角贴在弧上像个疙瘩，内凹的才像是从弧里「长」出来的指针。
  // 高度另有上限：窗口只比圆环多留 16% 余量，小尖连描边不能超过 1.15r
  const tickH = Math.max(0, Math.min(lw * 0.85, r * 0.15 - lw / 2 - edge));
  const tickHalf = (lw * 1.5) / r;

  // t：相对弧中点的偏角（弧度）。中间 40% 保持满厚，往两端平滑收到 45%
  const thick = (t) => {
    const k = clamp((Math.abs(t) / halfRad - 0.4) / 0.6, 0, 1);
    return lw * (1 - 0.55 * k * k * (3 - 2 * k));
  };
  const outerR = (t) => {
    const u = Math.max(0, 1 - Math.abs(t) / tickHalf);
    return r + thick(t) / 2 + tickH * u * u;
  };
  const innerR = (t) => r - thick(t) / 2;

  // 弧身每 2° 采一个点；小尖是曲线，单独加密采样，
  // 并且尖顶（t=0）必须恰好落在采样点上，否则尖会被削平
  const n = Math.ceil(half);
  const ts = [];
  for (let i = 0; i <= n; i += 1) ts.push(-halfRad + (2 * halfRad * i) / n);
  for (let i = -8; i <= 8; i += 1) ts.push((tickHalf * i) / 8);
  ts.sort((p, q) => p - q);

  const capR = thick(halfRad) / 2;
  const a0 = mid - halfRad;
  const a1 = mid + halfRad;

  ctx.beginPath();
  for (let i = 0; i < ts.length; i += 1) {
    const ro = outerR(ts[i]);
    const x = cx + Math.cos(mid + ts[i]) * ro;
    const y = cy + Math.sin(mid + ts[i]) * ro;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  // 末端圆头：圆心压在弧的中线上，从外缘绕到内缘
  ctx.arc(cx + Math.cos(a1) * r, cy + Math.sin(a1) * r, capR, a1, a1 + Math.PI);
  for (let i = ts.length - 1; i >= 0; i -= 1) {
    const ri = innerR(ts[i]);
    ctx.lineTo(cx + Math.cos(mid + ts[i]) * ri, cy + Math.sin(mid + ts[i]) * ri);
  }
  ctx.arc(cx + Math.cos(a0) * r, cy + Math.sin(a0) * r, capR, a0 + Math.PI, a0 + Math.PI * 2);
  ctx.closePath();

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.lineJoin = 'round';

  // 暗描边 + 柔和投影：绿弧压在草地/水面这类同色系地形上，
  // 没有一圈暗边会糊成一团。投影只挂在描边上，主体保持干净
  ctx.shadowColor = SHADOW;
  ctx.shadowBlur = clamp(r * 0.05, 3, 10) * dpr;
  ctx.strokeStyle = GREEN_EDGE;
  ctx.lineWidth = edge * 2;
  ctx.stroke();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;

  // 主体：沿径向由内缘高光过渡到外缘深绿，薄薄一条也有体积感
  const g = ctx.createRadialGradient(cx, cy, r - lw / 2, cx, cy, r + lw / 2 + tickH);
  g.addColorStop(0, GREEN_LIGHT);
  g.addColorStop(0.45, GREEN);
  g.addColorStop(1, GREEN_DEEP);
  ctx.fillStyle = g;
  ctx.fill();

  ctx.restore();
}

/**
 * 行进方向箭头：一整块闭合轮廓（细尾 → 渐宽箭杆 → 后掠箭头），
 * 而不是「一根线 + 一个三角」拼起来 —— 拼接处的描边会鼓出一个疙瘩，
 * 而且线宽写死像素后不随标记大小缩放。
 */
function drawArrow(cx, cy, r, deg) {
  const dpr = window.devicePixelRatio || 1;
  const a = ((deg - 90) * Math.PI) / 180;

  // 起点靠近中心、尖端落在圆环**内侧**：外环还要留给绿弧，
  // 箭头探出环外会和绿弧叠在一起，两样都看不清。
  // 中心 0.4r 以内不画东西，玩家自己小地图上的角色图标不能被盖住
  const tipX = r * 0.9;
  const tailX = r * 0.4;
  const headL = Math.max(13, r * 0.24);
  const headW = headL * 0.56; // 箭头半宽
  const barbX = tipX - headL; // 两翼最后端
  const neckX = tipX - headL * 0.74; // 箭杆接入箭头的位置，比两翼靠前 = 后掠
  const neckW = Math.max(2.6, headL * 0.2); // 箭杆在颈部的半宽
  const tailW = neckW * 0.45; // 箭尾半宽：收细但不收成针尖，描边才包得住
  const outline = clamp(r * 0.02, 1.5, 3.5);

  ctx.save();
  // 转到箭头自己的坐标系：+x 就是指向，后面的轮廓全部按轴对称来写
  ctx.translate(cx, cy);
  ctx.rotate(a);
  ctx.lineJoin = 'round';

  ctx.beginPath();
  ctx.moveTo(tailX, -tailW);
  ctx.lineTo(neckX, -neckW);
  ctx.lineTo(barbX, -headW);
  ctx.lineTo(tipX, 0);
  ctx.lineTo(barbX, headW);
  ctx.lineTo(neckX, neckW);
  ctx.lineTo(tailX, tailW);
  ctx.closePath();

  // 第一遍：白描边 + 暗投影。白边管深色地形，投影管雪地 —— 两层缺一层
  // 都会在某种地形上丢轮廓
  ctx.shadowColor = SHADOW;
  ctx.shadowBlur = clamp(r * 0.06, 3, 12) * dpr;
  ctx.shadowOffsetY = dpr;
  ctx.strokeStyle = WHITE;
  ctx.lineWidth = outline * 2;
  ctx.stroke();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;

  // 第二遍：红色主体，尾深尖亮
  const g = ctx.createLinearGradient(tailX, 0, tipX, 0);
  g.addColorStop(0, RED_DEEP);
  g.addColorStop(0.55, RED);
  g.addColorStop(1, RED_TIP);
  ctx.fillStyle = g;
  ctx.fill();

  // 第三遍：沿中轴一侧压一层淡高光，做成导航箭头那种两面折光，
  // 小尺寸下也能一眼分出「这是个有朝向的箭头」而不是一坨红
  ctx.clip();
  ctx.fillStyle = 'rgba(255, 255, 255, 0.17)';
  ctx.fillRect(tailX - outline, -headW - outline, tipX - tailX + outline * 2, headW + outline);

  ctx.restore();
}

/**
 * 画雷达光环。
 *
 * 两层叠加，和参考项目 rim_highlight() 的算法一致：
 *   1. 径向渐变铺一个「环带」（峰值在 84% 半径）
 *   2. 锥形渐变做 DestinationIn，把环带裁成 ±28° 实心 / ±42° 渐隐的一段
 *
 * @param {number} deg   要点亮的罗盘角
 * @param {number} alpha 整体透明度（淡入淡出 + 呼吸都在这里）
 */
function drawRadarGlow(cx, cy, rim, deg, alpha) {
  if (alpha <= 0.001) return;

  const pad = Math.ceil(rim * 1.02) + 2;
  ctx.save();

  // ---- 第一层：环带 ----
  const radial = ctx.createRadialGradient(cx, cy, 0, cx, cy, rim);
  // 停靠点和参考项目一致：中心与中段全透明，靠边才亮
  const stops = [
    [0.0, 0],
    [0.58, 0],
    [0.7, 65],
    [0.84, 190],
    [0.94, 165],
    [1.0, 0]
  ];
  for (const [pos, a] of stops) {
    radial.addColorStop(pos, `rgba(${RADAR_ACCENT}, ${(a / 255) * alpha})`);
  }
  ctx.fillStyle = radial;
  ctx.beginPath();
  ctx.arc(cx, cy, rim, 0, Math.PI * 2);
  ctx.fill();

  // ---- 第二层：角度羽化（DestinationIn 保留 + 镂空） ----
  // 画布 0° 在右、顺时针；罗盘 0° 在上，所以减 90。
  const start = ((deg - 90) * Math.PI) / 180;
  const solid = (28 * Math.PI) / 180; // 实心半角
  const feather = (42 * Math.PI) / 180; // 渐隐半角

  const angular = ctx.createConicGradient
    ? ctx.createConicGradient(start - feather, cx, cy)
    : null;

  if (angular) {
    /* 渐变从「渐隐起点」(start − feather) 开始铺一整圈，
     * 所以距起点的弧度就是停靠点：
     *   feather − solid → 对应 −28°（实心边缘，0.59）
     *   feather         → 对应   0°（正中，1）
     *   feather + solid → 对应 +28°
     *   2·feather       → 对应 +42°（完全透明）
     * 中间按参考项目的 150/255 比例给 0.59。 */
    const span = Math.PI * 2;
    const toStop = (rad) => Math.max(0, Math.min(1, rad / span));
    angular.addColorStop(0, 'rgba(255,255,255,0)');
    angular.addColorStop(toStop(feather - solid), 'rgba(255,255,255,0.59)');
    angular.addColorStop(toStop(feather), 'rgba(255,255,255,1)');
    angular.addColorStop(toStop(feather + solid), 'rgba(255,255,255,0.59)');
    angular.addColorStop(toStop(feather * 2), 'rgba(255,255,255,0)');
    angular.addColorStop(1, 'rgba(255,255,255,0)');

    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = angular;
    ctx.beginPath();
    ctx.arc(cx, cy, rim, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }

  ctx.restore();
}

/**
 * 八个方位文字。
 *
 * 位置用三角函数均匀铺在雷达圈外：
 *   x = cx + R·sin(θ)   y = cy − R·cos(θ)      （θ 为罗盘角，0°=正上方）
 *
 * 默认半透明；被字幕点中的那个放大 + 变蓝 + 闪烁。
 */
function drawRadarLabels(cx, cy, rim, now) {
  const R = rim + LABEL_OFFSET;
  const cue = RADAR.cueDeg;
  const age = RADAR.cueAt ? now - RADAR.cueAt : Infinity;
  // 点中后只做一次淡入，然后稳住，最后随整体淡出。
  // 原来用的是 |sin(x·2π)|，700ms 内正好两个波峰 —— 字面意义上的「闪两下」，
  // 看起来像出错而不是强调。
  const pulseAge = RADAR.cuePulseAt ? now - RADAR.cuePulseAt : Infinity;
  const pulse = pulseAge < 320 ? 0.55 + 0.45 * Math.sin((pulseAge / 320) * (Math.PI / 2)) : 1;
  const cueAlpha = age > RADAR.hold ? Math.max(0, 1 - (age - RADAR.hold) / RADAR.fade) : 1;

  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const w = window.innerWidth;
  const h = window.innerHeight;
  // 文字留出的边距：字形 15px + 描边 4px，取 14 足够
  const PAD = 14;

  for (const d of DIRS4) {
    const rad = (d.deg * Math.PI) / 180;
    /* 纯兜底：窗口是 (半径+20)×2、文字画在半径−14 处，
     * 正常情况下离画布边缘还有 26px 余量，这里的夹取不会生效。
     * 只有极端情况（窗口被系统缩到比圈还小）才会把文字收回画布内，
     * 免得整块消失。 */
    const x = clamp(cx + Math.sin(rad) * R, PAD, w - PAD);
    const y = clamp(cy - Math.cos(rad) * R, PAD, h - PAD);

    // 命中判定：这个轴是否在当前方位里。
    // 指向东南时 axes = ['东','南']，两个字会一起亮。
    const hit = cue >= 0 && (RADAR.cueAxes || []).includes(d.label);
    const scale = hit ? 1.5 * (0.96 + 0.04 * pulse) : 1;
    const alpha = hit ? cueAlpha : 0.45;

    ctx.save();
    ctx.translate(x, y);
    ctx.scale(scale, scale);
    ctx.font = '700 15px "Microsoft YaHei UI", "Microsoft YaHei", sans-serif';

    // 先描一圈黑边：任何地形底色下都读得清（参考项目也是先画深色底再画字）
    // 点中时字号放大 1.5 倍，4px 黑边会吃掉笔画内部 —— 点中的字反而发黑，收到 3px
    ctx.lineWidth = hit ? 3 : 4;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = hit ? 'rgba(0, 24, 40, 0.85)' : `rgba(0, 0, 0, ${0.72 * alpha})`;
    ctx.strokeText(d.label, 0, 0);

    if (hit) {
      // 点中：亮蓝 + 外发光，和雷达光同一套色
      ctx.shadowColor = `rgba(${RADAR_ACCENT}, ${alpha})`;
      ctx.shadowBlur = 18 * pulse;
      ctx.fillStyle = `rgba(255, 245, 205, ${alpha})`;
    } else {
      ctx.shadowBlur = 0;
      ctx.fillStyle = `rgba(255, 255, 255, ${alpha})`;
    }
    ctx.fillText(d.label, 0, 0);
    ctx.restore();
  }

  ctx.restore();
}

/**
 * 呼吸/淡出驱动的重绘循环。
 *
 * 只在「有点亮中的方位」时跑：没有 cue 就不需要每帧重画，
 * 静态的雷达圈和文字靠一次 draw() 就够，避免常驻 rAF 白烧 CPU。
 */
function radarTick() {
  RADAR.raf = 0;
  if (RADAR.cueDeg < 0) {
    draw();
    return;
  }
  draw();
  const age = Date.now() - RADAR.cueAt;
  if (age < RADAR.hold + RADAR.fade) {
    RADAR.raf = requestAnimationFrame(radarTick);
  } else {
    // 淡出结束：清掉 cue，再补一帧恢复默认外观
    RADAR.cueDeg = -1;
    RADAR.cueLabel = '';
    RADAR.cueAxes = [];
    draw();
  }
}

/** 字幕给出绝对方位时调用：点亮对应扇区并开始呼吸 */
function showCompassCue(deg, label) {
  const next = ((Number(deg) % 360) + 360) % 360;
  // 同一方位再次收到：只把停留时间往后延，不重播开头的双闪，
  // 否则一句字幕反复推送时会一直「闪两下」
  const same = RADAR.cueDeg === next;
  RADAR.cueDeg = next;
  RADAR.cueLabel = String(label || '');
  // 斜向会得到两个轴，正方向只有一个
  RADAR.cueAxes = axesForDeg(RADAR.cueDeg);
  /* 续期时不要重置 cueAt —— cueAt 也是淡入的起点，
   * 每次重置都会让光晕从 0 重新淡入，每秒暗一下再亮起来，
   * 看着就是「呼吸灯一直闪」。
   *
   * 也不能把它推到 hold 边界（那样 age 会在两次续期之间越过 hold，
   * 反而开始淡出，同样会闪）。正确做法是往后挪一点点，
   * 正好跳过开头 60ms 的淡入：age 从 60 涨到 1060，
   * 离 hold 还有一大截，始终满亮。 */
  RADAR.cueAt = same ? Date.now() - 60 : Date.now();
  if (!same) RADAR.cuePulseAt = RADAR.cueAt;
  /* 续期时动画循环多半已经停了（3.6 秒后 radarTick 不再续帧），
   * 光晕是静止的、不会重画。必须重新叫醒，续期才真的看得见。 */
  if (!RADAR.raf) RADAR.raf = requestAnimationFrame(radarTick);
}

function draw() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  ctx.clearRect(0, 0, w, h);

  // 窗口就是以标定圆心为中心的正方形，所以圆心恒在窗口正中
  const cx = w / 2;
  const cy = h / 2;
  const r = radius(w, h);
  const rim = rimRadius(w, h);
  const now = Date.now();

  /* ---- 雷达圈与八向文字 ----
   * 只有标定过才显示：没标定时圆心/半径都是猜的，画出来只会误导。
   * 未标定状态下箭头仍然照画（它不依赖雷达）。 */
  if (RADAR.visible && RADAR.radius > 0) {
    if (RADAR.cueDeg >= 0 && RADAR.cueAt) {
      const age = now - RADAR.cueAt;
      // 淡入 60ms → 保持 → 淡出 450ms。
      // 原来 120ms 看着像「慢半拍」，字幕都到下一句了圈才亮。
      let alpha = 1;
      if (age < 60) alpha = age / 60;
      else if (age > RADAR.hold) alpha = Math.max(0, 1 - (age - RADAR.hold) / RADAR.fade);
      // 呼吸：全程很轻的 0.88~1.0 摆动，看起来像光环在呼吸
      const breathe = 0.88 + 0.12 * Math.sin(now / 420);
      drawRadarGlow(cx, cy, rim, RADAR.cueDeg, alpha * breathe);
    }

    drawRadarLabels(cx, cy, rim, now);
  }

  if (placing) drawRing(cx, cy, r);

  // 绿弧画在箭头下面：两者重叠时箭头要压在上面看得清
  const v = tween.view;
  if (v.shown !== null && Date.now() - v.at < VIEW_STALE_MS) {
    drawViewArc(cx, cy, r, v.shown, v.conf, v.width);
  }
  if (tween.arrow.shown !== null) drawArrow(cx, cy, r, tween.arrow.shown);
}

/** 视角有更新时续期，并在过期那一刻重绘一次把绿弧收掉 */
let viewExpireTimer = 0;
function touchView() {
  tween.view.at = Date.now();
  clearTimeout(viewExpireTimer);
  viewExpireTimer = setTimeout(draw, VIEW_STALE_MS + 50);
}

/* --------------------------------------------------------- 自绘拖动
 *
 * 为什么不用 CSS 的 -webkit-app-region: drag：
 * 那是把拖动交给 Windows 的标题栏命中测试，指针扫到屏幕顶部 / 左右边缘时
 * 会触发 Aero Snap（吸附 / 最大化预览），松开鼠标窗口就「弹回」原位置。
 * 这个窗口又不可最大化，系统往往直接把它复位 —— 就是用户说的
 * 「拖上去松开自己弹回来」。
 *
 * 自己跟指针算位移就完全没有这层系统逻辑：1:1 跟随，能推到屏幕外，
 * 也不会被吸附。
 */
let drag = null;

window.addEventListener('pointerdown', (e) => {
  if (!placing || e.button !== 0) return;
  drag = { x: e.screenX, y: e.screenY };
  try {
    e.target.setPointerCapture(e.pointerId);
  } catch {
    /* 某些环境不支持捕获，退化为普通移动 */
  }
  window.overlayApi.dragStart({ x: e.screenX, y: e.screenY });
});

window.addEventListener('pointermove', (e) => {
  if (!drag) return;
  window.overlayApi.dragMove({ x: e.screenX, y: e.screenY });
});

const endDrag = () => {
  if (!drag) return;
  drag = null;
  window.overlayApi.dragEnd();
};
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);
window.addEventListener('blur', endDrag);

window.addEventListener('resize', resize);

/* 雷达几何：标定圆心半径一变（拖动/缩放标定圈）就立刻重画 */
window.overlayApi.onRadar((cfg) => {
  const p = cfg || {};
  RADAR.radius = Number(p.radius) || 0;
  RADAR.visible = !!p.visible && RADAR.radius > 0;
  // 高亮时长由主进程统一决定，和放大提醒窗共用同一份数值
  if (Number.isFinite(p.hold) && p.hold > 0) RADAR.hold = Math.round(p.hold);
  if (Number.isFinite(p.fade) && p.fade > 0) RADAR.fade = Math.round(p.fade);
  draw();
});

/* 字幕点亮的绝对方位 */
window.overlayApi.onCompassCue((cue) => {
  if (!cue || typeof cue.deg !== 'number') return;
  if (!RADAR.visible) return; // 没标定就不点亮（圈都还没挂上去）
  showCompassCue(cue.deg, cue.label);
});

window.overlayApi.onBearing((payload) => {
  if (!payload) return;

  // 箭头：hold 表示这一帧的判据是「疑似反向」，保持原角度不动，不要跟着转
  if (!payload.hold && typeof payload.angle === 'number') {
    setTarget('arrow', payload.angle);
  }

  // 视角：可能是 null（这一帧没识别到扇形）。
  // 这时**不续期**，让绿弧自然过期消失 —— 否则会挂一段没有证据的假方向。
  if (typeof payload.view === 'number') {
    tween.view.conf = payload.viewConfidence || 0;
    tween.view.width = payload.viewWidth || 0;
    setTarget('view', payload.view);
    touchView();
  }
});

window.overlayApi.onMode((mode) => {
  placing = mode === 'place';
  document.body.classList.toggle('placing', placing);
  draw();
});

resize();
