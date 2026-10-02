// @vitest-environment jsdom
import { test, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { captureStickerPicker, redactPickerText } from '../src/connector/sticker-picker-capture';
import { DomConnector } from '../src/connector/dom';
import { PickerDiagnostics } from '../src/main/picker-diagnostics';
import { PICKER_MAX_DEPTH, PICKER_MAX_NODES, PICKER_UI_WORDS, pickerLayoutCaptureSchema, pickerLayoutDiagnosticSchema, pickerLayoutEventSchema, pickerLayoutResultSchema, type PickerLayoutCapture, type PickerCaptureNode } from '../src/shared/sticker-picker-capture';
import type { RemoteCommand, RemoteEvent } from '../src/shared/connector';

const directories: string[] = [];
afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  document.body.innerHTML = '<div id="main"><span>Private conversation and account</span></div><div id="expressions-panel-container" aria-label="Private ancestor"><section role="dialog" data-testid="picker-wrapper"><ul data-testid="expressions-panel" class="opaque-one opaque-two" style="direction:rtl;overflow-y:auto"><button data-testid="panel-starred" role="tab" aria-label="Favorites SECRET-PACK" title="Buscar PRIVATE-TITLE" aria-selected="true" data-private="PRIVATE-ATTRIBUTE">Recent PRIVATE-TEXT<img src="https://private.example/secret-image?token=secret" alt="Sticker PRIVATE-ALT"></button><span style="display:none">search hidden text</span><script>search secret script</script></ul></section></div>';
  const panel = document.querySelector<HTMLElement>('[data-testid="expressions-panel"]')!;
  panel.checkVisibility = () => true;
  panel.getBoundingClientRect = () => ({ x: 1.4, y: 2.6, top: 2.6, left: 1.4, right: 301.4, bottom: 202.6, width: 300, height: 200, toJSON() {} });
  Object.defineProperties(panel, { scrollHeight: { value: 800 }, clientHeight: { value: 200 } });
  panel.scrollTop = 123; panel.scrollLeft = -7;
  const image = panel.querySelector('img')!;
  Object.defineProperties(image, { naturalWidth: { value: 160 }, naturalHeight: { value: 120 } });
  image.getBoundingClientRect = () => ({ x: 10, y: 20, top: 20, left: 10, right: 90.4, bottom: 80.6, width: 80.4, height: 60.6, toJSON() {} });
  return panel;
}
function captured(): PickerLayoutCapture {
  const result = captureStickerPicker(document);
  if (result.status !== 'captured') throw new Error('Expected open picker');
  return result;
}
function nodes(tree: PickerCaptureNode): PickerCaptureNode[] { return [tree, ...tree.children.flatMap(nodes)]; }

test('captures only the native picker, redacts text/labels/URLs/classes and retains UI tokens and layout', () => {
  fixture(); const result = captured(), text = JSON.stringify(result), button = result.tree.children[0], image = button.children[0];
  expect(pickerLayoutCaptureSchema.safeParse(result).success).toBe(true);
  for (const secret of ['SECRET-PACK', 'PRIVATE-TITLE', 'PRIVATE-TEXT', 'PRIVATE-ALT', 'PRIVATE-ATTRIBUTE', 'private.example', 'secret-image', 'opaque-one', 'Private ancestor', 'Private conversation']) expect(text).not.toContain(secret);
  expect(result.ancestors).toEqual([{ tagName: 'section', role: 'dialog', testid: 'picker-wrapper' }, { tagName: 'div' }, { tagName: 'body' }]);
  expect(button.labels).toEqual({ 'aria-label': { length: 21, words: ['favorites', 'pack'] }, title: { length: 20, words: ['buscar'] } });
  expect(button.text).toEqual({ length: 19, words: ['recent'] });
  expect(button.attributes).toEqual({ 'data-testid': 'panel-starred', 'aria-selected': 'true' });
  expect(result.tree.classCount).toBe(2); expect(result.tree.direction).toBe('rtl');
  expect(result.tree.rect).toMatchObject({ x: 1, y: 3, width: 300, height: 200 });
  expect(result.tree.scroll).toMatchObject({ scrollTop: 123, scrollLeft: -7, scrollHeight: 800, clientHeight: 200 });
  expect(image.image).toEqual({ scheme: 'https', naturalWidth: 160, naturalHeight: 120, renderedWidth: 80, renderedHeight: 61 });
  expect(image.labels.alt).toEqual({ length: 19, words: ['sticker'] });
  expect(result.tree.children[1].text).toBeUndefined(); expect(result.tree.children[2].text).toBeUndefined();
});

test('redaction uses exact lowercase allowlist tokens, including Spanish and Portuguese', () => {
  expect(redactPickerText('FAVOURITES favoritos recientes recentes CREAR criar tienda loja descargar baixar nuevo novo buscar pesquisar SECRET Alice packs settings')).toEqual({ length: 136, words: ['favourites', 'favoritos', 'recientes', 'recentes', 'crear', 'criar', 'tienda', 'loja', 'descargar', 'baixar', 'nuevo', 'novo', 'buscar', 'pesquisar', 'packs', 'settings'] });
  expect(redactPickerText('research stickerlover gif123 GIF').words).toEqual(['gif']);
  expect(redactPickerText(PICKER_UI_WORDS.join(' ')).words).toEqual(PICKER_UI_WORDS);
});

