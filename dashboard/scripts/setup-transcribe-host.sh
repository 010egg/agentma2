#!/usr/bin/env bash
set -euo pipefail

ROOT="${AGENTMA_TRANSCRIBE_ROOT:-/opt/agentma}"
VENV="${AGENTMA_TRANSCRIBE_VENV:-$ROOT/transcribe-venv}"
HF_CACHE="${AGENTMA_HF_CACHE:-$ROOT/hf-cache}"
MODEL="${AGENTMA_TRANSCRIBE_MODEL:-mlx-community/whisper-large-v3-turbo}"
PYTHON="${AGENTMA_TRANSCRIBE_BOOTSTRAP_PYTHON:-$(command -v python3)}"
MODEL_CACHE_NAME="models--${MODEL//\//--}"
SEED_MODEL_DIR="${AGENTMA_TRANSCRIBE_SEED_MODEL_DIR:-$HOME/.cache/huggingface/hub/$MODEL_CACHE_NAME}"
TARGET_MODEL_DIR="$HF_CACHE/hub/$MODEL_CACHE_NAME"

if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
  echo "mlx-whisper deployment requires macOS on Apple Silicon" >&2
  exit 1
fi

command -v ffmpeg >/dev/null || { echo "ffmpeg is required (brew install ffmpeg)" >&2; exit 1; }
command -v ffprobe >/dev/null || { echo "ffprobe is required (brew install ffmpeg)" >&2; exit 1; }
[[ -d "/Applications/Google Chrome.app" ]] || { echo "Google Chrome is required" >&2; exit 1; }

if [[ ! -d "$ROOT" ]]; then
  sudo mkdir -p "$ROOT"
  sudo chown "$(id -u):$(id -g)" "$ROOT"
fi
mkdir -p "$HF_CACHE"
chmod -R u+w "$HF_CACHE" 2>/dev/null || true

if [[ ! -x "$VENV/bin/python" ]]; then
  "$PYTHON" -m venv "$VENV"
fi
"$VENV/bin/python" -m pip install --upgrade pip
"$VENV/bin/python" -m pip install mlx-whisper 'httpx[socks]'

if [[ -d "$SEED_MODEL_DIR" && ! -d "$TARGET_MODEL_DIR" ]]; then
  mkdir -p "$HF_CACHE/hub"
  cp -cR "$SEED_MODEL_DIR" "$TARGET_MODEL_DIR" 2>/dev/null \
    || cp -R "$SEED_MODEL_DIR" "$TARGET_MODEL_DIR"
fi

if [[ ! -d "$TARGET_MODEL_DIR" ]]; then
  HF_HOME="$HF_CACHE" "$VENV/bin/python" - "$MODEL" <<'PY'
import sys
from huggingface_hub import snapshot_download

print(snapshot_download(sys.argv[1]))
PY
fi

HF_HOME="$HF_CACHE" HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 \
  "$VENV/bin/python" - "$MODEL" <<'PY'
import sys
from huggingface_hub import snapshot_download
import mlx_whisper

print("model:", snapshot_download(sys.argv[1], local_files_only=True))
print("mlx_whisper:", mlx_whisper.__file__)
PY

chmod -R a-w "$HF_CACHE"
echo "transcribe runtime ready"
echo "  venv: $VENV"
echo "  HF_HOME: $HF_CACHE"
echo "  ffmpeg: $(command -v ffmpeg)"
echo "  Chrome: /Applications/Google Chrome.app"
