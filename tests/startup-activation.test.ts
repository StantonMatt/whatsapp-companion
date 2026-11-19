// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Assistant } from '../src/main/assistant';
import { initialState, type State } from '../src/shared/model';
import type { RemoteCommand, RemoteEvent } from '../src/shared/connector';
import type { Store } from '../src/main/store';
import type { Vault } from '../src/main/vault';

const ipc = vi.hoisted(() => ({ send: vi.fn(), invoke: vi.fn(), on: vi.fn() }));
vi.mock('electron', () => ({ ipcRenderer: ipc }));
const session = { nonce: '00000000-0000-4000-8000-000000000001', generation: 1 };
beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); vi.useFakeTimers();
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({ width: 100, height: 100 } as DOMRect); });
afterEach(() => {
  window.dispatchEvent(new Event('beforeunload'));
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers(); vi.restoreAllMocks(); document.body.replaceChildren();
});

test('splash-delayed real preload and connector recover the suspended assistant after load-time snapshot retries are missed', async () => {
  document.body.innerHTML = '<div id="initial_startup"></div>';
  let deliver: (_event: unknown, command: RemoteCommand) => void = () => {};
  const state = initialState(); state.global.aiFeatures = true;
  const commands: RemoteCommand[] = [];
  const store = { state, update: (change: (state: State) => void) => change(state) } as Store;
  const assistant = new Assistant(store, {} as Vault, { send: command => { commands.push(command); deliver({}, command); }, focus() {} }, () => {}, true);
  ipc.on.mockImplementation((channel, handler) => { if (channel === 'companion:command') deliver = handler; });
  ipc.invoke.mockResolvedValue(session);
  ipc.send.mockImplementation((channel: string, payload: RemoteEvent | typeof session) => {
    if (channel === 'companion:connector-ready') {
      expect(payload).toEqual(session);
      assistant.refresh(true);
    } else if (channel === 'companion:event') {
      const event = payload as RemoteEvent;
      if (event.type === 'snapshot') assistant.receive(event.snapshot, false, event.nonce);
    }
  });
  assistant.suspend();
  await import('../src/preload/remote'); await Promise.resolve();
  // did-finish-load happens long before the fixture splash disappears. Main's
  // old implementation sent all three nonce-tagged requests while deferred.
  assistant.refresh(true);
  vi.advanceTimersByTime(5000);
  expect(commands.filter(command => command.type === 'snapshot')).toHaveLength(3);
  expect(document.querySelector('#companion-overlay')).toBeNull();
  document.body.innerHTML = '<div id="pane-side"></div><div id="main"><header><span title="Alex">Alex</span></header><div data-id="false_123@c.us_a"><span class="selectable-text copyable-text">Hello</span></div><footer><div contenteditable="true" role="textbox"></div></footer></div>';
  document.querySelector('#main')!.getBoundingClientRect = () => ({ width: 800, height: 600 } as DOMRect);
  const editor = document.querySelector<HTMLElement>('[role=textbox]')!;
  editor.getBoundingClientRect = () => ({ width: 500, height: 44, left: 0, top: 500, right: 500, bottom: 544 } as DOMRect);
  try {
    vi.advanceTimersByTime(2000);
    expect(document.querySelector('#companion-overlay')).not.toBeNull();
    expect(assistant.snapshot.ready).toBe(true);
    await assistant.request();
    expect(commands.at(-1)).toMatchObject({ type: 'notice', text: expect.stringContaining('Enable conversation context in Settings') });
  } finally { assistant.cancel(true); }
});
