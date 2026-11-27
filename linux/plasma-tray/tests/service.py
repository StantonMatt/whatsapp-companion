#!/usr/bin/python3
"""Disposable session-bus fixture; never run on the user's desktop bus."""
import os
import subprocess
import sys
import time
import dbus
import dbus.service
from dbus.mainloop.glib import DBusGMainLoop
from gi.repository import GLib

DBusGMainLoop(set_as_default=True)
bus = dbus.SessionBus()
if bus.name_has_owner('org.kde.StatusNotifierWatcher'):
    raise SystemExit('Refusing an existing tray bus. Run this fixture under dbus-run-session.')
name = dbus.service.BusName('io.whatsappcompanion.Test', bus)
watcher_name = dbus.service.BusName('org.kde.StatusNotifierWatcher', bus, do_not_queue=True)
source = 'io.whatsappcompanion.Test/StatusNotifierItem'
registered = [source]
if '--electron' in sys.argv:
    registered = []
counts = [0, 0, 0]
arm_mode = 'success'
armed_until = 0
icon_version = 0


class Watcher(dbus.service.Object):
    @dbus.service.method('org.freedesktop.DBus.Properties', in_signature='ss', out_signature='v')
    def Get(self, iface, prop):
        if prop == 'RegisteredStatusNotifierItems':
            return dbus.Array(registered, signature='s')
        return True

    @dbus.service.method('org.kde.StatusNotifierWatcher', in_signature='s', sender_keyword='sender')
    def RegisterStatusNotifierItem(self, service, sender=None):
        registered.append(str(sender) + service if service.startswith('/') else service + '/StatusNotifierItem')

    @dbus.service.method('org.kde.StatusNotifierWatcher', in_signature='s')
    def RegisterStatusNotifierHost(self, host):
        pass


class Item(dbus.service.Object):
    @dbus.service.method('org.freedesktop.DBus.Properties', in_signature='s', out_signature='a{sv}')
    def GetAll(self, iface):
        return {'Title': '', 'Id': 'WhatsApp Companion_status_icon_1', 'Status': 'Active',
                'Category': 'Communications', 'IconName': '',
                'IconPixmap': dbus.Array([dbus.Struct((dbus.Int32(2), dbus.Int32(2),
                    dbus.ByteArray(bytes([255, 255 if icon_version else 0, 0, 255] * 4))), signature='iiay')], signature='(iiay)'),
                'Menu': dbus.ObjectPath('/Menu'), 'ItemIsMenu': False,
                'ToolTip': dbus.Struct(('whatsapp', dbus.Array([], signature='(iiay)'),
                                       'WhatsApp Companion', 'Fixture tooltip'), signature='sa(iiay)ss')}

    @dbus.service.method('org.kde.StatusNotifierItem', in_signature='ii')
    def Activate(self, x, y):
        global armed_until
        counts[0 if time.monotonic() < armed_until else 1] += 1
        armed_until = 0

    @dbus.service.signal('org.kde.StatusNotifierItem')
    def NewIcon(self):
        pass


class Menu(dbus.service.Object):
    @dbus.service.method('com.canonical.dbusmenu', in_signature='iias', out_signature='u(ia{sv}av)')
    def GetLayout(self, root, depth, props):
        children = []
        for ident, label in [(7, 'Open WhatsApp Companion'), (8, 'Notifications'), (9, 'Start at login'), (10, 'Quit')]:
            properties = {'label': label, 'enabled': True, 'visible': True}
            if ident in (8, 9):
                properties.update({'toggle-type': 'checkmark', 'toggle-state': dbus.Int32(1 if ident == 8 else 0)})
            children.append(dbus.Struct((dbus.Int32(ident), dbus.Dictionary(properties, signature='sv'),
                                       dbus.Array([], signature='v')), signature='ia{sv}av', variant_level=1))
        if arm_mode != 'missing':
            children.append(dbus.Struct((dbus.Int32(11), dbus.Dictionary({'label': 'Prepare drag reveal', 'visible': False}, signature='sv'),
                                       dbus.Array([], signature='v')), signature='ia{sv}av', variant_level=1))
        return dbus.UInt32(1), dbus.Struct((dbus.Int32(0), dbus.Dictionary({}, signature='sv'),
                                           dbus.Array(children, signature='v')), signature='ia{sv}av')

    @dbus.service.method('com.canonical.dbusmenu', in_signature='isvu', async_callbacks=('reply', 'error'))
    def Event(self, ident, event, data, timestamp, reply, error):
        global armed_until
        if ident == 7 and event == 'clicked':
            counts[0] += 1
        if ident == 11 and event == 'clicked':
            if arm_mode == 'failure':
                error(dbus.DBusException('fixture arm failure'))
                return
            counts[2] += 1
            armed_until = time.monotonic() + 3
            if arm_mode == 'timeout':
                GLib.timeout_add(250, lambda: (reply(), False)[1])
                return
        reply()

    @dbus.service.method('io.whatsappcompanion.Test', out_signature='iii')
    def Counts(self):
        return tuple(counts)

    @dbus.service.method('io.whatsappcompanion.Test', in_signature='s')
    def ArmMode(self, mode):
        global arm_mode
        arm_mode = mode

    @dbus.service.method('io.whatsappcompanion.Test')
    def ChangeIcon(self):
        global icon_version
        icon_version += 1
        objects[1].NewIcon()


objects = [Watcher(bus, '/StatusNotifierWatcher'), Item(bus, '/StatusNotifierItem'), Menu(bus, '/Menu')]
env = {**os.environ, 'QT_QPA_PLATFORM': 'offscreen', 'QT_QUICK_BACKEND': 'software'}
command = (['node', os.path.join(os.path.dirname(__file__), 'electron.mjs')] if '--electron' in sys.argv
           else ['/usr/bin/python3', os.path.join(os.path.dirname(__file__), 'verify.py')])
child = subprocess.Popen(command, env=env)
loop = GLib.MainLoop()


def check_child():
    if child.poll() is None:
        return True
    loop.quit()
    return False


GLib.timeout_add(50, check_child)
try:
    loop.run()
finally:
    if child.poll() is None:
        child.terminate()
    child.wait(timeout=5)
sys.exit(child.returncode)
