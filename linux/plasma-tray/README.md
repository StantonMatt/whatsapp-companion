# Plasma 6 file hover

Optional app-owned system-tray widget for Plasma 6.6. While dragging a file or
URI, hover over its icon for 400 ms to reveal WhatsApp Companion, then keep
dragging into a chat. Dropping on the icon itself is rejected; the widget does
not read or send the file. Leaving before 400 ms cancels the request. Each
entry sends at most one show request. Normal clicks keep the existing toggle.

## Mechanism

`org.kde.plasma.workspace.dbus` discovers the app's SNI through
`org.kde.StatusNotifierWatcher`. Electron 44.4.5 identifies this app as
`WhatsApp Companion_status_icon_1`; its SNI Title can be empty. The widget
matches the app-specific Id, reads its tooltip, and imports its DBusMenu.
Hover first sends `com.canonical.dbusmenu.Event` for the hidden **Prepare drag
reveal** item. Its callback arms the next tray activation for show-only behavior
for three seconds. On acknowledgement, the widget calls its containing
system tray's `activate` method, which acquires and forwards the same Wayland
activation token as an ordinary SNI click. The app consumes the arm exactly
once and calls its existing `showWindow` callback instead of toggling.
Ordinary unarmed clicks and the notification path keep their behavior.

If the arm is absent, fails, or is not acknowledged within 120 ms, the widget
instead sends the existing **Open WhatsApp Companion** menu event, which is
always show-only. A late arm acknowledgement is ignored; fallback never
issues Activate. Menu IDs are discovered, not hard-coded. No second Electron
process or shell command is launched. The hidden item is exported with
`visible=false`, so it does not appear in Plasma or other DE menus. A genuine
click during an unconsumed arm shows instead of toggling; it expires after
three seconds. Plasma obtains tokens asynchronously: an exceptional token
delay beyond that expiry could arrive as an unarmed activation. Normal token
delivery is expected to be milliseconds; this residual needs live validation.

The optional `SniIcon.qml` uses Plasma's exported private `StatusNotifierModel`
to receive the original QIcon, including the app's unread badge and image
updates. It is loaded separately: if a Plasma update removes that API, the
widget keeps its actions and displays the bundled plain icon. Plasma's old
`statusnotifieritem` Plasma5Support data engine is absent in 6.6, so this widget
does not depend on it. It never replaces or patches KDE's tray package.

Plasma intercepts a tray plasmoid's right-click itself. The widget therefore
supplies the app's four DBusMenu actions, checkbox state and separators as
`Plasmoid.contextualActions`; Plasma may add its normal widget-management
actions. Notifications, login and Quit still invoke the app's menu callbacks.
The fixed action labels mirror `src/main/tray.ts`; update both if that menu
changes. Normal left-click uses the containing tray's `activate` method when
available, preserving its Wayland token path, with direct SNI Activate as a
fallback outside the tray.

## Install and enable (manual, live desktop)

Do not run these steps from a headless verification task. With the user ready
to test on their desktop:

```sh
bash linux/plasma-tray/install.sh
```

The script uses `kpackagetool6 --type Plasma/Applet --install` for first install
and `--upgrade` thereafter. Plasma watches package-install/update notifications;
no plasmashell, KWin or session restart is needed. Installation adds only
`$XDG_DATA_HOME/plasma/plasmoids/io.whatsappcompanion.tray` (normally under
`~/.local/share`). It does not edit tray settings automatically.
Linux application packages also include the widget, installer and this document
under `resources/plasma-tray`. For an AppImage, extract it with
`./WhatsApp-Companion.AppImage --appimage-extract` and run
`bash squashfs-root/resources/plasma-tray/install.sh` from the extracted copy.

In **System Tray Settings → Entries**:

1. Enable **WhatsApp Companion (drag to open)** and choose **Always shown**.
2. Set the original **WhatsApp Companion** SNI entry to **Never show (disabled)**, not
   **Always hidden**. Always hidden leaves a second icon in the popup.
3. Apply. If **Always show all entries** is enabled, turn it off; Plasma gives
   that option priority over disabled SNI entries.

Exact configuration effect in the target system tray's
`[Containments][<panel>][Applets][<tray>][General]` group in
`plasma-org.kde.plasma.desktop-appletsrc` on Plasma 6.6 (older layouts can use
`[Containments][<tray>][General]`):

- Add `io.whatsappcompanion.tray` to `extraItems` (enabled plasmoids) and
  `shownItems`.
- Add `WhatsApp Companion_status_icon_1` to `disabledStatusNotifiers` and
  remove that original SNI Id from `shownItems` and `hiddenItems`. Do not use `hiddenItems`
  as a substitute for disabling it.
- Set `showAllItems=false` if previously true. Preserve all other list entries.

These are user settings managed by Plasma's UI, not changes the installer
makes. The original SNI remains registered so its badge, actions and icon can
be mirrored. Its Id is specific to this app in Electron 44.4.5. If a future
Electron version changes the Id, confirm the new app-specific value before
changing settings; never disable a generic `chrome_status_icon_1` Id, which
could affect other Electron apps. After an upgrade, disable/re-enable this
widget in Entries if Plasma retains its prior QML component in memory.

Rollback: restore the original SNI entry to **Automatic**, disable/remove the
widget, and run `bash linux/plasma-tray/install.sh remove`. Restore **Always
show all entries** if desired. No app setting, notification permission or
KWin window rule changes are required.

## Verification

```sh
# QML syntax/type checks (Qt's qmllint may be outside PATH)
/usr/lib/qt6/bin/qmllint linux/plasma-tray/package/contents/ui/*.qml

# Real Qt drag events plus QML/D-Bus integration on a disposable session bus.
# Needs system Python dbus, gi and PyQt6; creates an offscreen window only.
env QT_QPA_PLATFORM=offscreen QT_QUICK_BACKEND=software \
  dbus-run-session -- /usr/bin/python3 linux/plasma-tray/tests/service.py

# Real Electron / QML / DBusMenu handshake, using disposable app data on Xvfb.
# Build first; requires the repo's Node runtime, Playwright and xvfb-run.
env -u ELECTRON_RUN_AS_NODE QT_QPA_PLATFORM=offscreen QT_QUICK_BACKEND=software \
  xvfb-run -a dbus-run-session -- /usr/bin/python3 \
  linux/plasma-tray/tests/service.py --electron
```

The test covers discovery with an empty Title, tooltip and DBusMenu decoding,
show-only invocation twice, normal Activate, the armed handshake, arm failure,
missing arm and timeout fallback, ignoring a late acknowledgement, real QIcon
pixmap updates, hover timing, cancel on leave, one show per entry, text
exclusion and rejection of the drop. The app's `tests/tray.test.ts` checks the
Open action, hidden arm, one-shot consumption and three-second expiry.
`qmllint` has a local suppression for the runtime Applet's contextual-action
list, matching the syntax used by KDE's shipped applets.

Live validation still required on Plasma Wayland: hide/minimize the app, drag
a file from Dolphin onto the widget, confirm reveal/raise after 400 ms, move
into an open chat and cancel the drag without sending. Repeat while the app
is focused: it must stay visible. Check the unread badge, context-menu
checkboxes, ordinary click toggle and app-restart reconnection. Confirm the
containing tray's native activation/token path is available to this plasmoid.
The direct-show fallback cannot acquire its own fresh token, so its foreground
activation depends on KWin policy. Do not claim the live Wayland flow verified
until these checks have been performed.
