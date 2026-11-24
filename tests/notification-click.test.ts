// @vitest-environment jsdom
import { afterEach, expect, test, vi } from 'vitest';
import { installNotificationClicks } from '../src/preload/notification-click';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function setup(captureListener = true) {
  class NativeNotification extends EventTarget {
    static permission = 'granted';
    static requestPermission = vi.fn(async () => 'granted');
    constructor(public title: string, public options?: NotificationOptions) { super(); }
    close = vi.fn();
  }
  vi.stubGlobal('Notification', NativeNotification);
  const listener = captureListener ? vi.spyOn(EventTarget.prototype, 'addEventListener') : undefined;
  const clicked = vi.fn();
  // Execute serialized code just as contextBridge does: no module-scope closure.
  const install = window.eval(`(${installNotificationClicks.toString()})`) as typeof installNotificationClicks;
  install(clicked);
  const notification = new Notification('Private title', { body: 'Private body', tag: 'chat-id' });
  const click = listener?.mock.calls.find(([type]) => type === 'click')?.[1] as (event: Event) => void;
  return { NativeNotification, notification, click, clicked };
}

test('keeps the native constructor, options, statics, prototype and lifecycle', async () => {
  const { NativeNotification, notification } = setup();
  expect(notification).toBeInstanceOf(Notification);
  expect(notification).toBeInstanceOf(NativeNotification);
  expect(notification).toMatchObject({ title: 'Private title', options: { body: 'Private body', tag: 'chat-id' } });
  expect(Notification.prototype).toBe(NativeNotification.prototype);
  expect(Notification.permission).toBe('granted');
  expect(await Notification.requestPermission()).toBe('granted');
  notification.close(); expect(notification.close).toHaveBeenCalledOnce();
  class DerivedNotification extends Notification {}
  expect(new DerivedNotification('Other')).toBeInstanceOf(DerivedNotification);
});

test('synthetic clicks cannot signal main; genuine clicks send no page data', () => {
  const { notification, click, clicked } = setup();
  notification.dispatchEvent(new Event('click'));
  expect(clicked).not.toHaveBeenCalled();
  // Only the browser can produce isTrusted=true; use the captured listener to
  // exercise that branch here, and a real KDE notification in desktop checks.
  click({ isTrusted: true } as Event);
  expect(clicked).toHaveBeenCalledExactlyOnceWith();
});

test('page changes to reflection or event methods cannot intercept the private listener', () => {
  setup(false);
  const construct = vi.spyOn(Reflect, 'construct').mockImplementation(() => { throw new Error('page construct'); });
  const apply = vi.spyOn(Reflect, 'apply').mockImplementation(() => { throw new Error('page apply'); });
  const add = vi.spyOn(EventTarget.prototype, 'addEventListener').mockImplementation(() => { throw new Error('page listener'); });
  expect(new Notification('Later')).toBeInstanceOf(Notification);
  expect(construct).not.toHaveBeenCalled(); expect(apply).not.toHaveBeenCalled(); expect(add).not.toHaveBeenCalled();
});

test('does not consume or replace the page click handler or its event', () => {
  const { notification, clicked } = setup();
  const openChat = vi.fn();
  notification.addEventListener('click', openChat);
  const event = new Event('click', { cancelable: true });
  expect(notification.dispatchEvent(event)).toBe(true);
  expect(openChat).toHaveBeenCalledExactlyOnceWith(event);
  expect(event.defaultPrevented).toBe(false);
  expect(clicked).not.toHaveBeenCalled();
});
