import { Menu, Tray, nativeImage } from 'electron';
import { join } from 'node:path';
import { drawTrayBadge, trayBadgeValue, type TrayBadgeValue } from './tray-badge';

export function createTrayImage(root: string, badge: TrayBadgeValue = '') {
  const image = nativeImage.createEmpty();
  for (const [size, scaleFactor] of [[22, 1], [44, 2]] as const) {
    const representation = nativeImage.createFromPath(join(root, `tray-${size}.png`));
    if (representation.isEmpty()) throw new Error('Tray icon is missing.');
    const rendered = badge ? nativeImage.createFromBitmap(drawTrayBadge(representation.toBitmap(), size, badge), { width: size, height: size }) : representation;
    image.addRepresentation({ scaleFactor, buffer: rendered.toPNG() });
  }
  return image;
}

export function createCompanionTray(root: string, actions: { open: () => void; activate: () => void; notifications: () => boolean; startAtLogin: () => boolean;
  toggleNotifications: () => void; toggleStartAtLogin: () => void; quit: () => void }) {
  const image = createTrayImage(root);
  const tray = new Tray(image);
  let displayed: TrayBadgeValue = '';
  const setUnreadCount = (count: number) => {
    const next = trayBadgeValue(count);
    if (next === displayed || tray.isDestroyed()) return;
    tray.setImage(next ? createTrayImage(root, next) : image);
    displayed = next;
  };
  try {
    tray.setToolTip('WhatsApp Companion'); tray.on('click', actions.activate);
    const refresh = () => tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open WhatsApp Companion', click: actions.open }, { type: 'separator' },
      { label: 'Notifications', type: 'checkbox', checked: actions.notifications(), click: actions.toggleNotifications },
      { label: 'Start at login', type: 'checkbox', checked: actions.startAtLogin(), click: actions.toggleStartAtLogin },
      { type: 'separator' }, { label: 'Quit', click: actions.quit }
    ]));
    refresh(); return { tray, refresh, setUnreadCount };
  } catch (error) { tray.destroy(); throw error; }
}
