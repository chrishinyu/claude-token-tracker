#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOST_JS="$SCRIPT_DIR/host.js"

# Detect OS
case "$(uname -s)" in
  Darwin)
    NMH_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
    ;;
  Linux)
    NMH_DIR="$HOME/.config/google-chrome/NativeMessagingHosts"
    ;;
  *)
    echo "Unsupported OS: $(uname -s)"; exit 1
    ;;
esac

EXT_ID="${1:-}"
if [ -z "$EXT_ID" ]; then
  echo "Usage: $0 <chrome-extension-id>"
  echo ""
  echo "Find your extension ID at chrome://extensions (enable Developer mode)"
  exit 1
fi

chmod +x "$HOST_JS"
mkdir -p "$NMH_DIR"

# Write manifest with correct absolute path and extension ID
cat > "$NMH_DIR/com.token_tracker.bridge.json" <<EOF
{
  "name": "com.token_tracker.bridge",
  "description": "Token Tracker filesystem bridge",
  "path": "$HOST_JS",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$EXT_ID/"]
}
EOF

# Create data directory
mkdir -p "$HOME/.token-tracker"

# Symlink statusline
CLI_DIR="$(cd "$SCRIPT_DIR/../cli" && pwd)"
ln -sf "$CLI_DIR/tt-statusline.sh" "$HOME/.token-tracker/statusline.sh"

# Symlink tt CLI
mkdir -p "$HOME/bin"
ln -sf "$CLI_DIR/tt.js" "$HOME/bin/tt"

echo "Done!"
echo "  Native host: $NMH_DIR/com.token_tracker.bridge.json"
echo "  CLI:         ~/bin/tt"
echo "  Statusline:  ~/.token-tracker/statusline.sh"
echo ""
echo "Restart Chrome, then run: tt status"
echo ""
echo "For Claude Code status line, add to ~/.claude/settings.json:"
echo '  "statusLine": { "type": "command", "command": "~/.token-tracker/statusline.sh" }'
