// @vitest-environment jsdom
import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { BootDetector, classifyBoot, BOOT_MAX_DEFERRAL_MS, BOOT_UNKNOWN_GRACE_MS } from '../src/connector/boot';
import { DomConnector } from '../src/connector/dom';
import type { RemoteEvent } from '../src/shared/connector';
import { StartupWatchdog } from '../src/main/startup-watchdog';
import { bootHeartbeatSchema, bootStructureSchema } from '../src/shared/boot';
import { StartupDiagnostics } from '../src/main/startup-diagnostics';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';

// jsdom has no layout; visible fixture markers need explicit positive geometry.
beforeEach(() => { vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: 100, height: 100 } as DOMRect); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); document.body.replaceChildren(); });
test.each([
  ['<div id="initial_startup"><progress max="100" value="43"></progress></div>', 'splash', 4],
  ['<div id="initial_startup"><progress value="0.5"></progress></div>', 'splash', 5],
  ['<div data-testid="startup-screen"><div role="progressbar" aria-valuenow="75" aria-valuemax="100"></div></div>', 'splash', 7],
  ['<section><div><progress value="43" max="100"></progress></div></section>', 'splash', 4],
  ['<div role="progressbar" aria-valuenow="75" aria-valuemax="100"></div>', 'splash', 7],
  ['<div data-testid="qrcode" data-ref="PRIVATE"><canvas></canvas></div>', 'login', null],
  ['<div class="landing-wrapper"></div>', 'login', null],
  ['<div id="pane-side"></div>', 'shell', null],
  ['<div id="pane-side"><progress value="0.5"></progress></div>', 'shell', null],
  ['<div data-testid="qrcode"><canvas></canvas><progress value="0.5"></progress></div>', 'login', null],
  ['<div data-testid="account-warning"></div><progress></progress>', 'blocked', null],
  ['<nav><button data-navbar-item="true"></button></nav>', 'shell', null],
  ['<div data-testid="side-panel"></div>', 'shell', null],
  ['<div data-testid="account-restriction"></div>', 'blocked', null],
  ['<div>Loading PRIVATE CHAT QR VALUE</div><div role="progressbar"></div>', 'splash', null],
  ['<div hidden><div id="pane-side"></div></div>', 'unknown', null]
])('fixed markers classify %s', (html, phase, progress) => {
  document.body.innerHTML = html!;
  expect(classifyBoot(document)).toMatchObject({ phase, progress });
  expect(JSON.stringify(classifyBoot(document))).not.toContain('PRIVATE');
});
test.each([
  '<progress hidden></progress>', '<div hidden><progress></progress></div>',
  '<div aria-hidden="true"><div role="progressbar"></div></div>',
  '<div style="display:none"><progress></progress></div>',
  '<progress style="visibility:hidden"></progress>', '<progress style="visibility:collapse"></progress>',
  '<dialog><progress></progress></dialog>'
])('hidden generic progress remains unknown: %s', html => {
  document.body.innerHTML = html;
  expect(classifyBoot(document)).toMatchObject({ phase: 'unknown', progress: null,
    structure: { visibleProgress: false, tagName: null, ancestors: [] } });
});
test('progress fallback skips hidden candidates and requires positive geometry', () => {
  document.body.innerHTML = '<progress hidden value="0.1"></progress><progress value="0.7"></progress>';
  expect(classifyBoot(document)).toMatchObject({ phase: 'splash', progress: 7 });
  document.body.lastElementChild!.getBoundingClientRect = () => ({ width: 0, height: 100 } as DOMRect);
  expect(classifyBoot(document).phase).toBe('unknown');
});
test('fallback signature contains only bounded allowlisted ancestor structure, never page content', () => {
  document.body.innerHTML = '<article id="not-collected"><section id="app" data-testid="loading-spinner" class="PRIVATE CLASS"><div id="contact@PRIVATE" data-testid="PRIVATE QR VALUE"><div id="main" data-testid="popup-contents" title="PRIVATE NAME"><progress value="0.4" data-ref="PRIVATE QR">PRIVATE MESSAGE</progress></div></div></section></article>';
  const observation = classifyBoot(document);
  expect(observation.structure).toEqual({ visibleProgress: true, tagName: 'PROGRESS', ancestors: [
    { tagName: 'DIV', id: 'main', idPresent: true, testId: 'popup-contents', testIdPresent: true },
    { tagName: 'DIV', id: 'other', idPresent: true, testId: 'other', testIdPresent: true },
    { tagName: 'SECTION', id: 'app', idPresent: true, testId: 'loading-spinner', testIdPresent: true }
  ] });
  expect(bootStructureSchema.safeParse(observation.structure).success).toBe(true);
  expect(JSON.stringify(observation)).not.toMatch(/PRIVATE|class|text|title|data-ref|not-collected/);
});
test.each(['contact@domain', 'private name', 'qr/value', '1234', 'x'.repeat(42), 'safe\n', 'user_AliceSmith', 'token_abcdEFGH1234', 'safe-child', ''])('nonallowlisted structural identifiers are redacted and rejected: %j', value => {
  document.body.innerHTML = '<section><progress></progress></section>';
  document.body.firstElementChild!.setAttribute('id', value);
  document.body.firstElementChild!.setAttribute('data-testid', value);
  const signature = classifyBoot(document).structure!;
  expect(signature.ancestors[0]).toEqual({ tagName: 'SECTION', id: 'other', idPresent: true, testId: 'other', testIdPresent: true });
  expect(bootStructureSchema.safeParse(signature).success).toBe(true);
  for (const field of ['id', 'testId']) expect(bootStructureSchema.safeParse({ ...signature,
    ancestors: [{ ...signature.ancestors[0], [field]: value }] }).success).toBe(false);
  if (value) expect(JSON.stringify(signature)).not.toContain(value);
});
test('signature distinguishes absent attributes from present but unrecognized attributes', () => {
  document.body.innerHTML = '<section><progress></progress></section>';
  expect(classifyBoot(document).structure?.ancestors[0]).toEqual({
    tagName: 'SECTION', id: null, idPresent: false, testId: null, testIdPresent: false
  });
});
test.each(['user-AliceSmith', 'token-abcdEFGH1234'])('custom tag %s is redacted and cannot reach startup.log', async tag => {
  document.body.innerHTML = `<${tag} role="progressbar"></${tag}>`;
  expect(classifyBoot(document).structure?.tagName).toBe('other');
  document.body.innerHTML = `<${tag}><progress></progress></${tag}>`;
  const signature = classifyBoot(document).structure!;
  expect(signature.ancestors[0].tagName).toBe('other');
  const directory = await mkdtemp(join(tmpdir(), 'startup-tag-privacy-'));
  try {
    const logger = new StartupDiagnostics(directory);
    logger.record('structure', { structure: signature });
    await logger.flush();
    const raw = await readFile(join(directory, 'diagnostics/startup.log'), 'utf8');
    expect(raw.toLowerCase()).not.toContain(tag.toLowerCase());
    expect(JSON.parse(raw).structure).toEqual(signature);
  } finally { await rm(directory, { recursive: true, force: true }); }
  for (const value of [tag, tag.toUpperCase()]) {
    expect(bootStructureSchema.safeParse({ ...signature, tagName: value }).success).toBe(false);
    expect(bootStructureSchema.safeParse({ ...signature, ancestors: [{ ...signature.ancestors[0], tagName: value }] }).success).toBe(false);
  }
});
test('standard SVG structural tags remain allowlisted', () => {
  document.body.innerHTML = '<svg><g><rect role="progressbar"></rect></g></svg>';
  expect(classifyBoot(document).structure).toMatchObject({ tagName: 'rect', ancestors: [{ tagName: 'g' }, { tagName: 'svg' }, { tagName: 'BODY' }] });
  expect(bootStructureSchema.safeParse(classifyBoot(document).structure).success).toBe(true);
});
test('heartbeat schema contains no unbounded or free-form string fields', () => {
  let stringFields = 0;
  function check(node: unknown, path = '') {
    if (!node || typeof node !== 'object') return;
    const schema = node as Record<string, unknown>;
    if (schema.type === 'string') {
      stringFields++;
      // The session nonce is a fixed-width UUID; all page-derived strings are enums.
      expect(Array.isArray(schema.enum) || (path.endsWith('.nonce') && schema.format === 'uuid' &&
        schema.minLength === 36 && schema.maxLength === 36), path).toBe(true);
    }
    for (const [key, value] of Object.entries(schema)) check(value, `${path}.${key}`);
  }
  check(z.toJSONSchema(bootHeartbeatSchema));
  expect(stringFields).toBeGreaterThan(0);
});
test.each(['user_AliceSmith', 'token_abcdEFGH1234'])('page identifier %s never reaches startup.log', async value => {
  document.body.innerHTML = `<section id="${value}" data-testid="${value}"><progress></progress></section>`;
  const observation = classifyBoot(document);
  const directory = await mkdtemp(join(tmpdir(), 'startup-page-privacy-'));
  try {
    const logger = new StartupDiagnostics(directory);
    logger.record('structure', { structure: observation.structure });
    await logger.flush();
    const raw = await readFile(join(directory, 'diagnostics/startup.log'), 'utf8');
    expect(raw).not.toContain(value);
    expect(JSON.parse(raw).structure.ancestors[0]).toEqual({
      tagName: 'SECTION', id: 'other', idPresent: true, testId: 'other', testIdPresent: true
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test.each(['app', 'main', 'pane-side', 'side', 'initial_startup', 'startup-screen'])('main validation accepts allowlisted structural identifier %s', value => {
  expect(bootStructureSchema.safeParse({ visibleProgress: true, tagName: 'PROGRESS', ancestors: [
    { tagName: 'DIV', id: value, idPresent: true, testId: value, testIdPresent: true }
  ] }).success).toBe(true);
});
test('strict heartbeat validation rejects extra content and unbounded or inconsistent signatures', () => {
  const signature = { visibleProgress: true, tagName: 'PROGRESS', ancestors: [{ tagName: 'DIV', id: null, idPresent: false, testId: null, testIdPresent: false }] };
  const heartbeat = { nonce: '00000000-0000-4000-8000-000000000001', generation: 1, phase: 'splash', progress: null, visible: true, online: true };
  expect(bootHeartbeatSchema.safeParse({ ...heartbeat, structure: signature }).success).toBe(true);
  for (const structure of [
    { ...signature, text: 'PRIVATE MESSAGE' }, { ...signature, classes: 'PRIVATE' },
    { ...signature, ancestors: [{ ...signature.ancestors[0], title: 'PRIVATE NAME' }] },
    { ...signature, ancestors: [{ ...signature.ancestors[0], idPresent: true }] },
    { ...signature, ancestors: [{ ...signature.ancestors[0], testId: 'other' }] },
    { ...signature, ancestors: Array(4).fill(signature.ancestors[0]) },
    { ...signature, visibleProgress: false }, { ...signature, tagName: null },
    { ...signature, tagName: 'PRIVATE TEXT' }, { ...signature, tagName: 'DIV\n' }
  ]) expect(bootHeartbeatSchema.safeParse({ ...heartbeat, structure }).success).toBe(false);
});
test.each(['', '<section><progress value="0.5"></progress></section>'])('signature is emitted on only the first eligible heartbeat, including after stop/start: %s', html => {
  vi.useFakeTimers(); document.body.innerHTML = html;
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete');
  const heartbeat = vi.fn(), detector = new BootDetector(document, heartbeat, () => {});
  detector.start();
  try {
    expect(Boolean(heartbeat.mock.calls[0][0].structure)).toBe(Boolean(html));
    vi.advanceTimersByTime(6000);
    expect(heartbeat.mock.calls.filter(([observation]) => observation.structure)).toHaveLength(1);
    detector.stop(); detector.start(); vi.advanceTimersByTime(4000);
    expect(heartbeat.mock.calls.filter(([observation]) => observation.structure)).toHaveLength(1);
  } finally { detector.stop(); }
});
test('known splash markers emit the one-shot signature immediately even while loading', () => {
  vi.useFakeTimers(); document.body.innerHTML = '<div id="initial_startup"></div>';
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
  const heartbeat = vi.fn(), detector = new BootDetector(document, heartbeat, () => {});
  detector.start();
  try {
    expect(heartbeat.mock.calls[0][0].structure).toEqual({ visibleProgress: false, tagName: null, ancestors: [] });
    document.body.innerHTML = '<progress></progress>'; vi.advanceTimersByTime(2000);
    expect(heartbeat.mock.calls[1][0].structure).toBeUndefined();
    vi.advanceTimersByTime(4000);
    expect(heartbeat.mock.calls.filter(([observation]) => observation.structure)).toHaveLength(1);
  } finally { detector.stop(); }
});
test.each(['loading', 'interactive'] as const)('empty %s document preserves its signature for a later progress-only splash', readyState => {
  vi.useFakeTimers(); vi.spyOn(document, 'readyState', 'get').mockReturnValue(readyState);
  const heartbeat = vi.fn(), detector = new BootDetector(document, heartbeat, () => {}, 1000);
  detector.start();
  try {
    vi.advanceTimersByTime(BOOT_UNKNOWN_GRACE_MS + 1000);
    expect(heartbeat.mock.calls.every(([observation]) => observation.structure === undefined)).toBe(true);
    document.body.innerHTML = '<section><progress></progress></section>';
    vi.advanceTimersByTime(1000);
    expect(heartbeat).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'splash', structure: expect.objectContaining({
      visibleProgress: true, tagName: 'PROGRESS', ancestors: expect.arrayContaining([expect.objectContaining({ tagName: 'SECTION' })])
    }) }));
    vi.advanceTimersByTime(6000);
    expect(heartbeat.mock.calls.filter(([observation]) => observation.structure)).toHaveLength(1);
  } finally { detector.stop(); }
});
test('unknown diagnostic requires completion and the existing grace, even beyond the activation cap', () => {
  vi.useFakeTimers(); const state = vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
  const heartbeat = vi.fn(), detector = new BootDetector(document, heartbeat, () => {}, 1000);
  detector.start();
  try {
    vi.advanceTimersByTime(BOOT_MAX_DEFERRAL_MS);
    expect(heartbeat.mock.calls.every(([observation]) => observation.structure === undefined)).toBe(true);
    state.mockReturnValue('complete'); vi.advanceTimersByTime(1000);
    expect(heartbeat.mock.calls.at(-1)![0].structure).toBeUndefined();
    vi.advanceTimersByTime(1000);
    expect(heartbeat.mock.calls.at(-1)![0].structure).toEqual({ visibleProgress: false, tagName: null, ancestors: [] });
    vi.advanceTimersByTime(3000);
    expect(heartbeat.mock.calls.filter(([observation]) => observation.structure)).toHaveLength(1);
  } finally { detector.stop(); }
});
test('indeterminate or malformed progress never invents progress', () => {
  for (const html of ['<progress></progress>', '<progress value="NaN"></progress>', '<progress value="1" max="0"></progress>']) {
    document.body.innerHTML = `<div id="initial_startup">${html}</div>`;
    expect(classifyBoot(document).progress).toBeNull();
  }
});
test.each(['id="initial_startup"', 'data-testid="startup-screen"'])('known splash %s ignores progress outside its container', marker => {
  document.body.innerHTML = `<progress value="0.1"></progress><section ${marker}><progress value="0.7"></progress></section>`;
  expect(classifyBoot(document)).toMatchObject({ phase: 'splash', progress: 7 });
  const progress = document.querySelector('section progress')!;
  progress.setAttribute('hidden', '');
  expect(classifyBoot(document)).toMatchObject({ phase: 'splash', progress: null });
  progress.remove();
  expect(classifyBoot(document)).toMatchObject({ phase: 'splash', progress: null });
});
test('stationary outer indicator cannot trigger reload while known splash progress advances', () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<progress value="0"></progress><section id="initial_startup"><progress value="0" max="100"></progress></section>';
  const progress = document.querySelector('section progress')!;
  const session = { nonce: '00000000-0000-4000-8000-000000000001', generation: 1 };
  const watchdog = new StartupWatchdog(); watchdog.navigate(session);
  const started = Date.now(), observations: number[] = [];
  const detector = new BootDetector(document, observation => {
    observations.push(observation.progress!);
    watchdog.accept({ ...session, ...observation }, Date.now() - started, { visible: true, closing: false });
  }, () => {});
  detector.start();
  try {
    for (let value = 10; value <= 80; value += 10) {
      progress.setAttribute('value', String(value));
      vi.advanceTimersByTime(10_000);
      expect(watchdog.reloads).toBe(0);
    }
    expect(new Set(observations)).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7, 8]));
  } finally { detector.stop(); }
});
test.each([
  ['<div id="pane-side"></div>', 'shell'],
  ['<div data-testid="qrcode"><canvas></canvas></div>', 'login'],
  ['<div data-testid="account-warning"></div>', 'blocked']
])('%s activates immediately in phase %s and heartbeats continue', (html, phase) => {
  vi.useFakeTimers(); document.body.innerHTML = html;
  const activate = vi.fn(), heartbeat = vi.fn(), detector = new BootDetector(document, heartbeat, activate);
  detector.start();
  try {
    expect(activate).toHaveBeenCalledExactlyOnceWith('phase');
    expect(heartbeat).toHaveBeenLastCalledWith(expect.objectContaining({ phase }));
    vi.advanceTimersByTime(24_000);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(heartbeat.mock.calls.length).toBeGreaterThan(1);
    expect(vi.getTimerCount()).toBe(1);
  } finally { detector.stop(); }
});
test('early empty document then splash keeps connector work deferred', () => {
  vi.useFakeTimers();
  const state = vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
  const observer = vi.spyOn(MutationObserver.prototype, 'observe'), start = vi.spyOn(DomConnector.prototype, 'start');
  const connector = new DomConnector(document, () => {}), heartbeat = vi.fn();
  const detector = new BootDetector(document, heartbeat, () => connector.start());
  detector.start();
  try {
    expect(heartbeat).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'unknown' }));
    expect(start).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    document.body.innerHTML = '<section><progress></progress></section>'; state.mockReturnValue('complete');
    vi.advanceTimersByTime(9000);
    expect(heartbeat).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'splash' }));
    expect(start).not.toHaveBeenCalled(); expect(observer).not.toHaveBeenCalled();
    expect(document.querySelector('#companion-overlay')).toBeNull();
    expect(vi.getTimerCount()).toBe(2);
  } finally { detector.stop(); if (start.mock.calls.length) connector.stop(); }
});
test.each([
  ['<div id="pane-side"></div>', 'shell'],
  ['<div data-testid="qrcode"></div>', 'login'],
  ['<div data-testid="account-warning"></div>', 'blocked']
])('empty document then %s activates during grace without waiting for completion', (html, phase) => {
  vi.useFakeTimers(); vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
  const activate = vi.fn(), heartbeat = vi.fn(), detector = new BootDetector(document, heartbeat, activate);
  detector.start();
  try {
    expect(activate).not.toHaveBeenCalled();
    document.body.innerHTML = html; vi.advanceTimersByTime(2000);
    expect(activate).toHaveBeenCalledExactlyOnceWith('phase');
    expect(heartbeat).toHaveBeenLastCalledWith(expect.objectContaining({ phase }));
    vi.advanceTimersByTime(24_000); expect(activate).toHaveBeenCalledTimes(1);
  } finally { detector.stop(); }
});
test('persistently unknown complete document activates after the initial grace', () => {
  vi.useFakeTimers(); vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete');
  const activate = vi.fn(), heartbeat = vi.fn(), detector = new BootDetector(document, heartbeat, activate, 1000);
  detector.start();
  try {
    vi.advanceTimersByTime(BOOT_UNKNOWN_GRACE_MS - 1); expect(activate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(activate).toHaveBeenCalledExactlyOnceWith('phase');
    vi.advanceTimersByTime(24_000);
    expect(activate).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(1);
    expect(heartbeat).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'unknown' }));
  } finally { detector.stop(); }
});
test.each(['loading', 'interactive'] as const)('unknown %s document waits for completion plus another tick after grace', readyState => {
  vi.useFakeTimers(); const state = vi.spyOn(document, 'readyState', 'get').mockReturnValue(readyState);
  const activate = vi.fn(), detector = new BootDetector(document, () => {}, activate, 1000);
  detector.start();
  try {
    vi.advanceTimersByTime(7000); expect(activate).not.toHaveBeenCalled();
    state.mockReturnValue('complete'); vi.advanceTimersByTime(1000); expect(activate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000); expect(activate).toHaveBeenCalledExactlyOnceWith('phase');
  } finally { detector.stop(); }
});
test('unknown document still loading activates unconditionally at the 20s cap', () => {
  vi.useFakeTimers(); vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
  const activate = vi.fn(), detector = new BootDetector(document, () => {}, activate, 7000);
  detector.start();
  try {
    vi.advanceTimersByTime(BOOT_MAX_DEFERRAL_MS - 1); expect(activate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(activate).toHaveBeenCalledExactlyOnceWith('timeout');
    vi.advanceTimersByTime(28_000); expect(activate).toHaveBeenCalledTimes(1);
  } finally { detector.stop(); }
});
test('timer heartbeat works without rAF; splash defers full connector work then shell activates once', () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<section><progress></progress></section>';
  const observer = vi.spyOn(MutationObserver.prototype, 'observe');
  const start = vi.spyOn(DomConnector.prototype, 'start');
  const connector = new DomConnector(document, () => {});
  const heartbeat = vi.fn();
  const detector = new BootDetector(document, heartbeat, () => connector.start());
  detector.start();
  try {
    vi.advanceTimersByTime(4000);
    expect(start).not.toHaveBeenCalled(); expect(observer).not.toHaveBeenCalled();
    expect(document.querySelector('#companion-overlay')).toBeNull();
    expect(vi.getTimerCount()).toBe(2); // Only heartbeat and deadline, no connector polling/discovery.
    expect(heartbeat).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'splash' }));
    document.body.innerHTML = '<div id="pane-side"></div>';
    vi.advanceTimersByTime(2000);
    expect(start).toHaveBeenCalledTimes(1); expect(observer).toHaveBeenCalledTimes(1);
    expect(document.querySelector('#companion-overlay')).not.toBeNull();
    // Shell loss keeps today's active connector behavior; activation remains one-shot.
    document.body.replaceChildren(); vi.advanceTimersByTime(2000);
    document.body.innerHTML = '<div id="pane-side"></div>'; vi.advanceTimersByTime(20_000);
    expect(start).toHaveBeenCalledTimes(1);
    expect(heartbeat).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'shell' }));
  } finally { detector.stop(); if (start.mock.calls.length) connector.stop(); }
});
test('progress-only splash activates at the 20s deadline even between heartbeat ticks', () => {
  vi.useFakeTimers(); document.body.innerHTML = '<section><progress></progress></section>';
  const activate = vi.fn(), heartbeat = vi.fn(), detector = new BootDetector(document, heartbeat, activate, 7000);
  detector.start();
  try {
    vi.advanceTimersByTime(BOOT_MAX_DEFERRAL_MS - 1);
    expect(activate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(activate).toHaveBeenCalledExactlyOnceWith('timeout');
    expect(heartbeat).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'splash' }));
    vi.advanceTimersByTime(28_000);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(heartbeat.mock.calls.length).toBeGreaterThan(4);
  } finally { detector.stop(); }
  expect(vi.getTimerCount()).toBe(0);
});
test('stopping during splash cancels deferred activation and heartbeats', () => {
  vi.useFakeTimers(); document.body.innerHTML = '<div id="initial_startup"></div>';
  const activate = vi.fn(), heartbeat = vi.fn(), detector = new BootDetector(document, heartbeat, activate);
  detector.start(); detector.stop(); vi.advanceTimersByTime(30_000);
  expect(activate).not.toHaveBeenCalled(); expect(heartbeat).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
test.each([
  ['<div id="initial_startup"></div>', 1],
  ['<section><progress value="0.1"></progress></section>', 1],
  ['<div>Unrecognized WhatsApp markup</div>', 0],
  ['<div data-testid="qrcode"></div>', 0],
  ['<div data-testid="account-warning"></div>', 0]
])('activated connector heartbeats preserve confirmed-splash watchdog policy for %s', (html, reloads) => {
  vi.useFakeTimers(); document.body.innerHTML = html;
  const session = { nonce: '00000000-0000-4000-8000-000000000001', generation: 1 };
  const watchdog = new StartupWatchdog(); watchdog.navigate(session);
  const started = Date.now(), activate = vi.fn();
  const detector = new BootDetector(document, observation => {
    watchdog.accept({ ...session, ...observation }, Date.now() - started, { visible: true, closing: false });
  }, activate);
  detector.start();
  try {
    vi.advanceTimersByTime(20_000); expect(activate).toHaveBeenCalledTimes(1);
    expect(watchdog.reloads).toBe(0);
    vi.advanceTimersByTime(40_000); expect(watchdog.reloads).toBe(reloads);
    expect(activate).toHaveBeenCalledTimes(1);
  } finally { detector.stop(); }
});
test.each([
  ['<div data-testid="qrcode" data-ref="PRIVATE"><canvas></canvas></div>', 'login', 'logged-out'],
  ['<div data-testid="logged-out"></div>', 'login', 'logged-out'],
  ['<div data-testid="account-warning" role="dialog">Sua conta restrita PRIVATE</div>', 'blocked', 'account-warning'],
  ['<div data-testid="account-restriction">Your account is restricted PRIVATE</div>', 'blocked', 'account-warning'],
  // Unrecognized account UI still goes through the connector's established safety checks.
  ['<div role="alert">Your account is restricted PRIVATE</div>', 'unknown', 'account-warning']
])('activation on %s preserves safety signal in %s', (html, phase, reason) => {
  vi.useFakeTimers(); document.body.innerHTML = html;
  document.body.firstElementChild!.getBoundingClientRect = () => ({ width: 200, height: 200 } as DOMRect);
  const events: RemoteEvent[] = [], connector = new DomConnector(document, event => events.push(event));
  const heartbeat = vi.fn(), detector = new BootDetector(document, heartbeat, () => connector.start());
  detector.start();
  try {
    if (phase === 'unknown') {
      expect(events).toEqual([]);
      vi.advanceTimersByTime(6000);
    }
    expect(heartbeat).toHaveBeenLastCalledWith(expect.objectContaining({ phase }));
    expect(events.filter(event => event.type === 'accountSafety')).toEqual([{ type: 'accountSafety', reason }]);
    expect(events.find(event => event.type === 'snapshot')).toMatchObject({ snapshot: { ready: false } });
    expect(JSON.stringify(events.filter(event => event.type === 'accountSafety'))).not.toContain('PRIVATE');
    document.body.firstElementChild!.remove(); vi.advanceTimersByTime(1000);
    expect(events.filter(event => event.type === 'accountSafety').at(-1)).toEqual({ type: 'accountSafety', reason: null });
  } finally { detector.stop(); connector.stop(); }
});
test('mutation relevance filtering precedes traversal and total subtree traversal is bounded', () => {
  document.body.innerHTML = '<div id="main"><div data-id="false_123@c.us_a"><span class="selectable-text copyable-text">Old</span></div></div><div id="companion-overlay"></div><div id="unrelated"></div>';
  const connector = new DomConnector(document, () => {});
  const realWalker = document.createTreeWalker.bind(document);
  const walker = vi.spyOn(document, 'createTreeWalker');
  const mutations = (records: MutationRecord[]) => (connector as unknown as { mutations(records: MutationRecord[], schedule: boolean): void }).mutations(records, false);
  const subtree = document.createElement('div'); subtree.innerHTML = '<span></span>'.repeat(2000);
  const record = (target: Element) => ({ type: 'childList', target, addedNodes: [subtree], removedNodes: [], attributeName: null }) as unknown as MutationRecord;
  mutations([record(document.querySelector('#companion-overlay')!), record(document.querySelector('#unrelated')!)]);
  expect(walker.mock.calls.filter(call => call[1] === NodeFilter.SHOW_ELEMENT)).toHaveLength(0);
  let visits = 0;
  walker.mockImplementation((root, show, filter) => {
    const result = realWalker(root, show, filter), next = result.nextNode.bind(result);
    result.nextNode = () => { if (show === NodeFilter.SHOW_ELEMENT) visits++; return next(); }; return result;
  });
  // Cache a bubble, simulate detached editing then a large reattachment. The
  // fallback must invalidate cached messages even when traversal is exhausted.
  connector.read(); document.querySelector('.selectable-text')!.textContent = 'Updated';
  mutations([record(document.querySelector('#main')!)]);
  expect(visits).toBeLessThanOrEqual(513);
  expect(connector.read().messages[0]?.text).toBe('Updated');
});


test.each([
  ['<div id="pane-side" hidden></div><div data-testid="main-navigation"></div>', 'shell'],
  ['<div data-testid="qrcode" hidden></div><div data-testid="link-device"></div>', 'login'],
  ['<div data-testid="account-warning" hidden></div><div data-testid="account-restriction"></div>', 'blocked'],
  ['<div id="initial_startup" hidden></div><div data-testid="startup-screen"></div>', 'splash']
])('hidden first candidate does not mask later visible %s', (html, phase) => {
  document.body.innerHTML = html + '<div id="initial_startup"></div>';
  expect(classifyBoot(document).phase).toBe(phase);
});
test.each([
  '<style>#initial_startup { display: none }</style><div id="initial_startup"></div>',
  '<style>.concealed { visibility: hidden }</style><section class="concealed"><div id="initial_startup"></div></section>',
  '<style>#initial_startup { visibility: collapse }</style><div id="initial_startup"></div>',
  '<dialog><div id="initial_startup"></div></dialog>',
  '<section hidden><div id="initial_startup"></div></section>',
  '<section aria-hidden="true"><div id="initial_startup"></div></section>'
])('hidden splash stays unknown and cannot authorize watchdog recovery: %s', html => {
  document.body.innerHTML = html;
  const watchdog = new StartupWatchdog(), session = { nonce: '00000000-0000-4000-8000-000000000001', generation: 1 };
  watchdog.navigate(session);
  for (let now = 0; now <= 200_000; now += 2000) {
    const observation = classifyBoot(document);
    expect(observation.phase).toBe('unknown');
    watchdog.accept({ ...session, ...observation }, now, { visible: true, closing: false });
  }
  expect(watchdog.reloads).toBe(0);
});
test.each([{ width: 0, height: 100 }, { width: 100, height: 0 }, { width: 0, height: 0 }])('zero-size splash %j is unknown', bounds => {
  document.body.innerHTML = '<div id="initial_startup"></div>';
  document.body.firstElementChild!.getBoundingClientRect = () => bounds as DOMRect;
  expect(classifyBoot(document).phase).toBe('unknown');
});
test('open dialog markers count, and ancestor inspection stays bounded', () => {
  document.body.innerHTML = '<dialog open><div id="initial_startup"></div></dialog>';
  expect(classifyBoot(document).phase).toBe('splash');
  document.body.innerHTML = '<section>'.repeat(40) + '<div id="initial_startup"></div>' + '</section>'.repeat(40);
  const styles = vi.spyOn(window, 'getComputedStyle');
  expect(classifyBoot(document).phase).toBe('unknown');
  expect(styles).toHaveBeenCalledTimes(32);
});


test('stylesheet-hidden first shell candidate yields to visible navigation and activates without deferral', () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<style>#pane-side { display: none }</style><div id="pane-side"></div><nav data-testid="main-navigation"></nav><div id="initial_startup"></div>';
  const activate = vi.fn(), heartbeat = vi.fn(), detector = new BootDetector(document, heartbeat, activate);
  detector.start();
  try {
    expect(activate).toHaveBeenCalledExactlyOnceWith('phase');
    expect(heartbeat).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'shell', chatListReady: false }));
    document.querySelector('style')!.remove(); document.querySelector('#initial_startup')!.remove();
    vi.advanceTimersByTime(2000);
    expect(heartbeat).toHaveBeenLastCalledWith(expect.objectContaining({ phase: 'shell', chatListReady: true }));
  } finally { detector.stop(); }
});

test.each([
  ['<div id="pane-side"></div>', true],
  ['<div data-testid="chat-list"></div>', true],
  ['<div data-testid="side-panel"></div>', false],
  ['<div id="pane-side" aria-busy="true"></div>', false],
  ['<div id="pane-side"><progress></progress></div>', false],
  ['<div id="pane-side"><div data-testid="loading-spinner"></div></div>', false],
  ['<div id="pane-side"><progress hidden></progress></div>', true],
  ['<div id="pane-side"></div><div id="initial_startup"></div>', false],
  ['<nav data-testid="main-navigation"></nav><div id="pane-side" hidden></div>', false]
])('chat-list readiness requires a loaded visible list: %s', (html, chatListReady) => {
  document.body.innerHTML = html as string;
  const observation = classifyBoot(document);
  expect(observation).toMatchObject({ phase: 'shell', chatListReady });
  const session = { nonce: '00000000-0000-4000-8000-000000000001', generation: 1 };
  const watchdog = new StartupWatchdog(); watchdog.navigate(session);
  expect(watchdog.accept({ ...session, ...observation }, 0, { visible: true, closing: false })?.observation.chatListReady).toBe(chatListReady);
});
