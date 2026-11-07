#!/bin/sh
# Makes the Linux installers from a packaged app: linux-installers.sh <version> <x64|arm64> <app dir>
# Writes release/Railnote-<version>-linux-<arch>.AppImage and release/railnote_<version>_<deb arch>.deb.
# Needs dpkg-deb, curl and file; installs them first when run as root in a bare Debian container.
set -eu
VERSION=$1 ARCH=$2 APP=$3
case $ARCH in x64) DEB=amd64 AI=x86_64 ;; arm64) DEB=arm64 AI=aarch64 ;; *) echo "unknown arch $ARCH" >&2; exit 1 ;; esac
if [ "$(id -u)" = 0 ] && ! command -v curl >/dev/null; then
  apt-get update -qq && apt-get install -y -qq curl file dpkg-dev >/dev/null
fi
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

DESKTOP="[Desktop Entry]
Name=Railnote
Comment=Markdown notes that work the moment you open them
Exec=railnote %U
Icon=railnote
Type=Application
Categories=Office;TextEditor;
MimeType=text/markdown;
StartupWMClass=Railnote"

# The .deb: the app in /opt/Railnote, a railnote command, a menu entry and an icon.
D=$WORK/deb
mkdir -p "$D/DEBIAN" "$D/opt" "$D/usr/bin" "$D/usr/share/applications" "$D/usr/share/icons/hicolor/1024x1024/apps"
cp -a "$APP" "$D/opt/Railnote"
chmod -R a+rX "$D/opt/Railnote"
ln -s /opt/Railnote/railnote "$D/usr/bin/railnote"
printf '%s\n' "$DESKTOP" > "$D/usr/share/applications/railnote.desktop"
cp build/icon.png "$D/usr/share/icons/hicolor/1024x1024/apps/railnote.png"
cat > "$D/DEBIAN/control" <<EOF
Package: railnote
Version: $VERSION
Architecture: $DEB
Maintainer: Railhq <222635+markqian@users.noreply.github.com>
Homepage: https://github.com/Railhq/railnote
Section: editors
Priority: optional
Depends: libgtk-3-0, libnss3, libxss1, libasound2t64 | libasound2, libgbm1, xdg-utils
Description: Markdown notes that work the moment you open them
 Open-source Markdown notes: opens Obsidian vaults, asks your notes through the
 coding agent you already have, and syncs end to end encrypted.
EOF
# Chromium's sandbox helper must be setuid root, which a package can do and an AppImage can't.
cat > "$D/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
chown root:root /opt/Railnote/chrome-sandbox
chmod 4755 /opt/Railnote/chrome-sandbox
command -v update-desktop-database >/dev/null && update-desktop-database -q || true
EOF
chmod 755 "$D/DEBIAN/postinst"
dpkg-deb --root-owner-group -Zxz --build "$D" "release/railnote_${VERSION}_${DEB}.deb" >/dev/null

# The AppImage: one file that runs on most distributions.
A=$WORK/Railnote.AppDir
cp -a "$APP" "$A"
chmod -R a+rX "$A"
printf '%s\n' "$DESKTOP" > "$A/railnote.desktop"
cp build/icon.png "$A/railnote.png"
ln -s railnote.png "$A/.DirIcon"
cat > "$A/AppRun" <<'EOF'
#!/bin/sh
# An AppImage can't carry the setuid sandbox helper, so Chromium needs unprivileged user
# namespaces for its sandbox. Where the system forbids them (Ubuntu 24.04 and later, through
# AppArmor), the app would crash on launch, so it runs without the sandbox there instead.
HERE=$(dirname "$(readlink -f "$0")")
if [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ] ||
   [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null)" = 0 ]; then
  exec "$HERE/railnote" --no-sandbox "$@"
fi
exec "$HERE/railnote" "$@"
EOF
chmod 755 "$A/AppRun"
TOOLS=$WORK/tools
mkdir -p "$TOOLS"
HOST=$(uname -m)
curl -fsSL -o "$TOOLS/appimagetool" "https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-$HOST.AppImage"
curl -fsSL -o "$TOOLS/runtime" "https://github.com/AppImage/type2-runtime/releases/download/continuous/runtime-$AI"
chmod +x "$TOOLS/appimagetool"
(cd "$TOOLS" && ./appimagetool --appimage-extract >/dev/null)
ARCH=$AI "$TOOLS/squashfs-root/AppRun" --no-appstream --runtime-file "$TOOLS/runtime" "$A" "release/Railnote-$VERSION-linux-$ARCH.AppImage"
