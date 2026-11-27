import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ created: [] as any[], images: [] as any[], failMenu: false }));
vi.mock('electron', () => ({
  nativeImage: {
    createEmpty: () => {
      const image = { addRepresentation: vi.fn() }; mocks.images.push(image); return image;
    },
    createFromPath: (path: string) => ({
      isEmpty: () => false, toPNG: () => Buffer.from(path),
      toBitmap: () => Buffer.alloc((path.endsWith('44.png') ? 44 : 22) ** 2 * 4)
    }),
    createFromBitmap: (bitmap: Buffer) => ({ toPNG: () => bitmap })
  },
  Menu: { buildFromTemplate: (template: unknown) => { if (mocks.failMenu) throw new Error('menu failed'); return template; } },
  Tray: class {
    setImage = vi.fn(); setToolTip = vi.fn(); on = vi.fn(); setContextMenu = vi.fn();
    destroyed = false; isDestroyed = () => this.destroyed;
    destroy = vi.fn(() => { this.destroyed = true; });
    constructor(public image: unknown) { mocks.created.push(this); }
  }
}));

import { createCompanionTray } from '../src/main/tray';

beforeEach(() => { mocks.created.length = mocks.images.length = 0; mocks.failMenu = false; });
afterEach(() => { vi.restoreAllMocks(); });
const setup = () => createCompanionTray('/assets', {
  open: vi.fn(), activate: vi.fn(), notifications: () => false, startAtLogin: () => false,
  toggleNotifications: vi.fn(), toggleStartAtLogin: vi.fn(), quit: vi.fn()
});

test('starts with the unchanged 1x/2x icons and only updates when the displayed value changes', () => {
  const companion = setup(), tray = mocks.created[0];
  expect(mocks.images[0].addRepresentation.mock.calls).toEqual([
    [{ scaleFactor: 1, buffer: Buffer.from('/assets/tray-22.png') }],
    [{ scaleFactor: 2, buffer: Buffer.from('/assets/tray-44.png') }]
  ]);
  companion.setUnreadCount(0); expect(tray.setImage).not.toHaveBeenCalled();
  companion.setUnreadCount(1); expect(tray.setImage).toHaveBeenCalledOnce();
  companion.setUnreadCount(1); expect(tray.setImage).toHaveBeenCalledOnce();
  companion.setUnreadCount(3); expect(tray.setImage).toHaveBeenCalledTimes(2);
  companion.setUnreadCount(10); expect(tray.setImage).toHaveBeenCalledTimes(3);
  companion.setUnreadCount(12); companion.setUnreadCount(999);
  expect(tray.setImage).toHaveBeenCalledTimes(3);
  expect(mocks.images).toHaveLength(4);
  for (const image of mocks.images) expect(image.addRepresentation.mock.calls.map(([options]: any[]) => options.scaleFactor)).toEqual([1, 2]);
});

test('restores the exact original image at zero and can add the badge again', () => {
  const companion = setup(), tray = mocks.created[0];
  companion.setUnreadCount(9); companion.setUnreadCount(0);
  expect(tray.setImage).toHaveBeenLastCalledWith(tray.image);
  companion.setUnreadCount(0); expect(tray.setImage).toHaveBeenCalledTimes(2);
  companion.setUnreadCount(9); expect(tray.setImage).toHaveBeenCalledTimes(3);
  companion.setUnreadCount(NaN); expect(tray.setImage).toHaveBeenLastCalledWith(tray.image);
});

test('ignores updates after tray destruction', () => {
  const companion = setup(), tray = mocks.created[0];
  tray.destroy(); companion.setUnreadCount(1);
  expect(tray.setImage).not.toHaveBeenCalled();
});

test('destroys the tray if menu setup fails', () => {
  mocks.failMenu = true;
  expect(setup).toThrow('menu failed');
  expect(mocks.created[0].destroy).toHaveBeenCalledOnce();
});

test('the Plasma hover menu action only shows, while a normal tray click still activates', () => {
  const open = vi.fn(), activate = vi.fn();
  const companion = createCompanionTray('/assets', {
    open, activate, notifications: () => true, startAtLogin: () => false,
    toggleNotifications: vi.fn(), toggleStartAtLogin: vi.fn(), quit: vi.fn()
  });
  const tray = mocks.created[0];
  const menu = tray.setContextMenu.mock.lastCall[0];
  const show = menu.find((item: any) => item.label === 'Open WhatsApp Companion');
  show.click(); show.click();
  expect(open).toHaveBeenCalledTimes(2);
  expect(activate).not.toHaveBeenCalled();
  tray.on.mock.calls.find(([event]: any[]) => event === 'click')[1]();
  expect(activate).toHaveBeenCalledOnce();
  companion.refresh();
  tray.setContextMenu.mock.lastCall[0][0].click();
  expect(open).toHaveBeenCalledTimes(3);
});

test('a hidden drag reveal arm makes exactly one activation show, including after menu refresh', () => {
  vi.spyOn(performance, 'now').mockReturnValue(100);
  const open = vi.fn(), activate = vi.fn();
  const companion = createCompanionTray('/assets', {
    open, activate, notifications: () => false, startAtLogin: () => false,
    toggleNotifications: vi.fn(), toggleStartAtLogin: vi.fn(), quit: vi.fn()
  });
  const tray = mocks.created[0];
  const arm = tray.setContextMenu.mock.lastCall[0].find((item: any) => item.id === 'companion-prepare-drag-reveal');
  expect(arm.visible).toBe(false);
  const click = tray.on.mock.calls.find(([event]: any[]) => event === 'click')[1];
  arm.click(); companion.refresh(); click();
  expect(open).toHaveBeenCalledOnce(); expect(activate).not.toHaveBeenCalled();
  click(); expect(activate).toHaveBeenCalledOnce();
  arm.click(); click(); expect(open).toHaveBeenCalledTimes(2);
});

test('an unconsumed arm expires after three seconds and Open remains show-only', () => {
  const clock = vi.spyOn(performance, 'now').mockReturnValue(100);
  const open = vi.fn(), activate = vi.fn();
  createCompanionTray('/assets', {
    open, activate, notifications: () => false, startAtLogin: () => false,
    toggleNotifications: vi.fn(), toggleStartAtLogin: vi.fn(), quit: vi.fn()
  });
  const tray = mocks.created[0], menu = tray.setContextMenu.mock.lastCall[0];
  const click = tray.on.mock.calls.find(([event]: any[]) => event === 'click')[1];
  menu.find((item: any) => item.id === 'companion-prepare-drag-reveal').click();
  clock.mockReturnValue(3100); click();
  expect(open).not.toHaveBeenCalled(); expect(activate).toHaveBeenCalledOnce();
  menu[0].click(); menu[0].click();
  expect(open).toHaveBeenCalledTimes(2); expect(activate).toHaveBeenCalledOnce();
});
