// Optional private API, loaded separately so an incompatible import only loses
// the badged icon. Actions/discovery use public D-Bus interfaces in Sni.qml.
pragma ComponentBehavior: Bound
import QtQuick
import org.kde.plasma.private.systemtray as SystemTray

Item {
    id: root
    property string source: ""
    property var icon: null
    onSourceChanged: icon = null
    Instantiator {
        model: SystemTray.StatusNotifierModel {}
        delegate: QtObject {
            required property var model
            readonly property var matchingIcon: model.DataEngineSource === root.source ? model.Icon || model.IconName : null
            onMatchingIconChanged: { if (matchingIcon) root.icon = matchingIcon; }
            Component.onCompleted: { if (matchingIcon) root.icon = matchingIcon; }
        }
    }
}
