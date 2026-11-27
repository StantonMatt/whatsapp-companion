pragma ComponentBehavior: Bound
import QtQuick
import org.kde.plasma.workspace.dbus as DBus

Item {
    id: root
    property string source: ""
    readonly property string service: source.split("/")[0]
    readonly property string path: source.includes("/") ? source.slice(source.indexOf("/")) : "/StatusNotifierItem"
    property var properties: ({})
    property var menu: []
    property string menuPath: ""
    property int generation: 0
    property int revealSequence: 0
    property int pendingReveal: 0
    readonly property bool available: source !== ""
    readonly property string title: properties.Title || properties.ToolTip?.[2] || "WhatsApp Companion"
    readonly property string subtitle: properties.ToolTip ? properties.ToolTip[3] || "" : ""
    readonly property string iconName: properties.IconName || ""

    function unwrap(value: var): var {
        if (value && typeof value !== "string" && typeof value.length === "number") return Array.from(value, unwrap);
        if (value && typeof value === "object") {
            if (value.value !== undefined) {
                if (value.value && typeof value.value === "object" && typeof value.toString === "function") return value.toString();
                return unwrap(value.value);
            }
            const plain = ({});
            for (const key of Object.keys(value)) plain[key] = unwrap(value[key]);
            return plain;
        }
        return value;
    }

    function call(target: string, objectPath: string, iface: string, member: string,
                  signature: string, args: var, done: var, failed: var): void {
        DBus.SessionBus.asyncCall({ service: target, path: objectPath, iface: iface,
            member: member, signature: "(" + signature + ")", arguments: args },
            reply => { if (done) done(unwrap(reply.values)); },
            error => {
                if (failed) failed();
                else console.warn("WhatsApp tray:", member, error.error.message);
            });
    }

    function discover(): void {
        const current = ++generation;
        call("org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher", "org.freedesktop.DBus.Properties",
             "Get", "ss", ["org.kde.StatusNotifierWatcher", "RegisteredStatusNotifierItems"], values => {
            const sources = values[0] || [];
            if (!sources.includes(source)) { source = ""; properties = ({}); menu = []; }
            for (const candidate of sources) {
                const slash = candidate.indexOf("/");
                const bus = slash < 0 ? candidate : candidate.slice(0, slash);
                const objectPath = slash < 0 ? "/StatusNotifierItem" : candidate.slice(slash);
                call(bus, objectPath, "org.freedesktop.DBus.Properties", "GetAll", "s",
                     ["org.kde.StatusNotifierItem"], result => {
                    if (current !== generation) return;
                    const item = result[0];
                    // Electron 44 uses an app-specific Id even when Title is empty.
                    // Accept only this app, never another Electron tray item.
                    if (!/^WhatsApp Companion_status_icon_[0-9]+$/.test(item.Id || "")) return;
                    source = candidate; properties = item;
                    menuPath = item.Menu || "";
                    refreshMenu();
                });
            }
        });
    }

    function refreshMenu(): void {
        if (!available || !menuPath) return;
        const current = source;
        call(service, menuPath, "com.canonical.dbusmenu", "GetLayout", "iias", [0, 1, []], values => {
            if (current !== source) return;
            menu = values[1][2].map(node => ({ id: node[0], properties: node[1] }));
        });
    }

    function event(id: int): void {
        if (!available || !menuPath) return;
        call(service, menuPath, "com.canonical.dbusmenu", "Event", "isvu",
             [id, "clicked", new DBus.int32(0), 0], () => refreshMenu());
    }

    function show(): void {
        // Reuse the app's existing show-only callback. Never call Activate or
        // SecondaryActivate here: both toggle on Electron/Linux.
        const open = menu.find(item => item.properties.label === "Open WhatsApp Companion"
                              && item.properties.enabled !== false && item.properties.visible !== false);
        if (open) event(open.id);
    }

    function reveal(activate: var): void {
        const arm = menu.find(item => item.properties.label === "Prepare drag reveal"
                             && item.properties.enabled !== false);
        if (!arm) { show(); return; }
        const sequence = ++revealSequence;
        const current = source;
        pendingReveal = sequence;
        armDeadline.restart();
        call(service, menuPath, "com.canonical.dbusmenu", "Event", "isvu",
             [arm.id, "clicked", new DBus.int32(0), 0], () => {
            // A late acknowledgement must never launch a toggle after fallback.
            if (pendingReveal !== sequence || source !== current) return;
            pendingReveal = 0;
            armDeadline.stop();
            try { activate(); } catch (error) { show(); }
        }, () => {
            if (pendingReveal !== sequence) return;
            pendingReveal = 0;
            armDeadline.stop();
            show();
        });
    }

    Timer {
        id: armDeadline
        interval: 120
        onTriggered: { root.pendingReveal = 0; root.show(); }
    }

    function activate(x: int, y: int): void {
        if (available) call(service, path, "org.kde.StatusNotifierItem", "Activate", "ii", [x, y], null);
    }

    Component.onCompleted: discover()
    // Also recovers after the app or watcher restarts. No command spawning.
    Timer { interval: 2000; running: true; repeat: true; onTriggered: root.discover() }
    DBus.SignalWatcher {
        service: root.service
        path: root.menuPath
        iface: "com.canonical.dbusmenu"
        enabled: root.available && root.menuPath !== ""
        function dbusLayoutUpdated(): void { root.refreshMenu(); }
        function dbusItemsPropertiesUpdated(): void { root.refreshMenu(); }
    }
}
