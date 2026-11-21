'use strict';

/* 剧情识别核心算法的离线回归：只跑纯函数，不启动 Electron、不碰屏幕。
 *
 * 判据抄自 BetterGI 的 AutoSkip：
 *   DisabledUiButton = TemplateMatch(disabled_ui.png, roi = 左上角 cw/3 × ch/8)
 * 所以这里盯两件事：
 *   1. matchTemplate 能在图里把模板找出来，并且对整体亮度不敏感
 *   2. 接线没断（阈值、去抖、窗口藏/恢复、开关都在）
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

/** 从源码里抠出函数（按花括号配平，不执行整个文件） */
function snippet(signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, '找不到 ' + signature);
  let depth = 0;
  let seen = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') {
      depth += 1;
      seen = true;
    } else if (ch === '}') {
      depth -= 1;
      if (seen && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error('花括号没配平：' + signature);
}

const code = [snippet('function grayFromBitmap'), snippet('function matchTemplate')].join('\n');
const sandbox = { Math, Float32Array, Uint8ClampedArray };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);

let pass = 0;
let fail = 0;
function check(name, got, want) {
  const ok = typeof want === 'function' ? want(got) : JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass += 1;
  else fail += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  got=${JSON.stringify(got)}`}`);
}

/* 造一个 20×14 的模板：中间一个亮块 + 左上角一条暗边，形状足够独特 */
const TW = 20;
const TH = 14;
function makeTemplate() {
  const g = new Float32Array(TW * TH);
  for (let y = 0; y < TH; y += 1) {
    for (let x = 0; x < TW; x += 1) {
      const block = x > 5 && x < 14 && y > 4 && y < 11;
      const edge = y < 2;
      g[y * TW + x] = block ? 210 : edge ? 20 : 90;
    }
  }
  return g;
}

/** 造一张「屏幕」：把模板贴到 (ox,oy)，其余填背景色 */
function makeScreen(w, h, tmpl, ox, oy, bg = 60, gain = 1, bias = 0) {
  const g = new Float32Array(w * h).fill(bg);
  if (tmpl) {
    for (let y = 0; y < TH; y += 1) {
      for (let x = 0; x < TW; x += 1) {
        g[(oy + y) * w + ox + x] = tmpl[y * TW + x] * gain + bias;
      }
    }
  }
  return g;
}

const tmpl = makeTemplate();
const tmplObj = { w: TW, h: TH, gray: tmpl };

console.log('模板匹配：');

check('图里能找到模板（分数≈1）', sandbox.matchTemplate(makeScreen(160, 90, tmpl, 40, 30), 160, 90, tmplObj).score, (v) => v > 0.99);
check('换位置也能找到', sandbox.matchTemplate(makeScreen(160, 90, tmpl, 120, 60), 160, 90, tmplObj).score, (v) => v > 0.99);
check('命中位置准确', sandbox.matchTemplate(makeScreen(160, 90, tmpl, 120, 60), 160, 90, tmplObj), (v) => v.x === 120 && v.y === 60);

/* 关键性质：游戏里亮度一直在变（白天/夜晚/雪地），
 * NCC 对整体提亮、压暗、对比度缩放都必须保持不变。 */
check('整体提亮不影响', sandbox.matchTemplate(makeScreen(160, 90, tmpl, 40, 30, 60, 1, 40), 160, 90, tmplObj).score, (v) => v > 0.99);
check('整体压暗不影响', sandbox.matchTemplate(makeScreen(160, 90, tmpl, 40, 30, 30, 0.6, 0), 160, 90, tmplObj).score, (v) => v > 0.99);
check('对比度缩放不影响', sandbox.matchTemplate(makeScreen(160, 90, tmpl, 40, 30, 60, 1.5, -30), 160, 90, tmplObj).score, (v) => v > 0.99);

check('没有模板时分数低', sandbox.matchTemplate(makeScreen(160, 90, null, 0, 0), 160, 90, tmplObj).score, (v) => v < 0.6);

check('图比模板还小返回 -1', sandbox.matchTemplate(new Float32Array(10 * 10), 10, 10, tmplObj).score, -1);

check('纯噪声分数低', sandbox.matchTemplate((() => {
  const g = new Float32Array(160 * 90);
  for (let i = 0; i < g.length; i += 1) g[i] = (i * 37) % 251;
  return g;
})(), 160, 90, tmplObj).score, (v) => v < 0.6);

