#!/bin/bash
set -euo pipefail

CERTS_DIR="${CERTS_DIR:-certs}"
AGENT_ID="${AGENT_ID:-$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid)}"
AGENT_CN="${AGENT_CN:-agent-$AGENT_ID}"
AGENT_DNS="${AGENT_DNS:-}"
AGENT_IPS="${AGENT_IPS:-}"
AGENT_DIR="$CERTS_DIR/agents"
AGENT_EXT="$AGENT_DIR/$AGENT_ID.ext"

mkdir -p "$AGENT_DIR"

if [ ! -f "$CERTS_DIR/ca.crt" ] || [ ! -f "$CERTS_DIR/ca.key" ]; then
    echo "ERROR: missing $CERTS_DIR/ca.crt or $CERTS_DIR/ca.key"
    echo "Run bash scripts/gen-certs.sh first."
    exit 1
fi

{
    echo "basicConstraints = CA:FALSE"
    echo "keyUsage = digitalSignature, keyEncipherment"
    echo "extendedKeyUsage = clientAuth"
    if [ -n "$AGENT_DNS" ] || [ -n "$AGENT_IPS" ]; then
        echo "subjectAltName = @alt_names"
        echo ""
        echo "[alt_names]"

        dns_index=1
        IFS=',' read -r -a dns_values <<< "$AGENT_DNS"
        for dns in "${dns_values[@]}"; do
            dns="$(echo "$dns" | xargs)"
            if [ -n "$dns" ]; then
                echo "DNS.${dns_index} = ${dns}"
                dns_index=$((dns_index + 1))
            fi
        done

        ip_index=1
        IFS=',' read -r -a ip_values <<< "$AGENT_IPS"
        for ip in "${ip_values[@]}"; do
            ip="$(echo "$ip" | xargs)"
            if [ -n "$ip" ]; then
                echo "IP.${ip_index} = ${ip}"
                ip_index=$((ip_index + 1))
            fi
        done
    fi
} > "$AGENT_EXT"

echo "[*] Generating client certificate for agent: $AGENT_ID"
openssl genrsa -out "$AGENT_DIR/$AGENT_ID.key" 2048 2>/dev/null
openssl req -new \
    -key "$AGENT_DIR/$AGENT_ID.key" \
    -out "$AGENT_DIR/$AGENT_ID.csr" \
    -subj "/C=PL/O=SMS/CN=$AGENT_CN" 2>/dev/null
openssl x509 -req -days 825 \
    -in "$AGENT_DIR/$AGENT_ID.csr" \
    -CA "$CERTS_DIR/ca.crt" \
    -CAkey "$CERTS_DIR/ca.key" \
    -CAcreateserial \
    -extfile "$AGENT_EXT" \
    -out "$AGENT_DIR/$AGENT_ID.crt" 2>/dev/null

rm -f "$AGENT_DIR/$AGENT_ID.csr" "$AGENT_EXT" "$CERTS_DIR/ca.srl"

echo "Generated files:"
echo "  Certificate: $AGENT_DIR/$AGENT_ID.crt"
echo "  Private key: $AGENT_DIR/$AGENT_ID.key"
if [ -n "$AGENT_DNS" ]; then
    echo "  DNS SANs:    $AGENT_DNS"
fi
if [ -n "$AGENT_IPS" ]; then
    echo "  IP SANs:     $AGENT_IPS"
fi
echo ""
echo "Copy them to the target host as:"
echo "  agent.crt"
echo "  agent.key"
