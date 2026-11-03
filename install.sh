#!/bin/bash
set -euo pipefail

# Installs "Zulip Stash": a small app that opens the Zulip Mac app with Zulip Stash
# already loaded. Run this again after you change core.js or the launcher.
#
#   ./install.sh                          every Zulip server in the app gets Stash
#   ./install.sh recurse.zulipchat.com    only the servers you list (separate with spaces)
#
# Two optional settings, as environment variables (for your own private build):
#   APP_NAME="My Zulip"     build an app with another name (and its own folder)
#   HOOK=/path/to/hook.js   page code that runs on every save (see the README)
#
# The copies live in ~/Library/Application Support/Zulip Stash/ (not in ~/Documents)
# because an app started from Finder isn't allowed to read ~/Documents without asking.

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="${APP_NAME:-Zulip Stash}"
DATA="$HOME/Library/Application Support/$APP_NAME"
APP="$HOME/Applications/$APP_NAME.app"
SLUG="$(echo "$APP_NAME" | tr 'A-Z ' 'a-z-')"
NODE="$(command -v node || true)"

[ -n "$NODE" ] || { echo "This needs Node.js (version 22 or newer). Install it from nodejs.org or with: brew install node"; exit 1; }
[ "$("$NODE" -p 'process.versions.node.split(".")[0]')" -ge 22 ] || { echo "Node is too old ($("$NODE" -v)). Version 22 or newer is needed."; exit 1; }
[ -d /Applications/Zulip.app ] || { echo "Zulip isn't in /Applications. Install the Zulip Mac app first."; exit 1; }

EXTRA=""
if [ "$APP_NAME" != "Zulip Stash" ]; then
  EXTRA="$EXTRA --name '$APP_NAME'"
fi
if [ "$#" -gt 0 ]; then
  EXTRA="$EXTRA --only $(IFS=,; echo "$*")"
fi
if [ -n "${HOOK:-}" ]; then
  [ -f "$HOOK" ] || { echo "No such file: $HOOK"; exit 1; }
fi

mkdir -p "$DATA" "$HOME/Applications"
cp "$HERE/zulip-stash-launcher.mjs" "$DATA/"
cp "$HERE/core.js" "$DATA/"
if [ -n "${HOOK:-}" ]; then
  cp "$HOOK" "$DATA/hook.js"
  EXTRA="$EXTRA --hook '$DATA/hook.js'"
fi

SCRIPT="$(mktemp -t zulip-stash).applescript"
cat > "$SCRIPT" <<EOF
do shell script "nohup '$NODE' '$DATA/zulip-stash-launcher.mjs' $EXTRA >> '$HOME/Library/Logs/$SLUG.log' 2>&1 < /dev/null &"
EOF
rm -rf "$APP"
osacompile -o "$APP" "$SCRIPT"
rm -f "$SCRIPT"

# Run without a Dock icon or menu bar, then sign again since the plist changed.
defaults write "$APP/Contents/Info" LSUIElement -bool true
codesign --force --sign - "$APP" >/dev/null 2>&1

echo "Installed: $APP"
echo "Open it instead of Zulip. Log: ~/Library/Logs/$SLUG.log"
