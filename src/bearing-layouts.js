'use strict';

const { randomUUID } = require('node:crypto');

const BUILTIN_LAYOUT_ID = 'builtin';
const BUILTIN_LAYOUT = Object.freeze({
  id: BUILTIN_LAYOUT_ID,
  name: '你的影月月',
  roi: Object.freeze({ cx: 282 / 1920, cy: 266 / 1080, r: 276 / 1920 }),
  builtIn: true,
  centered: true,
  revision: 0
});
const PANGOLIN_LAYOUT = Object.freeze({
  id: 'pangolin',
  name: '提瓦特高级特工穿山甲',
  roi: Object.freeze({ cx: 258 / 1920, cy: 284 / 1080, r: 260 / 1920 }),
  builtIn: true,
  centered: true,
  revision: 0
});
const DEFAULT_BEARING_LAYOUTS = Object.freeze({
  layouts: Object.freeze([BUILTIN_LAYOUT, PANGOLIN_LAYOUT]),
  defaultLayoutId: BUILTIN_LAYOUT_ID,
  activeLayoutId: BUILTIN_LAYOUT_ID
});

const LEGACY_SEED_ROIS = [
  { cx: 0.0875, cy: 0.122, r: 0.046 },
  { cx: 0.148, cy: 0.222, r: 0.163 }
];

function layoutName(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 40) : '';
}

function layoutRoi(raw) {
  if (!raw || !Number.isFinite(raw.cx) || !Number.isFinite(raw.cy) || !Number.isFinite(raw.r)) return null;
  if (raw.cx <= 0 || raw.cx >= 1 || raw.cy <= 0 || raw.cy >= 1 || raw.r < 0.01 || raw.r > 0.5) return null;
  return { cx: raw.cx, cy: raw.cy, r: raw.r };
}

function loadBearingLayouts(raw, lastVideoId) {
  const presets = DEFAULT_BEARING_LAYOUTS.layouts;
  const layouts = presets.map((preset) => ({ ...preset }));
  if (Array.isArray(raw.layouts)) {
    const ids = new Set(presets.map((preset) => preset.id));
    let startupId = raw.defaultLayoutId;
    for (const entry of raw.layouts) {
      const roi = layoutRoi(entry?.roi);
      if (!roi || typeof entry.id !== 'string' || !/^[a-z\d-]{1,64}$/i.test(entry.id)) continue;
      const revision = Number.isSafeInteger(entry.revision) && entry.revision >= 0 ? entry.revision : 0;
      const presetIndex = presets.findIndex((preset) => preset.id === entry.id);
      if (presetIndex !== -1) {
        const preset = presets[presetIndex];
        if (roi.r === preset.roi.r) {
          layouts[presetIndex] = { ...preset, roi, centered: entry.centered === true, revision };
        }
        continue;
      }
      const name = layoutName(entry.name);
      if (!name || ids.has(entry.id)) continue;
      if (name === PANGOLIN_LAYOUT.name && ['cx', 'cy', 'r'].every((key) => roi[key] === PANGOLIN_LAYOUT.roi[key])) {
        if (startupId === entry.id) startupId = PANGOLIN_LAYOUT.id;
        continue;
      }
      ids.add(entry.id);
      layouts.push({ id: entry.id, name, roi, centered: entry.centered === true, revision });
    }
    const defaultLayoutId = ids.has(startupId) ? startupId : BUILTIN_LAYOUT_ID;
    return { layouts, defaultLayoutId, activeLayoutId: defaultLayoutId };
  }

  const used = new Map();
  const importList = (list, label) => {
    let first = '';
    (Array.isArray(list) ? list : []).forEach((entry, index) => {
      const roi = layoutRoi(entry);
      if (!roi || LEGACY_SEED_ROIS.some((seed) => ['cx', 'cy', 'r'].every((key) => Math.abs(seed[key] - roi[key]) < 1e-4))) return;
      const key = JSON.stringify(roi);
      if (!used.has(key)) {
        const id = `legacy-${layouts.length}`;
        const name = layoutName(`${label} · 原标定 ${index + 1}`);
        layouts.push({ id, name, roi, centered: false, revision: 0 });
        used.set(key, id);
      }
      first ||= used.get(key);
    });
    return first;
  };
  const byVideo = raw.roiBy && typeof raw.roiBy === 'object' ? Object.entries(raw.roiBy) : [];
  const last = typeof lastVideoId === 'string' && lastVideoId
    ? byVideo.find(([id]) => id.toLowerCase() === lastVideoId.toLowerCase()) : null;
  const lastLayout = last ? importList(last[1], last[0]) : '';
  const globalLayout = importList(raw.rois, '旧版');
  for (const [id, list] of byVideo) importList(list, id);
  const defaultLayoutId = lastLayout || globalLayout || BUILTIN_LAYOUT_ID;
  return { layouts, defaultLayoutId, activeLayoutId: defaultLayoutId };
}