test.each(['blob:private-origin/id', 'data:image/png;base64,SECRET', 'https://example.test/SECRET', 'file:///SECRET'])('only keeps supported scheme from %s', source => {
  fixture(); document.querySelector('img')!.setAttribute('src', source);
  const result = captured(); expect(result.tree.children[0].children[0].image?.scheme).toBe(source.startsWith('file:') ? null : source.split(':')[0]);
  expect(JSON.stringify(result)).not.toContain('SECRET');
});

test('capture is read-only: no events, mutations, focus or scroll changes', () => {
  const panel = fixture(), events = vi.fn();
  for (const type of ['click', 'focus', 'focusin', 'scroll', 'input', 'change']) document.addEventListener(type, events);
  const observer = new MutationObserver(vi.fn()); observer.observe(document.body, { subtree: true, attributes: true, childList: true, characterData: true });
  const before = document.body.innerHTML, focus = document.activeElement, scroll = [panel.scrollLeft, panel.scrollTop];
  captured();
  expect(document.body.innerHTML).toBe(before); expect(document.activeElement).toBe(focus); expect([panel.scrollLeft, panel.scrollTop]).toEqual(scroll);
  expect(observer.takeRecords()).toEqual([]); expect(events).not.toHaveBeenCalled();
  observer.disconnect(); for (const type of ['click', 'focus', 'focusin', 'scroll', 'input', 'change']) document.removeEventListener(type, events);
});

test('no picker and hidden picker return a no-picker result without opening one', () => {
  expect(captureStickerPicker(document)).toEqual({ status: 'no-picker-open' });
  const panel = fixture(); panel.checkVisibility = () => false;
  expect(captureStickerPicker(document)).toEqual({ status: 'no-picker-open' });
  expect(pickerLayoutResultSchema.safeParse({ status: 'no-picker-open' }).success).toBe(true);
});

test('typed connector command emits the read-only capture result', () => {
  fixture(); const events: RemoteEvent[] = [], connector = new DomConnector(document, event => events.push(event));
  const nonce = randomUUID(); connector.command({ type: 'captureStickerPickerLayout', nonce });
  expect(events).toHaveLength(1); expect(pickerLayoutEventSchema.safeParse(events[0]).success).toBe(true);
  expect(events[0]).toMatchObject({ type: 'stickerPickerLayout', nonce, result: { status: 'captured' } });
});

test('caps depth at 40, marks cut branches, and rejects an overdeep reply before recursive parsing', () => {
  const panel = fixture(); panel.replaceChildren(); let parent: Element = panel;
  for (let i = 0; i < 80; i++) { const child = document.createElement('div'); parent.append(child); parent = child; }
  const result = captured(); expect(result.nodeCount).toBe(PICKER_MAX_DEPTH + 1); expect(result.truncated).toBe(true);
  expect(nodes(result.tree).at(-1)?.truncated).toBe(true); expect(pickerLayoutCaptureSchema.safeParse(result).success).toBe(true);
  const invalid = structuredClone(result); let tail = invalid.tree;
  for (let i = 0; i < 1000; i++) { const child = structuredClone(result.tree.children[0]); child.children = []; tail.children = [child]; tail = child; }
  expect(pickerLayoutCaptureSchema.safeParse(invalid).success).toBe(false);
});

test('caps the total tree at 6000 nodes, marks truncation and rejects larger replies', () => {
  const panel = fixture(); panel.replaceChildren();
  const fragment = document.createDocumentFragment(); for (let i = 0; i < PICKER_MAX_NODES + 2; i++) fragment.append(document.createElement('i')); panel.append(fragment);
  const result = captured(); expect(result.nodeCount).toBe(PICKER_MAX_NODES); expect(result.truncated).toBe(true); expect(result.tree.truncated).toBe(true);
  expect(pickerLayoutCaptureSchema.safeParse(result).success).toBe(true);
  result.tree.children.push(result.tree.children[0]); expect(pickerLayoutCaptureSchema.safeParse(result).success).toBe(false);
});

test('bounds attributes, text summaries and ancestor chain, and marks clipping', () => {
  const panel = fixture(); panel.setAttribute('id', 'a'.repeat(1000)); panel.textContent = 'Search ' + 'x'.repeat(150_000);
  for (let i = 0; i < 50; i++) { const wrapper = document.createElement('section'); panel.parentElement!.insertBefore(wrapper, panel); wrapper.append(panel); }
  const result = captured(); expect(result.truncated).toBe(true); expect(result.ancestors).toHaveLength(40);
  expect(result.tree.attributes.id).toHaveLength(256); expect(result.tree.text).toEqual({ length: 150_007, words: ['search'] });
  expect(pickerLayoutCaptureSchema.safeParse(result).success).toBe(true);
});

