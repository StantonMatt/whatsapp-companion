import { test, expect } from 'vitest';
import { StartupWatchdog } from '../src/main/startup-watchdog';
const session = { nonce: '00000000-0000-4000-8000-000000000001', generation: 1 };
const heartbeat = { ...session, phase: 'splash', progress: 1, visible: true, online: true };
const gates = { visible: true, closing: false };
const failed = { ...heartbeat, assetFailed: true, assetFailureKind: 'script', visible: false };
const hidden = { ...gates, visible: false };
function watchdog() { const instance = new StartupWatchdog(); instance.navigate(session); return instance; }
function feed(instance: StartupWatchdog, until: number, value = heartbeat, from = 0, gate = gates) {
  let result;
  for (let now = from; now <= until; now += 2000) result = instance.accept(value, now, gate);
  return result;
}
test('requires 60s confirmed splash and 30s without progress; heartbeat absence alone cannot reload', () => {
  const instance = watchdog();
  expect(feed(instance, 58_000)?.decision).not.toBe('reload');
  expect(instance.accept(heartbeat, 60_000, gates)?.decision).toBe('reload');
  const stalled = watchdog();
  feed(stalled, 48_000);
  const advanced = { ...heartbeat, progress: 2 };
  feed(stalled, 78_000, advanced, 50_000);
  expect(stalled.reloads).toBe(0);
  expect(stalled.accept(advanced, 80_000, gates)?.decision).toBe('reload');
  const missing = watchdog(); missing.accept(heartbeat, 0, gates);
  expect(missing.accept(heartbeat, 120_000, gates)?.decision).not.toBe('reload');
});
test.each(['shell', 'login', 'blocked', 'unknown'] as const)('%s never reloads', phase => {
  const instance = watchdog();
  feed(instance, 300_000, { ...heartbeat, phase });
  expect(instance.reloads).toBe(0);
});
test.each([
  [{ ...gates, visible: false }, heartbeat],
  [{ ...gates, closing: true }, heartbeat],
  [{ ...gates, busy: true }, heartbeat],
  [gates, { ...heartbeat, visible: false }],
  [gates, { ...heartbeat, online: false }]
])('visibility/online/closing/busy gates reset the observation grace period', (gate, value) => {
  const instance = watchdog(); feed(instance, 58_000);
  expect(instance.accept(value, 60_000, gate)?.decision).toBe('gated');
  feed(instance, 120_000, heartbeat, 62_000);
  expect(instance.reloads).toBe(0);
  expect(instance.accept(heartbeat, 122_000, gates)?.decision).toBe('reload');
});
test('navigation nonce/generation validation is strict and reload budget/120s spacing survive navigation', () => {
  const instance = watchdog();
  for (const raw of [{ ...heartbeat, nonce: '00000000-0000-4000-8000-000000000002' }, { ...heartbeat, generation: 0 }, { ...heartbeat, url: 'PRIVATE' }, { ...heartbeat, progress: 99 }, { ...heartbeat, online: 'true' }]) expect(instance.accept(raw, 0, gates)).toBeUndefined();
  expect(feed(instance, 60_000)?.decision).toBe('reload');
  const second = { ...session, nonce: '00000000-0000-4000-8000-000000000002', generation: 2 };
  instance.navigate(second);
  expect(instance.accept(heartbeat, 62_000, gates)).toBeUndefined();
  const updated = { ...heartbeat, ...second };
  expect(feed(instance, 178_000, updated, 62_000)?.decision).toBe('spacing');
  expect(instance.accept(updated, 180_000, gates)?.decision).toBe('reload');
  instance.navigate({ ...session, generation: 3 });
  expect(feed(instance, 500_000, { ...heartbeat, generation: 3 }, 182_000)?.decision).toBe('exhausted');
  expect(instance.reloads).toBe(2);
});
test.each([
  [hidden, failed], [gates, failed], [hidden, { ...failed, visible: true }]
])('asset failure confirms for 5s while either window or page is hidden', (gate, value) => {
  const instance = watchdog();
  expect(feed(instance, 4000, value, 0, gate)?.decision).toBe('waiting');
  expect(instance.accept(value, 4999, gate)?.decision).toBe('waiting');
  expect(instance.accept(value, 5000, gate)?.decision).toBe('reload');
});
test('asset confirmation starts at failure, restarts on progress and heartbeat gaps, and resets on navigation', () => {
  const instance = watchdog(); feed(instance, 20_000, { ...heartbeat, visible: false }, 0, hidden);
  feed(instance, 24_000, failed, 22_000, hidden);
  const advanced = { ...failed, progress: 2 };
  feed(instance, 30_000, advanced, 26_000, hidden);
  expect(instance.reloads).toBe(0);
  expect(instance.accept(advanced, 38_000, hidden)?.decision).toBe('progress');
  instance.navigate({ ...session, generation: 2 });
  const current = { ...advanced, generation: 2 };
  expect(feed(instance, 44_000, current, 40_000, hidden)?.decision).toBe('waiting');
  expect(instance.accept(current, 45_000, hidden)?.decision).toBe('reload');
});
test.each([
  [{ ...hidden, closing: true }, failed], [{ ...hidden, busy: true }, failed],
  [hidden, { ...failed, online: false }]
])('asset failure retains closing, busy and offline gates and confirms afresh when released', (gate, value) => {
  const instance = watchdog(); feed(instance, 4000, failed, 0, hidden);
  expect(feed(instance, 60_000, value, 6000, gate)?.decision).toBe('gated');
  expect(feed(instance, 66_000, failed, 62_000, hidden)?.decision).toBe('waiting');
  expect(instance.accept(failed, 67_000, hidden)?.decision).toBe('reload');
});
test.each(['shell', 'login', 'blocked', 'unknown'] as const)('asset failure cannot recover phase %s', phase => {
  const instance = watchdog(); feed(instance, 300_000, { ...failed, phase }, 0, hidden);
  expect(instance.reloads).toBe(0);
});
test('asset failure and ordinary recovery share launch budget and spacing', () => {
  const instance = watchdog();
  expect(feed(instance, 6000, failed, 0, hidden)?.decision).toBe('reload');
  instance.navigate({ ...session, generation: 2 });
  const current = { ...heartbeat, generation: 2 };
  expect(feed(instance, 124_000, current, 8000)?.decision).toBe('spacing');
  expect(instance.accept({ ...current, ...failed, generation: 2 }, 126_000, hidden)?.decision).toBe('progress');
  expect(feed(instance, 132_000, { ...failed, generation: 2 }, 128_000, hidden)?.decision).toBe('reload');
  instance.navigate({ ...session, generation: 3 });
  expect(feed(instance, 300_000, { ...failed, generation: 3 }, 134_000, hidden)?.decision).toBe('exhausted');
  expect(instance.reloads).toBe(2);
});
test('subsequent asset-failure reloads respect 120s spacing', () => {
  const instance = watchdog(); feed(instance, 6000, failed, 0, hidden);
  instance.navigate({ ...session, generation: 2 });
  const current = { ...failed, generation: 2 };
  expect(feed(instance, 124_000, current, 8000, hidden)?.decision).toBe('spacing');
  expect(instance.accept(current, 126_000, hidden)?.decision).toBe('reload');
});
