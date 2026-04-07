#!/bin/bash
# SMS Agent installer for Linux
# Usage: SERVER_URL=https://server:8443 TOKEN=<token> bash install-agent.sh
set -e

SERVER_URL="${SERVER_URL:-https://localhost:8443}"
TOKEN="${TOKEN:-}"
INSTALL_DIR="${INSTALL_DIR:-/opt/sms-agent}"
CONFIG_DIR="${CONFIG_DIR:-/etc/sms-agent}"
DATA_DIR="${DATA_DIR:-/var/lib/sms-agent}"
SERVICE_USER="${SERVICE_USER:-sms-agent}"
AGENT_BINARY="${AGENT_BINARY:-sms-agent-linux-amd64}"
SYSTEMD_SERVICE="sms-agent"

if [ -z "$TOKEN" ]; then
  echo "ERROR: TOKEN environment variable required"
  echo "Usage: SERVER_URL=https://server:8443 TOKEN=<registration-token> bash install-agent.sh"
  exit 1
fi

echo "[*] Installing SMS Agent..."

# Create user
if ! id "$SERVICE_USER" &>/dev/null; then
  useradd -r -s /bin/false -d "$INSTALL_DIR" "$SERVICE_USER"
  echo "    Created user: $SERVICE_USER"
fi

# Create directories
mkdir -p "$INSTALL_DIR" "$CONFIG_DIR" "$DATA_DIR"
chown "$SERVICE_USER:$SERVICE_USER" "$DATA_DIR"

# Download binary (from server or local file)
if [ -f "./$AGENT_BINARY" ]; then
  echo "[*] Using local binary: $AGENT_BINARY"
  cp "./$AGENT_BINARY" "$INSTALL_DIR/sms-agent"
else
  echo "[*] Downloading agent binary..."
  curl -fsSL --insecure "$SERVER_URL/api/packages/latest/agent-linux" -o "$INSTALL_DIR/sms-agent"
fi
chmod +x "$INSTALL_DIR/sms-agent"

# Write config
cat > "$CONFIG_DIR/config.yaml" <<CONFIG
server:
  url: "${SERVER_URL}"
  ca_cert: "${CONFIG_DIR}/ca.crt"
  client_cert: "${CONFIG_DIR}/agent.crt"
  client_key: "${CONFIG_DIR}/agent.key"

agent:
  registration_token: "${TOKEN}"
  poll_interval_seconds: 60
  command_timeout_seconds: 1800
  buffer_db: "${DATA_DIR}/buffer.db"
  service_name: "${SYSTEMD_SERVICE}"
  log_file: "/var/log/sms-agent.log"
  log_level: "info"
  health_port: 9100
  version: "1.0.0"
CONFIG

chown root:root "$CONFIG_DIR/config.yaml"
chmod 600 "$CONFIG_DIR/config.yaml"
echo "    Config written: $CONFIG_DIR/config.yaml"

# Download CA certificate
if [ -f "./ca.crt" ]; then
  cp "./ca.crt" "$CONFIG_DIR/ca.crt"
  echo "    Using local CA certificate"
else
  echo "[*] Downloading CA certificate..."
  curl -fsSL --insecure "$SERVER_URL/api/ca.crt" -o "$CONFIG_DIR/ca.crt" 2>/dev/null || \
    echo "    WARNING: Could not download CA cert. Copy certs/ca.crt to $CONFIG_DIR/ca.crt manually."
fi

# Generate agent certificate (or copy pre-generated)
if [ -f "./agent.crt" ] && [ -f "./agent.key" ]; then
  cp ./agent.crt "$CONFIG_DIR/agent.crt"
  cp ./agent.key "$CONFIG_DIR/agent.key"
  chmod 600 "$CONFIG_DIR/agent.key"
  echo "    Agent certificates installed"
else
  echo "    WARNING: No agent certificates found."
  echo "    Generate them on the server with: AGENT_ID=<id> ./scripts/gen-agent-cert.sh"
  echo "    Then copy agent.crt and agent.key to $CONFIG_DIR/"
fi

# Create systemd service
cat > "/etc/systemd/system/${SYSTEMD_SERVICE}.service" <<SERVICE
[Unit]
Description=SMS Server Management Agent
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Type=simple
User=${SERVICE_USER}
ExecStart=${INSTALL_DIR}/sms-agent -config ${CONFIG_DIR}/config.yaml
Restart=on-failure
RestartSec=10
TimeoutStartSec=30
TimeoutStopSec=30

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${DATA_DIR} /var/log
CapabilityBoundingSet=

[Install]
WantedBy=multi-user.target
SERVICE

systemctl daemon-reload
systemctl enable "$SYSTEMD_SERVICE"
systemctl start "$SYSTEMD_SERVICE"

echo ""
echo "[*] SMS Agent installed successfully!"
echo "    Status: systemctl status $SYSTEMD_SERVICE"
echo "    Logs:   journalctl -u $SYSTEMD_SERVICE -f"
echo "    Health: curl http://localhost:9100/health"