test('strict schema rejects unredacted or unbounded fields, invalid tokens, metadata, and node counts', () => {
  fixture(); const valid = captured();
  for (const mutate of [
    (v: any) => { v.account = 'secret'; }, (v: any) => { v.tree.attributes.src = 'https://secret'; },
    (v: any) => { v.tree.labels.title = 'raw'; }, (v: any) => { v.tree.text = { length: 10, words: ['secret'] }; },
    (v: any) => { v.tree.image = { scheme: 'file', naturalWidth: 0, naturalHeight: 0, renderedWidth: 0, renderedHeight: 0 }; },
    (v: any) => { v.tree.rect.width = Infinity; }, (v: any) => { v.tree.role = 'a'.repeat(257); },
    (v: any) => { v.nodeCount++; }, (v: any) => { v.ancestors[0].id = 'private'; }, (v: any) => { v.connectorVersion = 2; }
  ]) { const invalid = structuredClone(valid); mutate(invalid); expect(pickerLayoutCaptureSchema.safeParse(invalid).success).toBe(false); }
  expect(pickerLayoutDiagnosticSchema.safeParse({ ...valid, appVersion: '0.1.0' }).success).toBe(true);
  expect(pickerLayoutDiagnosticSchema.safeParse({ ...valid, appVersion: 'v'.repeat(81) }).success).toBe(false);
  expect(pickerLayoutEventSchema.safeParse({ type: 'stickerPickerLayout', nonce: 'bad', result: valid }).success).toBe(false);
});

function mainFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'picker-capture-test-')); directories.push(directory);
  const commands: RemoteCommand[] = [], reveal = vi.fn(), notify = vi.fn();
  const diagnostics = new PickerDiagnostics({ directory, appVersion: '0.1.0', send: c => commands.push(c), reveal, notify });
  const reply = (result: unknown, nonce = (commands.at(-1) as { nonce: string }).nonce) => ({ type: 'stickerPickerLayout', nonce, result });
  return { directory, commands, diagnostics, reveal, notify, reply };
}

test('only a pending menu request can save; successful replies are one-use, atomic and owner-only', () => {
  fixture(); const result = captured(), f = mainFixture();
  f.diagnostics.receive({ type: 'stickerPickerLayout', nonce: randomUUID(), result });
  expect(existsSync(join(f.directory, 'diagnostics'))).toBe(false);
  f.diagnostics.capture(); f.diagnostics.capture(); expect(f.commands).toHaveLength(1);
  f.diagnostics.receive(f.reply(result, randomUUID())); expect(f.reveal).not.toHaveBeenCalled();
  const reply = f.reply(result); f.diagnostics.receive(reply); f.diagnostics.receive(reply);
  const directory = join(f.directory, 'diagnostics'), files = readdirSync(directory);
  expect(files).toHaveLength(1); expect(files[0]).toMatch(/^sticker-picker-.*\.json$/);
  const path = join(directory, files[0]), saved = JSON.parse(readFileSync(path, 'utf8'));
  expect(pickerLayoutDiagnosticSchema.safeParse(saved).success).toBe(true); expect(saved.appVersion).toBe('0.1.0');
  expect(readFileSync(path, 'utf8')).toContain('\n  "'); expect(statSync(path).mode & 0o777).toBe(0o600); expect(statSync(directory).mode & 0o777).toBe(0o700);
  expect(f.reveal).toHaveBeenCalledExactlyOnceWith(path); expect(f.notify).toHaveBeenCalledExactlyOnceWith(`Sticker picker layout saved to:\n${path}`);
});

test('no-picker result only shows the requested instruction and creates no file', () => {
  const f = mainFixture(); f.diagnostics.capture(); f.diagnostics.receive(f.reply({ status: 'no-picker-open' }));
  expect(f.notify).toHaveBeenCalledExactlyOnceWith("Open WhatsApp's sticker picker first, then try again."); expect(f.reveal).not.toHaveBeenCalled();
  expect(existsSync(join(f.directory, 'diagnostics'))).toBe(false);
});

test('invalid replies consume authorization without saving; cancelled and timed-out requests cannot save', () => {
  vi.useFakeTimers(); fixture(); const f = mainFixture(), result = captured();
  f.diagnostics.capture(); const valid = f.reply(result); f.diagnostics.receive(f.reply({ ...result, rawText: 'secret' })); f.diagnostics.receive(valid);
  expect(f.notify).toHaveBeenCalledExactlyOnceWith('Sticker picker capture was invalid. No diagnostic was saved.'); expect(f.reveal).not.toHaveBeenCalled();
  f.diagnostics.capture(); const cancelled = f.reply(result); f.diagnostics.cancel(); f.diagnostics.receive(cancelled);
  f.diagnostics.capture(); const expired = f.reply(result); vi.advanceTimersByTime(10_000); f.diagnostics.receive(expired);
  expect(f.notify).toHaveBeenLastCalledWith('Sticker picker capture timed out. Reload WhatsApp and try again.'); expect(f.reveal).not.toHaveBeenCalled();
  expect(existsSync(join(f.directory, 'diagnostics'))).toBe(false);
});
