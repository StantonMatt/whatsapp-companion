import { Menu, Tray, nativeImage } from 'electron';
import { join } from 'node:path';

export function createCompanionTray(root: string, actions: { open: () => void; notifications: () => boolean; startAtLogin: () => boolean;
  toggleNotifications: () => void; toggleStartAtLogin: () => void; quit: () => void }) {
  const image = nativeImage.createEmpty();
  for (const [size, scaleFactor] of [[22, 1], [44, 2]]) {
    const representation = nativeImage.createFromPath(join(root, `tray-${size}.png`));
    if (representation.isEmpty()) throw new Error('Tray icon is missing.');
    image.addRepresentation({ scaleFactor, buffer: representation.toPNG() });
  }
  const tray = new Tray(image);
  try {
    tray.setToolTip('WhatsApp Companion'); tray.on('click', actions.open);
    const refresh = () => tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open WhatsApp Companion', click: actions.open }, { type: 'separator' },
      { label: 'Notifications', type: 'checkbox', checked: actions.notifications(), click: actions.toggleNotifications },
      { label: 'Start at login', type: 'checkbox', checked: actions.startAtLogin(), click: actions.toggleStartAtLogin },
      { type: 'separator' }, { label: 'Quit', click: actions.quit }
    ]));
    refresh(); return { tray, refresh };
  } catch (error) { tray.destroy(); throw error; }
}
