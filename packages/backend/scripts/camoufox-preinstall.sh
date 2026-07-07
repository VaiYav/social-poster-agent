#!/bin/sh
# Camoufox pre-install script for Docker build.
#
# Runs the camoufox-js CamoufoxFetcher to download + extract the browser binary.
# Then verifies that camoufox-bin actually exists. Two known failure modes:
#   1. AdmZip in camoufox-js silently fails to extract large files
#   2. The latest release (v152.0.2-alpha) ships a broken Linux zip that contains
#      only fonts/config — no camoufox-bin binary at all
# If the binary is missing after the JS install, falls back to downloading a
# known-good release (v150.0.2-beta.25) directly with curl + unzip.
#
# Usage: camoufox-preinstall.sh <path-to-pkgman.js>
# Env:   GITHUB_TOKEN (optional, raises GitHub API rate limit from 60 to 5000/hr)
#        HOME          (must be /home/spa so INSTALL_DIR resolves correctly)
set -eu

CMX="${1:?usage: camoufox-preinstall.sh <path-to-pkgman.js>}"
INSTALL_DIR="${HOME}/.cache/camoufox"
LAUNCH_FILE="camoufox-bin"   # Linux only — this script runs inside the Linux container

# Known-good release with a working camoufox-bin in the Linux x86_64 zip.
# v152.0.2-alpha is broken (zip contains only fonts, no binary).
FALLBACK_URL="https://github.com/daijro/camoufox/releases/download/v150.0.2-beta.25/camoufox-150.0.2-alpha.26-lin.x86_64.zip"
FALLBACK_VERSION='{"version":"150.0.2","release":"alpha.26"}'

echo "[Camoufox pre-install] pkgman: $CMX"
echo "[Camoufox pre-install] install dir: $INSTALL_DIR"

# --- Phase 1: Try the JS-based install (CamoufoxFetcher) ---
for attempt in 1 2 3; do
    echo "[Camoufox pre-install] attempt $attempt/3..."
    if CMX="$CMX" node -e "
        const { CamoufoxFetcher } = require(process.env.CMX);
        new CamoufoxFetcher().install()
            .then(() => { console.log('Camoufox pre-installed OK'); process.exit(0); })
            .catch(e => { console.log('attempt failed: ' + e.message); process.exit(1); });
    " 2>&1; then
        break
    fi
    echo "[Camoufox pre-install] attempt $attempt failed, sleeping before retry..."
    sleep $((attempt * 10))
done

# --- Phase 2: Verify the binary exists ---
if [ -f "$INSTALL_DIR/$LAUNCH_FILE" ]; then
    echo "[Camoufox pre-install] verified: $LAUNCH_FILE present"
    exit 0
fi

# --- Phase 3: Binary missing — download known-good release directly ---
echo "[Camoufox pre-install] $LAUNCH_FILE MISSING after JS install (broken release or AdmZip failure)"
echo "[Camoufox pre-install] falling back to known-good release: $FALLBACK_URL"

echo "[Camoufox pre-install] downloading..."
if ! curl --retry 3 --retry-delay 5 -fsSL -o /tmp/camoufox.zip "$FALLBACK_URL"; then
    echo "[Camoufox pre-install] curl download failed — will retry at runtime"
    rm -f /tmp/camoufox.zip
    exit 0  # non-fatal
fi

# Clean the partial extraction and re-extract with unzip
rm -rf "${INSTALL_DIR:?}/"*
if ! unzip -o /tmp/camoufox.zip -d "$INSTALL_DIR/"; then
    echo "[Camoufox pre-install] unzip extraction failed — will retry at runtime"
    rm -f /tmp/camoufox.zip
    exit 0  # non-fatal
fi
rm -f /tmp/camoufox.zip
chmod -R 755 "$INSTALL_DIR/"

# Write version.json so camoufox-js Version.fromPath() recognises this install
echo "$FALLBACK_VERSION" > "$INSTALL_DIR/version.json"

if [ -f "$INSTALL_DIR/$LAUNCH_FILE" ]; then
    echo "[Camoufox pre-install] verified: $LAUNCH_FILE present after fallback"
else
    echo "[Camoufox pre-install] ERROR: $LAUNCH_FILE still missing after fallback — will retry at runtime"
fi
