pragma ComponentBehavior: Bound
import QtQuick

DropArea {
    id: root
    signal showRequested()
    property bool requested: false
    // Only file/URI drags start the dwell, never text or ordinary mouse hover.
    onEntered: drag => {
        requested = false;
        drag.accepted = drag.hasUrls;
        if (drag.accepted) dwell.restart();
    }
    onExited: { dwell.stop(); requested = false; }
    onDropped: drop => {
        dwell.stop();
        // This is a reveal target, not a file receiver. Keep the drag available
        // for the user to move into WhatsApp; never report a completed transfer.
        drop.accepted = false;
    }
    Timer {
        id: dwell
        interval: 400
        onTriggered: {
            if (root.containsDrag && !root.requested) {
                root.requested = true;
                root.showRequested();
            }
        }
    }
}
