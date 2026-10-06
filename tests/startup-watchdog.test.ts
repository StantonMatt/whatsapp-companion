import { test, expect } from 'vitest';
import { StartupWatchdog } from '../src/main/startup-watchdog';
const session = { nonce: '00000000-0000-4000-8000-000000000001', generation: 1 };
const heartbeat = { ...session, phase: 'splash', progress: 1, visible: true, online: true };
const gates = { visible: true, closing: false };
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
