'use strict';

const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Super'];
const MODIFIER_ALIASES = new Map([
  ['ctrl', 'Ctrl'],
  ['control', 'Ctrl'],
  ['cmdorctrl', 'Ctrl'],
  ['commandorcontrol', 'Ctrl'],
  ['alt', 'Alt'],
  ['option', 'Alt'],
  ['shift', 'Shift'],
  ['meta', 'Super'],
  ['super', 'Super'],
  ['win', 'Super'],
  ['windows', 'Super'],
  ['command', 'Super'],
  ['cmd', 'Super']
]);
const KEY_ALIASES = new Map([
  ['arrowleft', 'Left'],
  ['left', 'Left'],
  ['arrowright', 'Right'],
  ['right', 'Right'],
  ['arrowup', 'Up'],
  ['up', 'Up'],
  ['arrowdown', 'Down'],
  ['down', 'Down'],
  ['escape', 'Esc'],
  ['esc', 'Esc'],
  ['return', 'Enter'],
  ['enter', 'Enter'],
  ['space', 'Space'],
  ['spacebar', 'Space'],
  ['tab', 'Tab'],
  ['backspace', 'Backspace'],
  ['delete', 'Delete'],
  ['del', 'Delete'],
  ['insert', 'Insert'],
  ['ins', 'Insert'],
  ['home', 'Home'],
  ['end', 'End'],
  ['pageup', 'PageUp'],
  ['pagedown', 'PageDown'],
  ['capslock', 'Capslock'],
  ['numlock', 'Numlock'],
  ['scrolllock', 'Scrolllock'],
  ['printscreen', 'PrintScreen'],
  ['plus', 'Plus']
]);

function normalizeAccelerator(value) {
  if (typeof value !== 'string') return '';
  const accelerator = value.trim();
  if (!accelerator) return '';

  const parts = accelerator === '+' ? ['Plus'] : accelerator.split('+').map((part) => part.trim());
  if (parts.length > 1 && parts.at(-1) === '' && parts.at(-2) === '') {
    parts.splice(-2, 2, 'Plus');
  }
  if (parts.some((part) => !part)) return '';

  const modifiers = new Set();
  let primaryKey = '';
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES.get(part.toLowerCase());
    if (modifier) {
      if (modifiers.has(modifier)) return '';
      modifiers.add(modifier);
      continue;
    }
    if (primaryKey) return '';
    primaryKey = KEY_ALIASES.get(part.toLowerCase()) || part;
    if (/^[a-z]$/i.test(primaryKey)) primaryKey = primaryKey.toUpperCase();
    const mouseKey = /^mouse([45])$/i.exec(primaryKey);
    if (mouseKey) primaryKey = 'Mouse' + mouseKey[1];
    const functionKey = /^f(\d{1,2})$/i.exec(primaryKey);
    if (functionKey && Number(functionKey[1]) >= 1 && Number(functionKey[1]) <= 24) {
      primaryKey = 'F' + Number(functionKey[1]);
    }
  }

  const orderedModifiers = MODIFIER_ORDER.filter((modifier) => modifiers.has(modifier));
  if (!primaryKey) return parts.length === 1 ? orderedModifiers[0] || '' : '';
  return [...orderedModifiers, primaryKey].join('+');
}

function mergeHotkeys(defaults, saved) {
  const defaultEntries = Object.entries(defaults || {});
  const knownActions = new Set(defaultEntries.map(([action]) => action));
  const merged = new Map();
  for (const [action, accelerator] of Object.entries(saved || {})) {
    if (!knownActions.has(action) || typeof accelerator !== 'string') continue;
    merged.set(action, normalizeAccelerator(accelerator));
  }
  const occupied = new Set([...merged.values()].filter(Boolean));
  for (const [action, accelerator] of defaultEntries) {
    if (merged.has(action)) continue;
    const normalized = normalizeAccelerator(accelerator);
    const available = normalized && !occupied.has(normalized) ? normalized : '';
    merged.set(action, available);
    if (available) occupied.add(available);
  }
  return Object.fromEntries(defaultEntries.map(([action]) => [action, merged.get(action)]));
}

function prepareHotkeyUpdate(previous, patch) {
  const entries = Object.entries(previous || {});
  const normalizedPrevious = Object.fromEntries(entries.map(([action, accelerator]) =>
    [action, normalizeAccelerator(accelerator)]));
  const requests = Object.fromEntries(Object.entries(patch || {}).flatMap(([action, accelerator]) => {
    if (!Object.hasOwn(normalizedPrevious, action)) return [];
    const normalized = normalizeAccelerator(accelerator);
    return normalized ? [[action, normalized]] : [];
  }));
  const requestedActions = Object.keys(requests);
  const hotkeys = { ...normalizedPrevious, ...requests };
  const swappedActions = new Set();

  for (const action of requestedActions) {
    if (requests[action] === normalizedPrevious[action]) continue;
    for (const [occupiedAction, occupiedAccelerator] of Object.entries(normalizedPrevious)) {
      if (occupiedAction === action || occupiedAccelerator !== requests[action] ||
        Object.hasOwn(requests, occupiedAction)) continue;
      hotkeys[occupiedAction] = normalizedPrevious[action];
      swappedActions.add(occupiedAction);
    }
  }

  const affectedActions = new Set([...requestedActions, ...swappedActions]);
  const occupants = new Map();
  for (const [action, accelerator] of Object.entries(hotkeys)) {
    if (!accelerator) continue;
    const occupiedActions = occupants.get(accelerator) || [];
    occupiedActions.push(action);
    occupants.set(accelerator, occupiedActions);
  }
  const conflict = [...occupants.values()].some((actions) =>
    actions.length > 1 && actions.some((action) => affectedActions.has(action)));
  if (conflict) {
    return { hotkeys: normalizedPrevious, rejected: requestedActions, swapped: [] };
  }
  return { hotkeys, rejected: [], swapped: [...swappedActions] };
}

module.exports = { normalizeAccelerator, mergeHotkeys, prepareHotkeyUpdate };
