'use strict';

/**
 * 八方向圆盘的绘制。圆盘浮窗和启动器「手柄快捷键」的参考图共用这一份。
 *
 * 页面里没有模块系统，两个宿主各加一个 <script>，再取 window.GdiscDraw。
 * 必须包在 IIFE 里：经典脚本共用同一份全局词法作用域，这里直接写
 * `function drawDisc` 会和宿主页面里的同名声明撞成 SyntaxError —— 圆盘页
 * 因此一行没画，透明窗看着就像「按了 L3 不弹出」。
 */
(() => {
  const SECTOR_STEP = Math.PI / 4;      // 45°
  const SECTOR_HALF = SECTOR_STEP / 2;
  /** 扇区下标即角度：0 = 正东，顺时针递增。与 gamepad-config.js 的 DIRECTION_NAMES 同序 */
  const SECTORS = ['e', 'se', 's', 'sw', 'w', 'nw', 'n', 'ne'];

  const INK = 'rgba(238,242,236,0.9)';
  const INK_DIM = 'rgba(238,242,236,0.52)';
  const GOLD = '240,180,41';
  const GLASS = 'rgba(14,18,15,0.78)';

  /** 扇区里那条字：先按 15px 试，放不下就一档档缩，最窄也留 9px */
  function fitFont(ctx, text, maxWidth) {
    for (let size = 15; size >= 9; size -= 1) {
      ctx.font = `600 ${size}px "Microsoft YaHei", system-ui, sans-serif`;
      if (ctx.measureText(text).width <= maxWidth) return size;
    }
    ctx.font = `600 9px "Microsoft YaHei", system-ui, sans-serif`;
    return 9;
  }

  function wedgePath(ctx, cx, cy, mid, inner, outer) {
    ctx.beginPath();
    ctx.arc(cx, cy, outer, mid - SECTOR_HALF, mid + SECTOR_HALF);
    ctx.arc(cx, cy, inner, mid + SECTOR_HALF, mid - SECTOR_HALF, true);
    ctx.closePath();
  }

  /**
   * ctx 的变换（含 devicePixelRatio）由调用方设好，这里只按 CSS 像素画。
   * labels 缺项就退回方位名 —— 启动器的参考图正是靠这个把 n/e/s/w 直接标在扇区上。
   */
  function drawDisc(ctx, options) {
    const {
      width,
      height,
      highlight = '',
      /** true = 高亮扇区绑的是按住类动作，中心提示改成「回中恢复」 */
      hold = false,
      labels = {},
      hint = '推杆选择'
    } = options;
    const cx = width / 2;
    const cy = height / 2;
    // 浮窗那边是 radius × 2.24 开窗，剩下的 12% 余量正好当外边距
    const outer = Math.min(cx, cy) * 0.9;
    const inner = outer * 0.34;

    ctx.clearRect(0, 0, width, height);

    ctx.beginPath();
    ctx.arc(cx, cy, outer, 0, Math.PI * 2);
    ctx.fillStyle = GLASS;
    ctx.fill();

    for (let i = 0; i < SECTORS.length; i += 1) {
      const direction = SECTORS[i];
      const mid = i * SECTOR_STEP;
      const active = highlight === direction;
      wedgePath(ctx, cx, cy, mid, inner, outer - (active ? 0 : 2));
      if (active) {
        const glow = ctx.createRadialGradient(cx, cy, inner, cx, cy, outer);
        glow.addColorStop(0, `rgba(${GOLD},0.42)`);
        glow.addColorStop(1, `rgba(${GOLD},0.16)`);
        ctx.fillStyle = glow;
        ctx.fill();
        ctx.strokeStyle = `rgba(${GOLD},0.95)`;
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.04)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.16)';
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    for (let i = 0; i < SECTORS.length; i += 1) {
      const direction = SECTORS[i];
      const mid = i * SECTOR_STEP;
      const active = highlight === direction;
      const text = labels[direction] || direction;
      const radius = (inner + outer) / 2;
      const tx = cx + Math.cos(mid) * radius;
      const ty = cy + Math.sin(mid) * radius;
      const size = fitFont(ctx, text, (outer - inner) * 0.82);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = active ? '#fff8e6' : INK_DIM;
      ctx.fillText(text, tx, ty + (size >= 12 ? 0 : 1));
    }

    ctx.beginPath();
    ctx.arc(cx, cy, inner * 0.82, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(8,11,9,0.86)';
    ctx.fill();
    ctx.strokeStyle = highlight ? `rgba(${GOLD},0.8)` : 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `600 12px "Microsoft YaHei", system-ui, sans-serif`;
    ctx.fillStyle = highlight ? INK : INK_DIM;
    // 按住类动作在过锁存线那刻就已经生效，中心提示得说清「怎么结束」而不是「怎么生效」
    ctx.fillText(highlight ? (hold ? '回中恢复' : '松杆触发') : hint, cx, cy);
  }

  window.GdiscDraw = { SECTORS, drawDisc };
})();
