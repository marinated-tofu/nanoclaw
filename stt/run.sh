#!/usr/bin/env bash
# Build and (re)start the speech-to-text container, listening on 127.0.0.1:8178.
# On WSL the GPU is passed in through /dev/dxg and the driver in /usr/lib/wsl,
# so no NVIDIA container runtime is needed. Without them it runs on the CPU.
set -euo pipefail
cd "$(dirname "$0")"
name=nanoclaw-stt
DOCKER_BUILDKIT=1 docker build --progress=quiet -t "$name" .
gpu=()
if [ -e /dev/dxg ] && [ -d /usr/lib/wsl/lib ]; then
  gpu=(--device /dev/dxg -v /usr/lib/wsl:/usr/lib/wsl:ro)
fi
docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" --restart unless-stopped \
  -p 127.0.0.1:8178:8178 -v nanoclaw-stt-models:/models "${gpu[@]}" \
  -e STT_MODEL="${STT_MODEL:-large-v3-turbo}" "$name" >/dev/null
echo "$name running on 127.0.0.1:8178"