console.log('\n灰度换算：');
{
  // BGRA：纯红 / 纯绿 / 纯白 / 纯黑
  const bmp = Buffer.from([
    0, 0, 255, 255,
    0, 255, 0, 255,
    255, 255, 255, 255,
    0, 0, 0, 255
  ]);
  const gray = sandbox.grayFromBitmap(bmp, 2, 2);
  check('红 ≈ 76', Math.round(gray[0]), 76);
  check('绿 ≈ 150', Math.round(gray[1]), 150);
  check('白 = 255', Math.round(gray[2]), 255);
  check('黑 = 0', Math.round(gray[3]), 0);
}

console.log('\n接线检查：');
{
  const root = path.join(__dirname, '..');
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  const preloadSrc = read('src/preload.js');
  const guestSrc = read('src/webview-preload.js');
  const htmlSrc = read('src/console/index.html');
  const consoleSrc = read('src/console/console.js');
  const ok = (name, cond) => check(name, !!cond, true);

  // ROI 必须和 BetterGI 的 Recognition.json 一致：左上角 1/3 宽、1/8 高
  ok('ROI = 左上角 1/3 × 1/8', /STORY_ROI = \{ w: 1 \/ 3, h: 1 \/ 8 \}/.test(source));
  ok('模板路径指向 assets/story/icon.png', /assets', 'story', 'icon\.png/.test(source));
  ok('有模板缩放（非 1920 宽屏）', /function scaledStoryTemplate/.test(source));
  ok('主进程有 setStoryHidden', /function setStoryHidden/.test(source));
  ok('story 动作在前置 switch 里', /case 'story':\s*\n\s*setStoryHidden/.test(source));
  /* 去抖两侧不对称：出剧情要比进剧情更迟钝。
   * 用户反馈的「一直抽」都发生在剧情结束前后（转场、切镜头、UI 复位），
   * 出剧情太快就会藏一下又放回来。 */
  ok('去抖：进剧情比出剧情敏感', (() => {
    const m = source.match(/const STORY_ENTER_HITS = (\d+);\s*\nconst STORY_EXIT_MISSES = (\d+);/);
    return !!m && Number(m[2]) > Number(m[1]);
  })());
  ok('去抖门槛真的用上了', /storyWatch\.hits >= STORY_ENTER_HITS/.test(source)
    && /storyWatch\.misses >= STORY_EXIT_MISSES/.test(source));
  /* 用户反馈「隐藏和恢复有点慢」。这里把总延迟钉住：
   * 轮数 × 默认间隔 = 实际等待时间，进/出都不该超过 2 秒。
   * 只看轮数是不够的 —— 轮数没变、间隔从 600 改回 1200 同样会变慢。 */
  ok('进出剧情延迟都在 2 秒内', (() => {
    const iv = source.match(/interval:\s*(\d+)/);
    const enter = source.match(/const STORY_ENTER_HITS = (\d+);/);
    const exit = source.match(/const STORY_EXIT_MISSES = (\d+);/);
    if (!iv || !enter || !exit) return false;
    const ms = Number(iv[1]);
    return Number(enter[1]) * ms <= 2000 && Number(exit[1]) * ms <= 2000;
  })());
  /* 旧版本把 interval=1200 写进了用户配置，此后无论代码默认值怎么调，
   * 都会被这份旧配置永久覆盖 —— 表现就是「改了代码还是慢」。
   * 装载设置时必须把 1200 当作「没设置过」。 */
  ok('旧的 1200ms 配置会被迁移掉',
    /v !== 1200 \? v : DEFAULT_SETTINGS\.storyAutoHide\.interval/.test(source));
  /* 这条抓的是一个真踩过的坑：restartStoryWatch 必须在 loadSettings 之后。
   * 之前它被放在前面，读到 settings.storyAutoHide 是 undefined，
   * 直接 return —— 表现就是「开关开着，却一条 [story] 日志都没有」。 */
  ok('识别在 loadSettings 之后启动', (() => {
    const loadAt = source.indexOf('loadSettings();');
    const startAt = source.indexOf('restartStoryWatch();', loadAt);
    const earlyAt = source.indexOf('restartStoryWatch();', source.indexOf('app.whenReady'));
    return loadAt > 0 && startAt > loadAt && (earlyAt < 0 || earlyAt >= loadAt);
  })());
  ok('识别启动有 try 保护', /try \{\s*\n\s*restartStoryWatch\(\);/.test(source));

  /* 抓图必须走 GDI（CopyFromScreen），不能用 desktopCapturer 主路径 ——
   * 后者走 GPU 合成管线，实测一次 500~3400ms，一秒扫一次直接把机器拖卡。 */
  ok('主路径是 GDI 截屏', /function grabStoryRoiGdi/.test(source));
  ok('GDI 用常驻进程', /function ensureStoryCaptureProc/.test(source));
  ok('常驻进程用 CopyFromScreen', fs.readFileSync(
    path.join(root, 'assets', 'story', 'capture.ps1'), 'utf8').includes('CopyFromScreen'));
  /* GDI 是主路径，兜底只在 GDI 拿不到时用；
   * 但「游戏不在前台」时**不许**退兜底 —— desktopCapturer 对后台窗口
   * 返回的是缓存帧，会给出接近 1 的假满分（实测 0.992），
   * 用户切去看攻略时叠加层就一直藏不回来。 */
  ok('GDI 失败才退 desktopCapturer', /grabStoryRoiGdi\(true\)[\s\S]{0,900}grabStoryRoiFallback\(\)/.test(source));
  ok('不在前台时不退兜底', /lastReason === 'not-foreground'[\s\S]{0,80}return null/.test(source));
  /* 两级搜索：先抓图标所在的小区域（快约 10 倍），没命中再退回整块。
   * 这条锁住「小区域真的比整块小」和「确实有回退」，避免以后
   * 有人把回退删掉、布局一变就永久漏识别。 */
  ok('小区域比整块小', (() => {
    const m = source.match(/STORY_TIGHT_ROI = \{ x: ([\d.]+), y: ([\d.]+), w: ([\d.]+), h: ([\d.]+) \}/);
    return !!m && Number(m[3]) > 0 && Number(m[3]) < 1 && Number(m[4]) > 0 && Number(m[4]) < 1;
  })());
  ok('没命中会退回整块重抓', /function grabStoryRoiWide/.test(source)
    && /grabStoryRoiWide\(\)/.test(source));
  ok('停扫时收掉常驻进程', /stopStoryCaptureProc\(\);/.test(source));
  /* execFileSync 会把主线程整个卡住，窗口查找必须异步 */
  ok('窗口查找不用 execFileSync', !/function findGenshinWindow[\s\S]{0,2000}execFileSync\(/.test(source));

  /* 识别框：用户要求能实时看到红框（BetterGI 的「识别结果遮罩」） */
  ok('主进程有识别框窗口', /function ensureStoryBox/.test(source));
  ok('识别框按坐标画出来', /storybox:draw/.test(source));
  ok('有开关控制识别框', /showBox: true/.test(source));
  ok('停扫时收掉识别框', /destroyStoryBox\(\);/.test(source));
  const boxJs = read('src/storybox/box.js');
  ok('渲染层真的画矩形', /strokeRect/.test(boxJs));
  ok('渲染层接收主进程数据', /boxApi\.onDraw/.test(boxJs));
  const capturePs1 = fs.readFileSync(path.join(root, 'assets', 'story', 'capture.ps1'), 'utf8');
  const capCs = read('assets/story/Cap.cs');
  ok('抓图脚本先按进程名 YuanShen', /Get-Process -Name YuanShen/.test(capturePs1));
  ok('抓图脚本有标题兜底', /FindByTitle/.test(capturePs1));
  ok('抓图脚本输出屏幕坐标', /\{0\}\|\{1\}\|\{2\}/.test(capturePs1));
  ok('抓图失败有退避', /storyCapture\.failures >= 3/.test(source));

  /* 窗口身份必须能对上：只按标题里的「原神」找窗口，会抓到浏览器标签
   * （实测抓到过「# 工作交接文档：GIFA 原神跟跑」），于是「截游戏左上角」
   * 变成「截浏览器左上角」，分数永远 0.4x，还查不出原因。 */
  ok('标题兜底要求游戏窗口类名', /GameClass\s*=\s*"UnityWndClass"/.test(capCs));
  ok('标题兜底排除非游戏窗口', /FindGameWindow/.test(capCs) && /ClassOf\(hWnd\)/.test(capCs));
  ok('抓图脚本回传窗口身份', /\$ident/.test(capturePs1) && /Describe\(\$h\)/.test(capturePs1));
  ok('主进程解析窗口身份', /function parseStoryWindowIdent/.test(source));
  ok('日志里带窗口身份', /win: roi\.ident \|\| null/.test(source));
  /* 中文注释 + 无 BOM 会被 PowerShell 5.1 按 GBK 解读，
   * 尾字节吃掉换行后，下一行赋值会整行变成注释内容（实测丢过 $ident）。 */
  ok('抓图脚本带 UTF-8 BOM', capturePs1.charCodeAt(0) === 0xfeff);

  /* 兜底截图绝不能抓到自己或别的窗口：
   * 实测抓到过「原神跟跑助手」浮窗和标题带原神的浏览器标签，
   * 拿它们去匹配会得到 0.4~0.5 的假分数，而且一轮要 1800ms（GDI 的 20 倍）。 */
  ok('兜底排除本进程窗口', /split\(':'\)\[2\] === '1'/.test(source));
  ok('兜底要求标题就是游戏名', /GAME_TITLE/.test(source));
  ok('兜底抓不到就返回 null', /fallback-no-game-window/.test(source));
  /* 截不到图既不是命中也不是落空：以前一帧失败就 setStoryHidden(false)，
   * 切屏/抓图打嗝都会让叠加层弹回来，日志里 9 秒一翻就是这来的。 */
  ok('截不到图不立刻恢复窗口', /storyWatch\.stale < STORY_STALE_LIMIT/.test(source)
    && /hold: storyWatch\.on/.test(source));

  /* 切屏必须停止识别并恢复窗口：
   * 用户切去看攻略时游戏被挡住，继续识别既没意义又会误判，
   * 而且窗口被藏着不恢复，回到游戏就看不到弹幕字幕了。 */
  /* 不用 GetForegroundWindow 做前置判断（QQKit、输入法候选框这类窗口
   * 会占住键盘焦点却不影响画面），改用「识别区域那个点上最上层的窗口」。
   *
   * 必须做这个判断：GDI BitBlt 取的是屏幕 DC，和其他窗口一样也会被遮挡 ——
   * 游戏被盖住时抓到的是遮挡者的画面，拿去匹配会给出一堆 0.4~0.5 的假分数。
   * BetterGI 同样是「回来时保持可见」，只是它多了 WGC 模式可以绕过。 */
  ok('抓图不依赖键盘焦点', !/\[GifaCap\]::Foreground\(\)/.test(capturePs1));
  ok('按识别区域判断遮挡', /\[GifaCap\]::TopWindowAt/.test(capturePs1));
  ok('自己人的浮窗不算遮挡', /跟跑助手\*/.test(capturePs1));
  ok('遮挡时拦截兜底路径', /'obscured'/.test(source));
  ok('主进程识别切屏原因', /storyCapture\.lastReason/.test(source));
  /* 抓个真踩过的坑：删死代码时把 STORY_CAPTURE_WIDTH 常量一起删了，
   * 兜底函数还在用它 —— 每 1.2 秒抛一次 ReferenceError，红框压根出不来。 */
  ok('抓图常量都还有定义', ['STORY_ROI', 'STORY_BASE_WIDTH', 'STORY_CAPTURE_WIDTH'].every(
    (n) => new RegExp('const ' + n + '\\s*=').test(source)));

  ok('切屏时恢复窗口', /if \(storyWatch\.on\) \{\s*\n\s*storyWatch\.on = false;\s*\n\s*storyWatch\.hits = 0;\s*\n\s*setStoryHidden\(false\);/.test(source));
  ok('设置保存会重启扫描', /if \(!cur\.enabled\) setStoryHidden\(false\);\s*\n\s*restartStoryWatch\(\);/.test(source));
  ok('启动器有开关', /id="setStoryHide"/.test(htmlSrc));
  ok('开关会保存', /setStoryHide'\)\.addEventListener/.test(consoleSrc));
  /* 识别框能关：调试时开，稳定后要能关掉，否则全屏透明窗口一直盖在游戏上 */
  ok('启动器有识别框开关', /id="setStoryBox"/.test(htmlSrc));
  ok('识别框开关会保存', /setStoryBox'\)\.addEventListener/.test(consoleSrc));
  ok('主进程真的处理 showBox', /typeof v\.showBox === 'boolean'/.test(source));

  /* 剧情期间各叠加层都不许把自己弹出来。
   * 这些层每帧/每句字幕都在跑自己的「不可见就 show」，隐藏之后
   * 下一帧立刻又冒出来 —— 用户看到的就是「浮窗藏了，弹幕还在飘」。 */
  const autoShowSites = source.match(/if \(![^)]*isVisible\(\)\) w\.showInactive\(\)/g) || [];
  ok('叠加层自动显示都考虑剧情状态', autoShowSites.length === 0);
  ok('弹幕层不在剧情期间显示', /!w\.isVisible\(\) && !storyHidden/.test(source));
  /* 浮窗要能「看不见但还在」：用透明度 0，不用 hide()。
   * hide() 要和「用户自己关了浮窗」区分，退出时还得重压置顶层级，容易出错。 */
  ok('剧情时浮窗走全透明', /if \(storyHidden && settings\.storyAutoHide[\s\S]{0,80}return 0/.test(source));
  /* 浮窗隐藏并进「剧情时自动隐藏窗口」这一个总开关，不再单列。
   * 分两个开关只会让人不确定该开哪个。 */
  ok('总开关同时控制浮窗隐藏', /enabled: on, hideFloat: on/.test(consoleSrc));
  ok('启动器不再有独立的浮窗开关', !/id="setStoryHideFloat"/.test(htmlSrc));
  ok('preload 不再暴露无人使用的 story 通道', !/onStoryConfig/.test(preloadSrc));

  /* 合并上游 v0.2.6 时，webview-preload 里同时存在两份 sendBearing：
   * 上游那份带 layoutId/revision，我们那份带 stats，后定义的覆盖了前者。
   * 主进程合并后新增了「layoutId 对不上就丢弃」的校验，
   * 于是 undefined !== 'legacy-2' —— 所有 bearing 上报被静默丢掉，
   * 红箭头和绿弧全都不显示，而日志里看不出任何异常。
   * 这条同时锁「只有一个定义」和「定义里带 layoutId」。 */
  ok('访客页只有一个 sendBearing', (guestSrc.match(/^function sendBearing/gm) || []).length === 1);
  /* 「抓一帧核对」能抓到正确画面、但持续识别 0 帧：
   * startBearingLoop 里没有 video 就静默 return，enabled 却是 true，
   * 状态上「开着」实际不跑。现在必须留下 pendingStart 让 bind() 补启动。 */
  /* 循环的自愈靠守护定时器，不是靠 pendingStart。
   * 合并 v0.2.6 时这段守护被整块吞掉，导致视频元素一被替换
   *（B 站切分 P 会换掉 <video>），rvfc 回调里 `video !== v` 永远成立、
   * 直接 return 不再重挂，循环静默死掉 —— 这才是「箭头不显示」的源头。
   * 我后来加的 pendingStart / 自愈分支 / 定时器驱动都是在补它，已全部回退。 */
  ok('有视频元素守护定时器', /BEARING\.guard = setInterval/.test(guestSrc));
  ok('守护会重新绑定并重启循环', /bind\(pickVideo\(\)\);\s*\n\s*if \(video\) startBearingLoop\(\);/.test(guestSrc));
  /* 识别循环必须由定时器驱动，不能只靠 requestVideoFrameCallback：
   * rVFC 在视频暂停时一帧都不回调，而「暂停下来看画面」恰恰是最需要
   * 方向箭头的时候；它的回调还会因为 bind() 换了 video 元素而不再重挂，
   * 循环从此静默死掉。这两条都实际导致过「识别 0 帧」。 */
  ok('识别循环由定时器驱动', (() => {
    const i = guestSrc.indexOf('function startBearingLoop');
    if (i < 0) return false;
    const body = guestSrc.slice(i, guestSrc.indexOf('\n}\n', i));
    return /BEARING\.timer = setInterval/.test(body) && /BEARING\.loopKind = 'timer'/.test(body);
  })());
  ok('定时器不依赖播放状态', !/if \(v\.paused \|\| v\.ended\) \{\s*\n\s*try \{\s*\n\s*tickBearing/.test(guestSrc));
  /* 这条锁的是合并时把语句顺序搞反导致的死循环：
   * 「没有 on 就停掉循环」那段挂在 if (config.dump) 的 else 上，
   * 于是每次正常配置（on=true、无 dump）都会把刚启动的循环立刻停掉。
   * 日志上 startLoop 一直成功、识别永远 0 帧，循环活不过一次函数调用。 */
  ok('停循环只认「没有 on 字段」', /else if \(config\.on === undefined\)/.test(guestSrc));
  ok('正常配置不会误停循环', !/else if \(BEARING\.guard \|\| BEARING\.rvfc \|\| BEARING\.timer\)/.test(guestSrc));
  /* 箭头清屏迟滞保持作者的 1000ms。
   * 我一度改成 2500ms「减少闪烁」，但那会让识别失败时的旧角度多停留
   * 1.5 秒 —— 画面里没有小地图时，用户看到的就是一个指向错误方向的箭头。
   * 用户明确要求不要动作者的识别，这里钉死原值。 */
  ok('箭头清屏迟滞保持作者原值 1000ms', /invalidSince >= 1000/.test(guestSrc));
  ok('bearing 上报带 layoutId', (() => {
    const i = guestSrc.indexOf('function sendBearing');
    if (i < 0) return false;
    const body = guestSrc.slice(i, guestSrc.indexOf('\n}\n', i));
    return /layoutId:\s*BEARING\.layoutId/.test(body) && /revision:\s*BEARING\.revision/.test(body);
  })());
}

console.log(`\nstory-detect: ${pass} PASS / ${fail} FAIL`);
if (fail) process.exitCode = 1;
