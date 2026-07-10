#!/usr/bin/env bash
set -euo pipefail

PLUGIN_NAME="opentoken-image-gen"
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PLUGIN_DEST="${PLUGIN_DEST:-$HOME/plugins/$PLUGIN_NAME}"
SKILL_DEST="${SKILL_DEST:-$HOME/.codex/skills/$PLUGIN_NAME}"

echo "📦 Installing $PLUGIN_NAME"
echo "Source: $SOURCE_DIR"
echo "Plugin files: $PLUGIN_DEST"
echo "Codex skill:  $SKILL_DEST"
echo

mkdir -p "$PLUGIN_DEST" "$SKILL_DEST"

# Install the plugin runtime files. The SKILL.md intentionally points to:
#   $HOME/plugins/opentoken-image-gen/scripts/generate.mjs
# so keep this destination stable unless you also update SKILL.md.
rsync -a \
  --exclude ".DS_Store" \
  --exclude ".git" \
  --exclude "README.md" \
  --exclude "install.sh" \
  "$SOURCE_DIR/" "$PLUGIN_DEST/"

# Also install the skill into Codex's user skill directory so Codex can discover it
# even when not using a plugin marketplace/installer.
rsync -a \
  --exclude ".DS_Store" \
  "$SOURCE_DIR/skills/$PLUGIN_NAME/" "$SKILL_DEST/"

chmod +x "$PLUGIN_DEST/scripts/generate.mjs" "$PLUGIN_DEST/scripts/validate-image.test.mjs" 2>/dev/null || true

echo "✅ Installed."
echo
echo "Next steps:"
echo "1. Restart Codex, or start a new task so the skill list refreshes."
echo "2. First use will ask for your OpenToken API Key."
echo "3. Config will be saved at: $HOME/.codex/opentoken-image-gen-config.json"
echo
echo "Quick check:"
echo "  node \"$PLUGIN_DEST/scripts/generate.mjs\" --get-config"
