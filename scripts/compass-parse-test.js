'use strict';

/* 方位解析的离线回归：只做纯文本，不启动 Electron、不碰窗口。
 *
 * 盯的是「字幕说了方向，雷达却不亮」这一类问题。历史上踩过两次：
 *   1. 解析本身认不出「东方向」（上下文判断写漏）
 *   2. 解析对了，但延时点亮被逐字上屏的新字幕取消掉，一次都亮不起来
 * 第 2 条没法在这里跑定时器，用「方向还在就照常点亮」的判定函数覆盖。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8');

/** 从 app.js 里抠出需要的函数/常量源码（不执行整个文件） */
function snippet(signature) {
  const start = source.indexOf(signature);
  assert.notEqual(start, -1, '找不到 ' + signature);
  // 从签名开始，按花括号配平找到函数结尾
  let depth = 0;
  let seen = false;
  let end = start;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') {
      depth += 1;
      seen = true;
    } else if (ch === '}') {
      depth -= 1;
      if (seen && depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  return source.slice(start, end);
}

/** 取一个 const 数组/对象的声明（到行尾分号） */
function constant(name) {
  const re = new RegExp('const ' + name + ' = [\\s\\S]*?\\n(?:\\}|\\]);');
  const m = re.exec(source);
  assert.ok(m, '找不到常量 ' + name);
  return m[0];
}

const parts = [
  'const DIR_NAMES',
  'const MAP_POS_DEG'
];
const code = [
  constant('DIR_NAMES'),
  constant('MAP_POS_DEG'),
  snippet('function nearestDirName'),
  snippet('function directionSegments'),
  snippet('function atomsInPhrase'),
  snippet('function atomsToCompass'),
  snippet('function stripParens'),
  snippet('function mapPositionSegments')
].join('\n');

const sandbox = { Math, Set, String, Number, console };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
void parts;

let pass = 0;
let fail = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass += 1;
  else fail += 1;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
}

/** 整句 → 所有方位角（按句内顺序），和 detectCompassDir 里的取舍一致 */
function degsOf(text) {
  const mapSegs = sandbox.mapPositionSegments(sandbox.stripParens(text));
  if (mapSegs.length) return mapSegs.map((s) => s.deg);
  return sandbox
    .directionSegments(text)
    .map((seg) => sandbox.atomsToCompass(seg.atoms))
    .filter((d) => d !== null);
}

console.log('方位解析：');

check('「然后来东方向地图构边」→ 东（90°）', degsOf('然后来东方向地图构边'), [90]);
check('「东方向」单独一句 → 东', degsOf('东方向'), [90]);
check('「往东北方向走」→ 东北', degsOf('往东北方向走'), [45]);
check('「先往东然后往北」→ 东、北两条', degsOf('先往东然后往北'), [90, 0]);
check('「地图右边」→ 东', degsOf('地图右边'), [90]);
check('「出门之后来东北方向地图右上角再往上面看」→ 东北', degsOf('出门之后来东北方向地图右上角再往上面看'), [45]);
check('「东北方向」但没提地图 → 东北', degsOf('出门之后往东北方向走'), [45]);
check('「小地图左下角」→ 西南', degsOf('小地图左下角'), [225]);
check('括号里的复述不参与判定', degsOf('东方向 地图右边（西方向 地图左边）'), [90]);
check('否定句不点亮', degsOf('不要往东走'), []);
check('「上面有个宝箱」这类裸字不点亮', degsOf('上面有个宝箱'), []);
check('「东北虎」不点亮', degsOf('这里有只东北虎'), []);
check('「东西」连用不点亮', degsOf('把东西放进去'), []);

console.log('\n逐字上屏（AI 字幕的真实情况）：');
{
  // 这句话会经历十几次「新文本」，每次都要解析出同一个东，才算能点亮
  const target = '然后来东方向地图构边';
  const seen = [];
  for (let i = 1; i <= target.length; i += 1) {
    const partial = target.slice(0, i);
    seen.push({ partial, degs: degsOf(partial) });
  }
  const withEast = seen.filter((s) => s.degs.includes(90));
  check('至少有一帧解析出东', withEast.length > 0, true);
  // 关键：第一次解析出东之后，后续每一帧都还带着东（延时点亮靠这个活下来）
  const firstAt = seen.findIndex((s) => s.degs.includes(90));
  const after = seen.slice(firstAt);
  check('此后每一帧都仍然包含东', after.every((s) => s.degs.includes(90)), true);
  // 「来东」还不算：后面没有「方/向/边」这类后缀，单字「东」会被当成裸字跳过。
  // 到「来东方」才满足上下文要求 —— 这条正是防误触发的关键，别改坏。
  check('第一次是「然后来东方」这一帧', seen[firstAt].partial, '然后来东方');
}

console.log(`\n结果：${pass} PASS / ${fail} FAIL`);
if (fail) process.exitCode = 1;
