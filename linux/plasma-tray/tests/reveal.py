#!/usr/bin/python3
"""QML client for the real Electron fixture, run only on the disposable bus."""
from pathlib import Path
import sys
import time
from PyQt6.QtCore import QUrl
from PyQt6.QtGui import QGuiApplication
from PyQt6.QtQml import QQmlComponent, QQmlEngine, QQmlExpression

app = QGuiApplication(sys.argv)
engine = QQmlEngine()
ui = Path(__file__).resolve().parent.parent / 'package/contents/ui'
component = QQmlComponent(engine, QUrl.fromLocalFile(str(ui / 'Sni.qml')))
sni = component.create()
assert sni is not None, [error.toString() for error in component.errors()]


def wait(ms):
    deadline = time.monotonic() + ms / 1000
    while time.monotonic() < deadline:
        app.processEvents()
        time.sleep(.001)


deadline = time.monotonic() + 5
while not sni.property('menu').toVariant():
    assert time.monotonic() < deadline, 'Electron SNI/menu discovery timed out'
    wait(5)
menu = sni.property('menu').toVariant()
arm = next(item for item in menu if item['properties'].get('label') == 'Prepare drag reveal')
assert arm['properties']['visible'] is False, 'Internal handshake must be hidden on every DE'
expression = QQmlExpression(engine.rootContext(), sni, 'reveal(function() { activate(0, 0); })')
start = time.monotonic()
expression.evaluate()
assert not expression.hasError(), expression.error().toString()
while sni.property('pendingReveal'):
    assert time.monotonic() - start < .15, 'Arm did not complete within 150 ms'
    wait(1)
wait(30)
print(f'PASS real Electron SNI, hidden arm export and QML reveal handshake ({(time.monotonic() - start) * 1000:.1f} ms including 30 ms observation)')
