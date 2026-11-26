import { beforeEach, expect, test, vi } from 'vitest';

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
