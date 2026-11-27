pragma ComponentBehavior: Bound
import QtQuick
import org.kde.kirigami as Kirigami
import org.kde.plasma.core as PlasmaCore
import org.kde.plasma.plasmoid

PlasmoidItem {
    id: root
    preferredRepresentation: compactRepresentation
    fullRepresentation: compactRepresentation
    readonly property var iconBridge: badgedIcon.item
    readonly property var trayHost: Plasmoid.containment
    toolTipMainText: sni.title
    toolTipSubText: sni.subtitle
    Plasmoid.status: sni.available ? PlasmaCore.Types.ActiveStatus : PlasmaCore.Types.HiddenStatus
    Plasmoid.title: sni.title
    Plasmoid.icon: sni.iconName || "whatsapp"

    Sni { id: sni }
    Loader {
        id: badgedIcon
        source: "SniIcon.qml"
        onLoaded: item.source = Qt.binding(() => sni.source)
    }

    function entry(label: string): var {
        return sni.menu.find(item => item.properties.label === label);
    }
    function trigger(label: string): void {
        const action = entry(label);
        if (action) sni.event(action.id);
    }
    function checked(label: string): bool {
        return entry(label)?.properties["toggle-state"] === 1;
    }
    function activate(x: int, y: int, visualParent: var): void {
        // Use the containing tray's normal activation path when available;
        // it supplies the Wayland activation token, exactly like its SNI item.
        if (trayHost && typeof trayHost.activate === "function") {
            trayHost.activate(sni.source, Qt.point(x, y), visualParent);
        } else {
            sni.activate(x, y);
        }
    }

    // Plasma intercepts right-click on tray plasmoids before their MouseArea.
    // Render the app's actual DBusMenu actions in its contextual action list.
    // Qt tooling cannot resolve the runtime Plasma Applet attached list.
    // qmllint disable missing-property
    Plasmoid.contextualActions: [
        PlasmaCore.Action { text: "Open WhatsApp Companion"; onTriggered: sni.show() },
        PlasmaCore.Action { isSeparator: true },
        PlasmaCore.Action { text: "Notifications"; checkable: true; checked: root.checked("Notifications"); onTriggered: root.trigger(text) },
        PlasmaCore.Action { text: "Start at login"; checkable: true; checked: root.checked("Start at login"); onTriggered: root.trigger(text) },
        PlasmaCore.Action { isSeparator: true },
        PlasmaCore.Action { text: "Quit"; onTriggered: root.trigger(text) }
    ]
    // qmllint enable missing-property
    Plasmoid.onContextualActionsAboutToShow: sni.refreshMenu()
    Plasmoid.onActivated: root.activate(0, 0, root)

    compactRepresentation: MouseArea {
        id: mouse
        acceptedButtons: Qt.LeftButton | Qt.MiddleButton
        onClicked: event => {
            const point = mapToGlobal(event.x, event.y);
            root.activate(point.x, point.y, mouse);
        }
        Kirigami.Icon {
            anchors.fill: parent
            source: root.iconBridge?.icon || sni.iconName || Qt.resolvedUrl("../images/tray.svg")
            active: mouse.containsMouse
        }
        FileHover {
            anchors.fill: parent
            enabled: sni.available
            onShowRequested: {
                if (root.trayHost && typeof root.trayHost.activate === "function") {
                    const point = mouse.mapToGlobal(mouse.width / 2, mouse.height / 2);
                    sni.reveal(() => root.activate(point.x, point.y, mouse));
                } else {
                    sni.show();
                }
            }
        }
    }
}
