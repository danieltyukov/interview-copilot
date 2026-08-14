#!/usr/bin/env bash
# Install the meeting-copilot command so you can launch it in any directory,
# the same way you launch claude. Creates a venv, installs the package into it,
# and symlinks the launcher onto your PATH.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="$HERE/.venv"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

echo "==> Ensuring system deps (ffmpeg) are available"
if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "    ffmpeg not found. Install it first, e.g.:  sudo apt install ffmpeg"
  exit 1
fi

echo "==> Creating venv at $VENV"
[ -d "$VENV" ] || python3 -m venv "$VENV"

echo "==> Installing package (this pulls faster-whisper, may take a minute)"
"$VENV/bin/python" -m pip install --quiet --upgrade pip
"$VENV/bin/python" -m pip install --quiet -e "$HERE"

echo "==> Linking launcher into $BIN_DIR"
mkdir -p "$BIN_DIR"
ln -sf "$VENV/bin/meeting-copilot" "$BIN_DIR/meeting-copilot"

echo
echo "Done. 'meeting-copilot' is installed."
case ":$PATH:" in
  *":$BIN_DIR:"*) echo "You can run it now from any directory:  meeting-copilot" ;;
  *) echo "Add $BIN_DIR to your PATH, then run:  meeting-copilot"
     echo "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.bashrc && source ~/.bashrc" ;;
esac
echo
echo "Transcription uses Deepgram streaming by default. Put your key in:"
echo "  ~/.config/meeting-copilot/config.env   ->   DEEPGRAM_API_KEY=..."
echo "Or run fully offline with:  meeting-copilot --stt local   (downloads Whisper ~140MB)"
echo "Check everything with:  meeting-copilot --self-test"