function activeBearingLayout(bearing) {
  return bearing.layouts.find((layout) => layout.id === bearing.activeLayoutId) || bearing.layouts[0] || BUILTIN_LAYOUT;
}

function applyBearingLayout(bearing, command = {}) {
  if (!command || typeof command !== 'object') return { ok: false, reason: 'invalid' };
  const index = bearing.layouts.findIndex((layout) => layout.id === command.id);
  const entry = bearing.layouts[index];
  const uniqueName = (name, self) => !bearing.layouts.some(
    (layout) => layout.id !== self && layout.name.toLowerCase() === name.toLowerCase()
  );

  switch (command.op) {
    case 'select':
      if (!entry) break;
      bearing.activeLayoutId = entry.id;
      return { ok: true };
    case 'default':
      if (!entry) break;
      bearing.defaultLayoutId = entry.id;
      return { ok: true };
    case 'remove':
      if (!entry || entry.builtIn) break;
      bearing.layouts.splice(index, 1);
      if (bearing.defaultLayoutId === entry.id) bearing.defaultLayoutId = BUILTIN_LAYOUT_ID;
      if (bearing.activeLayoutId === entry.id) bearing.activeLayoutId = bearing.defaultLayoutId;
      return { ok: true };
    case 'rename': {
      if (!entry || entry.builtIn) break;
      const name = layoutName(command.name);
      if (!name) return { ok: false, reason: 'name' };
      if (!uniqueName(name, entry.id)) return { ok: false, reason: 'duplicate' };
      bearing.layouts[index] = { ...entry, name };
      return { ok: true };
    }
    case 'create': {
      const name = layoutName(command.name);
      const roi = layoutRoi(command.roi);
      if (!name) return { ok: false, reason: 'name' };
      if (!uniqueName(name)) return { ok: false, reason: 'duplicate' };
      if (!roi) return { ok: false, reason: 'roi' };
      const id = randomUUID();
      bearing.layouts.push({ id, name, roi, centered: false, revision: 0 });
      bearing.activeLayoutId = id;
      return { ok: true, id };
    }
    case 'calibrate': {
      if (!entry || entry.builtIn || bearing.activeLayoutId !== entry.id) break;
      const roi = layoutRoi(command.roi);
      if (!roi) return { ok: false, reason: 'roi' };
      bearing.layouts[index] = { ...entry, roi, centered: false, revision: entry.revision + 1 };
      return { ok: true };
    }
    case 'center': {
      if (!entry || entry.revision !== command.revision || bearing.activeLayoutId !== entry.id) break;
      const dcx = command.applied ? command.dcx : 0;
      const dcy = command.applied ? command.dcy : 0;
      if (!Number.isFinite(dcx) || !Number.isFinite(dcy) || Math.abs(dcx) > entry.roi.r / 2 || Math.abs(dcy) > entry.roi.r) break;
      const roi = layoutRoi({ ...entry.roi, cx: entry.roi.cx + dcx, cy: entry.roi.cy + dcy });
      if (!roi) break;
      bearing.layouts[index] = { ...entry, roi, centered: true, revision: entry.revision + 1 };
      return { ok: true };
    }
    default:
      break;
  }
  return { ok: false, reason: 'invalid' };
}

module.exports = { BUILTIN_LAYOUT_ID, DEFAULT_BEARING_LAYOUTS, loadBearingLayouts, activeBearingLayout, applyBearingLayout };
