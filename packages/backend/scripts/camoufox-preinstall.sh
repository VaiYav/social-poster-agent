#!/bin/sh
# Camoufox pre-install script for Docker build.
#
# Runs the camoufox-js CamoufoxFetcher to download + extract the browser binary.
# Then verifies that camoufox-bin actually exists — AdmZip in camoufox-js silently
# fails to extract the large (~200MB) binary from the 557MB zip while small files
# (fonts, addons, version.json) extract fine. If the binary is missing, falls back
# to curl + unzip (system tools) which handle large files correctly.
#
# Usage: camoufox-preinstall.sh <path-to-pkgman.js>
# Env:   GITHUB_TOKEN (optional, raises GitHub API rate limit from 60 to 5000/hr)
#        HOME          (must be /home/spa so INSTALL_DIR resolves correctly)
set -eu

CMX="${1:?usage: camoufox-preinstall.sh <path-to-pkgman.js>}"
INSTALL_DIR="${HOME}/.cache/camoufox"
LAUNCH_FILE="camoufox-bin"   # Linux only — this script runs inside the Linux container

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

if [ ! -f "$INSTALL_DIR/version.json" ]; then
    echo "[Camoufox pre-install] all attempts failed — will retry at runtime"
    exit 0  # non-fatal — app will retry at runtime
fi

# --- Phase 3: AdmZip silent failure fallback (curl + unzip) ---
echo "[Camoufox pre-install] version.json present but $LAUNCH_FILE MISSING — AdmZip silent extraction failure"
echo "[Camoufox pre-install] falling back to curl + unzip..."

# Get the download URL from the CamoufoxFetcher (hits GitHub API)
DL_URL=$(CMX="$CMX" node -e "
    const { CamoufoxFetcher } = require(process.env.CMX);
    const f = new CamoufoxFetcher();
    f.init().then(() => console.log(f.url)).catch(e => { console.error(e.message); process.exit(1); });
" 2>/dev/null) || true

if [ -z "$DL_URL" ]; then
    echo "[Camoufox pre-install] could not get download URL — will retry at runtime"
    exit 0  # non-fatal
fi

echo "[Camoufox pre-install] downloading from $DL_URL..."
if ! curl -fsSL -o /tmp/camoufox.zip "$DL_URL"; then
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

if [ -f "$INSTALL_DIR/$LAUNCH_FILE" ]; then
    echo "[Camoufox pre-install] verified: $LAUNCH_FILE present after unzip fallback"
else
    echo "[Camoufox pre-install] ERROR: $LAUNCH_FILE still missing after unzip fallback — will retry at runtime"
fi
