import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { initialState, actionSchema } from '../src/shared/model';
import { Store } from '../src/main/store';
import { resetPreferences } from '../src/core/settings';

test('old manifests load with unset desktop settings; saved answers survive defaults reset and restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'companion-desktop-state-'));
  try {
    const { desktop: _desktop, ...old } = initialState();
    writeFileSync(join(directory, 'companion.json'), JSON.stringify(old));
    const store = new Store(directory); expect(store.state.desktop).toEqual({});
    store.update(state => { state.desktop = { notifications: 'denied', startAtLogin: true }; });
    store.update(state => resetPreferences(state, 'global'));
    expect(new Store(directory).state.desktop).toEqual({ notifications: 'denied', startAtLogin: true });
    expect(JSON.parse(readFileSync(join(directory, 'companion.json'), 'utf8')).desktop.notifications).toBe('denied');
    for (const scope of ['global', '123@c.us']) for (const patch of [{ notifications: 'allowed' }, { startAtLogin: false }, { desktop: {} }])
      expect(actionSchema.safeParse({ type: 'preferences', scope, patch }).success).toBe(false);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('schema v1 without desktop settings still migrates with both answers unset', () => {
  const directory = mkdtempSync(join(tmpdir(), 'companion-desktop-v1-'));
  try {
    const { desktop: _desktop, stickerGroups: _groups, ...old } = initialState();
    writeFileSync(join(directory, 'companion.json'), JSON.stringify({ ...old, version: 1 }));
    const store = new Store(directory);
    expect(store.state.version).toBe(2); expect(store.state.desktop).toEqual({});
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test.each([false, true])('missing AI switch is initialized from key presence once and persisted (%s)', hasKey => {
  const dir = mkdtempSync(join(tmpdir(), 'companion-ai-startup-'));
  try {
    const old = initialState(); const { aiFeatures: _missing, ...global } = old.global;
    writeFileSync(join(dir, 'companion.json'), JSON.stringify({ ...old, global }));
    const store = new Store(dir);
    expect(store.state.global.aiFeatures).toBe(false);
    store.initializeAiFeatures(hasKey);
    expect(store.state.global.aiFeatures).toBe(hasKey);
    store.initializeAiFeatures(!hasKey);
    expect(store.state.global.aiFeatures).toBe(hasKey);
    const restored = new Store(dir); restored.initializeAiFeatures(!hasKey);
    expect(restored.state.global.aiFeatures).toBe(hasKey);
    expect(JSON.parse(readFileSync(join(dir, 'companion.json'), 'utf8')).global.aiFeatures).toBe(hasKey);
    expect(store.state.version).toBe(2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('fresh profiles persist the off decision even though it equals the schema default', () => {
  const dir = mkdtempSync(join(tmpdir(), 'companion-ai-fresh-'));
  try {
    const store = new Store(dir); expect(store.state.global.aiFeatures).toBe(false);
    store.initializeAiFeatures(false);
    expect(JSON.parse(readFileSync(join(dir, 'companion.json'), 'utf8')).global.aiFeatures).toBe(false);
    new Store(dir).initializeAiFeatures(true);
    expect(new Store(dir).state.global.aiFeatures).toBe(false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
