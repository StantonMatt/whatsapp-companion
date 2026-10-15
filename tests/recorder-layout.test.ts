// @vitest-environment jsdom
import { test, expect, vi, afterEach } from 'vitest';
import { DomConnector } from '../src/connector/dom';

afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });
function fixture() {
  document.body.innerHTML = '<style>.recorder { display:flex; flex-direction:row; width:100%; max-width:417px }</style><div id="main"><footer><div style="display:flex;max-width:1600px"><div data-testid="compose-box"><span><div style="display:flex"><div style="display:flex;flex-grow:1"><div style="display:flex;flex-grow:1"><div style="display:flex;justify-content:flex-end;width:100%"><div class="recorder"><div><button aria-label="Cancelar"></button></div><div style="display:flex;flex-grow:1;flex-basis:0"><span><div><i></i><div role="timer">0:01</div><div><canvas></canvas></div></div></span></div><div><button aria-label="Pausar grabación"></button></div><div role="button"><button aria-label="Enviar"></button></div></div></div></div></div></div></span></div></div></footer></div>';
  return document.querySelector<HTMLElement>('.recorder')!;
}
function start() { vi.useFakeTimers(); const connector = new DomConnector(document, () => {}); connector.start(); return connector; }

test('stretches the recorder without changing its children or other composer styles, and stays stretched across refreshes', () => {
  const recorder = fixture(), children = recorder.innerHTML, parentStyle = recorder.parentElement!.style.cssText, connector = start();
  try {
    expect(getComputedStyle(recorder).maxWidth).toBe('none'); expect(recorder.style.getPropertyPriority('max-width')).toBe('important');
    expect(recorder.style.width).toBe(''); expect(recorder.innerHTML).toBe(children); expect(recorder.parentElement!.style.cssText).toBe(parentStyle);
    connector['refresh'](); expect(getComputedStyle(recorder).maxWidth).toBe('none');
    expect(document.querySelector<HTMLElement>('footer > div')!.style.maxWidth).toBe('1600px');
  } finally { connector.stop(); }
});

test('DOM changes stretch a newly shown recorder and restore its cap when the timer disappears', async () => {
  const recorder = fixture(), timer = recorder.querySelector('[role="timer"]')!; timer.remove(); const connector = start();
  try {
    expect(recorder.style.maxWidth).toBe(''); recorder.children[1].querySelector('div')!.append(timer);
    await Promise.resolve(); vi.advanceTimersByTime(100); expect(recorder.style.maxWidth).toBe('none');
    timer.remove(); await Promise.resolve(); vi.advanceTimersByTime(100);
    expect(recorder.style.maxWidth).toBe(''); expect(getComputedStyle(recorder).maxWidth).toBe('417px');
  } finally { connector.stop(); }
});

test('restores a replaced recorder and restores the current recorder on stop', () => {
  const recorder = fixture(), connector = start(), replacement = recorder.cloneNode(true) as HTMLElement; replacement.style.removeProperty('max-width');
  try {
    recorder.replaceWith(replacement); connector['refresh']();
    expect(recorder.style.maxWidth).toBe(''); expect(replacement.style.maxWidth).toBe('none');
    connector.stop(); expect(replacement.style.maxWidth).toBe(''); expect(getComputedStyle(replacement).maxWidth).toBe('417px');
  } finally { connector.stop(); }
});

test.each(['missing timer', 'outside footer', 'no cap', 'column', 'no send area', 'inner cap', 'hidden'] as const)('leaves unrelated or unrecognized layout alone: %s', mode => {
  const recorder = fixture(), timer = recorder.querySelector('[role="timer"]')!;
  if (mode === 'missing timer') timer.remove();
  if (mode === 'outside footer') document.body.append(recorder);
  if (mode === 'no cap') { recorder.style.maxWidth = 'none'; document.querySelector<HTMLElement>('footer > div')!.style.maxWidth = 'none'; }
  if (mode === 'column') recorder.style.flexDirection = 'column';
  if (mode === 'no send area') recorder.lastElementChild!.remove();
  if (mode === 'inner cap') timer.parentElement!.style.maxWidth = '100px';
  if (mode === 'hidden') recorder.style.display = 'none';
  const original = recorder.style.cssText, outer = document.querySelector<HTMLElement>('footer > div')!.style.cssText, connector = start();
  try { expect(recorder.style.cssText).toBe(original); expect(document.querySelector<HTMLElement>('footer > div')!.style.cssText).toBe(outer); }
  finally { connector.stop(); }
});

test.each(['', 'max-width:390px', 'max-width:390px !important'])('restores the exact original inline value and priority: %s', cap => {
  const recorder = fixture(); recorder.style.cssText = `color: red; ${cap}; margin-left: 2px`;
  const original = recorder.style.cssText, connector = start();
  try { expect(recorder.style.maxWidth).toBe('none'); connector['refresh'](); connector.stop(); expect(recorder.style.cssText).toBe(original); }
  finally { connector.stop(); }
});

test('preserves a native inline cap update and restores that latest value', () => {
  const recorder = fixture(), connector = start();
  try {
    recorder.style.setProperty('max-width', '380px', 'important'); connector['refresh'](); expect(recorder.style.maxWidth).toBe('none');
    connector.stop(); expect(recorder.style.maxWidth).toBe('380px'); expect(recorder.style.getPropertyPriority('max-width')).toBe('important');
  } finally { connector.stop(); }
});
