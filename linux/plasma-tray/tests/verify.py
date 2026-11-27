#!/usr/bin/python3
"""Actual QML, D-Bus calls and Qt drag events, using an offscreen window."""
from pathlib import Path
import sys
import time
import dbus
from PyQt6.QtCore import QCoreApplication, QMimeData, QPoint, QPointF, QUrl, Qt
from PyQt6.QtGui import QDragEnterEvent, QDragMoveEvent, QDragLeaveEvent, QDropEvent
from PyQt6.QtQml import QQmlComponent, QQmlEngine, QQmlExpression
from PyQt6.QtQuick import QQuickWindow
from PyQt6.QtGui import QGuiApplication

app = QGuiApplication(sys.argv)
engine = QQmlEngine()
ui = Path(__file__).resolve().parent.parent / 'package/contents/ui'
components = []


def load(name):
    component = QQmlComponent(engine, QUrl.fromLocalFile(str(ui / name)))
    assert not component.isError(), '\n'.join(error.toString() for error in component.errors())
    item = component.create()
    assert item is not None, '\n'.join(error.toString() for error in component.errors())
    components.append(component)
    return item


def wait(ms):
    deadline = time.monotonic() + ms / 1000
    while time.monotonic() < deadline:
        app.processEvents()
        time.sleep(.002)


def until(predicate, ms=2000):
    deadline = time.monotonic() + ms / 1000
    while not predicate():
        assert time.monotonic() < deadline, 'Timed out'
        wait(5)


bus = dbus.SessionBus()
menu = dbus.Interface(bus.get_object('io.whatsappcompanion.Test', '/Menu'), 'io.whatsappcompanion.Test')
sni = load('Sni.qml')
until(lambda: sni.property('available'))
until(lambda: len(sni.property('menu').toVariant()) == 5)
assert sni.property('title') == 'WhatsApp Companion'
assert sni.property('subtitle') == 'Fixture tooltip'
start = time.monotonic()
sni.show()
until(lambda: menu.Counts()[0] == 1)
latency = (time.monotonic() - start) * 1000
assert latency < 150, latency
sni.show()
until(lambda: menu.Counts()[0] == 2)
assert menu.Counts()[1] == 0
sni.activate(0, 0)
until(lambda: menu.Counts()[1] == 1)
print(f'PASS SNI discovery, tooltip, menu, show-only Event twice, click Activate; show callback {latency:.1f} ms')


def reveal():
    expression = QQmlExpression(engine.rootContext(), sni, 'reveal(function() { activate(0, 0); })')
    expression.evaluate()
    assert not expression.hasError(), expression.error().toString()


reveal()
until(lambda: menu.Counts()[0] == 3)
assert tuple(menu.Counts()[1:]) == (1, 1)
menu.ArmMode('failure')
reveal()
until(lambda: menu.Counts()[0] == 4)
assert menu.Counts()[1] == 1
menu.ArmMode('timeout')
reveal()
until(lambda: menu.Counts()[0] == 5)
wait(350)  # Late arm ACK must not call Activate after direct-show fallback.
assert menu.Counts()[0] == 5 and menu.Counts()[1] == 1
menu.ArmMode('missing')
sni.refreshMenu()
until(lambda: len(sni.property('menu').toVariant()) == 4)
reveal()
until(lambda: menu.Counts()[0] == 6)
assert menu.Counts()[1] == 1
print('PASS armed reveal, failed/missing arm fallback, 120 ms timeout fallback, late ACK ignored; no fallback sends Activate')

icon = load('SniIcon.qml')
icon.setProperty('source', sni.property('source'))
until(lambda: icon.property('icon') is not None)
image = icon.property('icon')
assert not image.isNull()
key = image.cacheKey()
menu.ChangeIcon()
until(lambda: icon.property('icon').cacheKey() != key)
assert not icon.property('icon').isNull()
print('PASS optional native SNI model mirrors actual IconPixmap QIcon and NewIcon updates')

hover = load('FileHover.qml')
window = QQuickWindow()
window.resize(100, 100)
hover.setParentItem(window.contentItem())
hover.setWidth(100)
hover.setHeight(100)
shown = []
hover.showRequested.connect(lambda: shown.append(time.monotonic()))
window.show()  # QT_QPA_PLATFORM=offscreen: never maps a desktop surface.
wait(30)


def enter(files=True):
    mime = QMimeData()
    if files:
        mime.setUrls([QUrl('file:///tmp/companion-fixture.txt')])
    else:
        mime.setText('fixture text')
    event = QDragEnterEvent(QPoint(50, 50), Qt.DropAction.CopyAction, mime,
                            Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier)
    QCoreApplication.sendEvent(window, event)
    move = QDragMoveEvent(QPoint(50, 50), Qt.DropAction.CopyAction, mime,
                          Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier)
    QCoreApplication.sendEvent(window, move)
    return mime


mime = enter()
assert hover.property('containsDrag')
wait(250)
assert not shown
QCoreApplication.sendEvent(window, QDragLeaveEvent())
wait(250)
assert not shown
mime = enter()
until(lambda: len(shown) == 1)
wait(500)
assert len(shown) == 1
drop = QDropEvent(QPointF(50, 50), Qt.DropAction.CopyAction, mime,
                  Qt.MouseButton.LeftButton, Qt.KeyboardModifier.NoModifier)
QCoreApplication.sendEvent(window, drop)
assert not drop.isAccepted()
mime = enter(False)
wait(500)
assert len(shown) == 1
QCoreApplication.sendEvent(window, QDragLeaveEvent())
mime = enter()
until(lambda: len(shown) == 2)
QCoreApplication.sendEvent(window, QDragLeaveEvent())
print('PASS real Qt file drag: 400 ms dwell, leave cancels, one show per entry, text ignored, drop rejected, re-entry shows')
window.close()
