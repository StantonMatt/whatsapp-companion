#!/usr/bin/env bash
set -euo pipefail

directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
id=io.whatsappcompanion.tray
command -v kpackagetool6 >/dev/null || { echo 'Plasma 6 kpackagetool6 is required.' >&2; exit 1; }
case "${1:-install}" in
  install)
    if kpackagetool6 --type Plasma/Applet --show "$id" >/dev/null 2>&1; then
      kpackagetool6 --type Plasma/Applet --upgrade "$directory/package"
    else
      kpackagetool6 --type Plasma/Applet --install "$directory/package"
    fi
    echo 'Package installed. Enable it in System Tray Settings → Entries; see README.md to disable the original icon.'
    ;;
  remove)
    kpackagetool6 --type Plasma/Applet --remove "$id"
    echo 'Restore the original WhatsApp Companion entry to Automatic in System Tray Settings → Entries.'
    ;;
  *) echo "Usage: $0 [install|remove]" >&2; exit 2 ;;
esac
