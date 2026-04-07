#!/bin/bash
set -euo pipefail

CERTS_DIR="${CERTS_DIR:-certs}"
SERVER_CN="${SERVER_CN:-new-test.test.pl}"
SERVER_DNS="${SERVER_DNS:-new-test.test.pl}"
SERVER_IPS="${SERVER_IPS:-192.168.100.80}"

mkdir -p "$CERTS_DIR"

server_ext_file="$CERTS_DIR/server.ext"
server_alt_names=()
dns_index=1
ip_index=1

IFS=',' read -r -a dns_values <<< "$SERVER_DNS"
for dns in "${dns_values[@]}"; do
    dns="$(echo "$dns" | xargs)"
    if [ -n "$dns" ]; then
        server_alt_names+=("DNS.${dns_index} = ${dns}")
        dns_index=$((dns_index + 1))
    fi
done

IFS=',' read -r -a ip_values <<< "$SERVER_IPS"
for ip in "${ip_values[@]}"; do
    ip="$(echo "$ip" | xargs)"
    if [ -n "$ip" ]; then
        server_alt_names+=("IP.${ip_index} = ${ip}")
        ip_index=$((ip_index + 1))
    fi
done

cat > "$server_ext_file" <<EOF
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
$(printf '%s\n' "${server_alt_names[@]}")
EOF

echo "[*] Generating CA..."
openssl genrsa -out "$CERTS_DIR/ca.key" 4096 2>/dev/null
openssl req -new -x509 -days 3650 \
    -key "$CERTS_DIR/ca.key" \
    -out "$CERTS_DIR/ca.crt" \
    -subj "/C=PL/O=SMS CA/CN=SMS Root CA" 2>/dev/null

echo "[*] Generating server certificate..."
openssl genrsa -out "$CERTS_DIR/server.key" 2048 2>/dev/null
openssl req -new \
    -key "$CERTS_DIR/server.key" \
    -out "$CERTS_DIR/server.csr" \
    -subj "/C=PL/O=SMS/CN=${SERVER_CN}" 2>/dev/null
openssl x509 -req -days 825 \
    -in "$CERTS_DIR/server.csr" \
    -CA "$CERTS_DIR/ca.crt" \
    -CAkey "$CERTS_DIR/ca.key" \
    -CAcreateserial \
    -extfile "$server_ext_file" \
    -out "$CERTS_DIR/server.crt" 2>/dev/null

rm -f "$CERTS_DIR/server.csr" "$CERTS_DIR/ca.srl" "$server_ext_file"

echo ""
echo "Certificates created:"
echo "  CA private key:      $CERTS_DIR/ca.key"
echo "  CA certificate:      $CERTS_DIR/ca.crt"
echo "  Server private key:  $CERTS_DIR/server.key"
echo "  Server certificate:  $CERTS_DIR/server.crt"
echo ""
echo "Use the per-agent script for client certificates:"
echo "  AGENT_ID=<uuid> bash scripts/gen-agent-cert.sh"
