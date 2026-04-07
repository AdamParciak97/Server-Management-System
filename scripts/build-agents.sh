#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
IMAGE="${GO_BUILDER_IMAGE:-golang:1.23-alpine}"

command -v docker >/dev/null || { echo "ERROR: docker not found"; exit 1; }

mkdir -p "$ROOT_DIR/bin"

docker run --rm \
    -v "${ROOT_DIR}:/src" \
    -w /src \
    "$IMAGE" \
    sh -c '
        set -e
        apk add --no-cache git >/dev/null
        go mod download
        CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o bin/sms-agent-linux-amd64 ./agent/
        CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -o bin/sms-agent-linux-arm64 ./agent/
        CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -o bin/sms-agent-windows-amd64.exe ./agent/
    '

echo "Built agent artifacts:"
echo "  bin/sms-agent-linux-amd64"
echo "  bin/sms-agent-linux-arm64"
echo "  bin/sms-agent-windows-amd64.exe"
