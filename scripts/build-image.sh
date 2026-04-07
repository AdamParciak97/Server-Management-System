#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

IMAGE_NAME="sms-server"
IMAGE_TAG="latest"
POSTGRES_IMAGE="postgres:16-alpine"
DATE="$(date +%Y%m%d_%H%M)"
DEPLOY_DIR="sms-deploy"
DEPLOY_ARCHIVE="sms-deploy-${DATE}.tar.gz"

command -v docker >/dev/null || { echo "ERROR: docker not found"; exit 1; }

echo "== SMS release build =="
echo "Date: $(date)"

echo ""
echo "[1/6] Building agent binaries with Docker..."
bash scripts/build-agents.sh

echo ""
echo "[2/6] Checking postgres image..."
if docker image inspect "$POSTGRES_IMAGE" >/dev/null 2>&1; then
    echo "  Found local image: $POSTGRES_IMAGE"
else
    echo "  Pulling $POSTGRES_IMAGE..."
    docker pull "$POSTGRES_IMAGE"
fi

echo ""
echo "[3/6] Building server image ${IMAGE_NAME}:${IMAGE_TAG}..."
docker build \
    --no-cache \
    --file Dockerfile.server \
    --tag "${IMAGE_NAME}:${IMAGE_TAG}" \
    --label "build.date=${DATE}" \
    --label "build.host=$(hostname)" \
    .
docker images "${IMAGE_NAME}:${IMAGE_TAG}" --format "  Size: {{.Size}}"

echo ""
echo "[4/6] Exporting Docker images..."
IMAGES_DIR="$(mktemp -d)"
docker save "${IMAGE_NAME}:${IMAGE_TAG}" -o "${IMAGES_DIR}/sms-server.tar"
docker save "${POSTGRES_IMAGE}" -o "${IMAGES_DIR}/postgres.tar"

echo ""
echo "[5/6] Creating deployment bundle..."
rm -rf "$DEPLOY_DIR"
mkdir -p "$DEPLOY_DIR/images" "$DEPLOY_DIR/certs" "$DEPLOY_DIR/agents"

mv "${IMAGES_DIR}/sms-server.tar" "$DEPLOY_DIR/images/"
mv "${IMAGES_DIR}/postgres.tar" "$DEPLOY_DIR/images/"
rmdir "$IMAGES_DIR"

cp docker-compose.prod.yml "$DEPLOY_DIR/docker-compose.yml"
cp .env.example "$DEPLOY_DIR/.env.example"
cp scripts/server-deploy.sh "$DEPLOY_DIR/deploy.sh"
chmod +x "$DEPLOY_DIR/deploy.sh"

cp bin/sms-agent-linux-amd64 "$DEPLOY_DIR/agents/"
cp bin/sms-agent-linux-arm64 "$DEPLOY_DIR/agents/"
cp bin/sms-agent-windows-amd64.exe "$DEPLOY_DIR/agents/"
cp scripts/install-agent.sh "$DEPLOY_DIR/agents/"
cp scripts/install-agent.ps1 "$DEPLOY_DIR/agents/"
cp agent/config.example.yaml "$DEPLOY_DIR/agents/config.example.yaml"

if [ -f certs/server.crt ] && [ -f certs/server.key ]; then
    cp certs/server.crt certs/server.key "$DEPLOY_DIR/certs/"
    echo "  Included server TLS certificate files."
else
    echo "  Warning: server TLS certificate files not found in certs/."
fi

if [ -f certs/ca.crt ]; then
    cp certs/ca.crt "$DEPLOY_DIR/certs/"
    cp certs/ca.crt "$DEPLOY_DIR/agents/ca.crt"
    echo "  Included CA certificate for agent bootstrap."
else
    echo "  Warning: CA certificate not found in certs/."
fi

{
    echo "# SHA256 checksums"
    cd "$DEPLOY_DIR"
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum images/*.tar agents/* .env.example docker-compose.yml deploy.sh
    else
        shasum -a 256 images/*.tar agents/* .env.example docker-compose.yml deploy.sh
    fi
} > "$DEPLOY_DIR/SHA256SUMS"

echo ""
echo "[6/6] Compressing deployment bundle..."
tar -czf "$DEPLOY_ARCHIVE" "$DEPLOY_DIR/"
rm -rf "$DEPLOY_DIR"

ARCHIVE_SIZE="$(du -sh "$DEPLOY_ARCHIVE" | cut -f1)"

echo ""
echo "Bundle ready:"
echo "  Archive: $DEPLOY_ARCHIVE"
echo "  Size:    $ARCHIVE_SIZE"
echo ""
echo "Next steps:"
echo "  1. Copy $DEPLOY_ARCHIVE to the target server."
echo "  2. Extract it and run deploy.sh inside sms-deploy/."
echo "  3. Use files from sms-deploy/agents/ to install Linux or Windows agents."
