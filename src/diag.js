'use strict';

/* 轻量诊断日志：和沙箱兜底共用 startup.log（追加写，超限轮转一次）。
 *
 * 用途只有一个 —— 排查「只在启动时出现」的问题。打包版没有控制台，
 * console.log 谁都看不见，出了这种事只能靠往文件里写。
 * 只记粗粒度事件（窗口尺寸、cid、条数），不记视频内容、不记账号信息。
 */
const fs = require('node:fs');
const path = require('node:path');

const LOG_FILE = 'startup.log';
const LOG_MAX_BYTES = 256 * 1024;

let target = '';

function init(dir) {
  try {
    target = path.join(dir, LOG_FILE);
    const stat = fs.statSync(target);
    // 只留一份旧的，够看一次启动即可
    if (stat.size > LOG_MAX_BYTES) fs.renameSync(target, target + '.1');
  } catch {
    target = path.join(dir, LOG_FILE);
  }
}

function log(tag, data) {
  if (!target) return;
  try {
    const body = data === undefined ? '' : ' ' + JSON.stringify(data);
    fs.appendFileSync(target, `${new Date().toISOString()} [${tag}]${body}\n`, 'utf8');
  } catch {
    /* 诊断写不进去不能影响主流程 */
  }
}

module.exports = { init, log, LOG_FILE };
