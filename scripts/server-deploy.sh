#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy.sh — uruchom na serwerze docelowym Linux
# Ładuje obrazy Docker i uruchamia stack SMS.
#
# Użycie:
#   tar xzf sms-deploy-*.tar.gz
#   cd sms-deploy
#   cp .env.example .env
#   nano .env             # <- uzupełnij POSTGRES_PASSWORD, JWT_SECRET, DB_ENCRYPTION_KEY
#   bash deploy.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "════════════════════════════════════════════"
echo " SMS Deployment"
echo " $(date)"
echo "════════════════════════════════════════════"

# ─── Sprawdź wymagania ───────────────────────────────────────────────────────
command -v docker >/dev/null            || { echo "BŁĄD: docker nie znaleziony"; exit 1; }
(docker compose version &>/dev/null || docker-compose version &>/dev/null) || \
    { echo "BŁĄD: docker compose nie znaleziony"; exit 1; }

# Komenda compose (nowy plugin vs stary standalone)
if docker compose version &>/dev/null 2>&1; then
    COMPOSE="docker compose"
else
    COMPOSE="docker-compose"
fi

# ─── 1. Sprawdź .env ─────────────────────────────────────────────────────────
if [ ! -f .env ]; then
    echo ""
    echo "BŁĄD: Brak pliku .env !"
    echo "      cp .env.example .env && nano .env"
    exit 1
fi

# Ostrzeżenie o domyślnych wartościach
if grep -q "ZMIEN_TO" .env || grep -q "0000000000000000000000000000000000000000000000000000000000000001" .env; then
    echo ""
    echo "┌─────────────────────────────────────────────────────┐"
    echo "│ OSTRZEŻENIE: Wykryto domyślne/niezabezpieczone      │"
    echo "│ wartości w .env — ZMIEŃ je przed wdrożeniem!        │"
    echo "│                                                     │"
    echo "│ Wymagane zmiany:                                    │"
    echo "│  - POSTGRES_PASSWORD                                │"
    echo "│  - JWT_SECRET                                       │"
    echo "│  - DB_ENCRYPTION_KEY                                │"
    echo "└─────────────────────────────────────────────────────┘"
    echo ""
    read -rp "Kontynuować mimo to? [y/N]: " CONFIRM
    [[ "$CONFIRM" =~ ^[yY]$ ]] || { echo "Przerwano."; exit 1; }
fi

# ─── 2. Weryfikacja checksums ─────────────────────────────────────────────────
echo ""
echo "[1/5] Weryfikacja integralności obrazów..."
if [ -f SHA256SUMS ]; then
    if command -v sha256sum &>/dev/null; then
        sha256sum -c SHA256SUMS --quiet && echo "      OK: sumy kontrolne zgodne."
    elif command -v shasum &>/dev/null; then
        shasum -a 256 -c SHA256SUMS --quiet && echo "      OK: sumy kontrolne zgodne."
    else
        echo "      POMIŃ: sha256sum niedostępny."
    fi
else
    echo "      POMIŃ: brak pliku SHA256SUMS."
fi

# ─── 3. Załaduj obrazy Docker ────────────────────────────────────────────────
echo ""
echo "[2/5] Ładowanie obrazów Docker..."

load_image() {
    local file="$1"
    if [ -f "$file" ]; then
        echo "      Ładuję: $(basename "$file") ..."
        docker load -i "$file"
    else
        echo "      BŁĄD: Brak pliku $file"
        exit 1
    fi
}

load_image "images/sms-server.tar"
load_image "images/postgres.tar"

echo "      Obrazy załadowane."
docker images | grep -E "sms-server|postgres" | head -5

# ─── 4. Certyfikaty ──────────────────────────────────────────────────────────
echo ""
echo "[3/5] Sprawdzanie certyfikatów TLS..."

HAVE_CERTS=false
if [ -f "certs/server.crt" ] && [ -f "certs/server.key" ]; then
    HAVE_CERTS=true
    echo "      Certyfikaty znalezione: certs/server.crt"
    # Pokaż informacje o certyfikacie
    EXPIRY=$(openssl x509 -in certs/server.crt -noout -enddate 2>/dev/null | cut -d= -f2 || echo "nieznany")
    echo "      Ważny do: $EXPIRY"
else
    echo "      UWAGA: Brak certyfikatów w certs/"
    echo "      Serwer uruchomi się w trybie HTTP (bez TLS)."
    echo "      Aby wygenerować certyfikaty self-signed:"
    echo "        openssl req -x509 -newkey rsa:4096 -keyout certs/server.key \\"
    echo "          -out certs/server.crt -days 365 -nodes \\"
    echo "          -subj '/CN=sms-server'"
    echo ""
    mkdir -p certs
fi

# ─── 5. Uruchom stack ────────────────────────────────────────────────────────
echo ""
echo "[4/5] Uruchamianie stack SMS..."

# Zatrzymaj stary stack jeśli działa
$COMPOSE -f docker-compose.yml down --remove-orphans 2>/dev/null || true

# Uruchom
$COMPOSE -f docker-compose.yml --env-file .env up -d

echo ""
echo "[5/5] Sprawdzanie stanu kontenerów..."
sleep 5
$COMPOSE -f docker-compose.yml ps

# ─── Health check ────────────────────────────────────────────────────────────
echo ""
echo "Czekam na gotowość serwera..."
PORT=$(grep SERVER_PORT .env 2>/dev/null | cut -d= -f2 | tr -d ' ' || echo "8443")
PROTOCOL="http"
[ "$HAVE_CERTS" = "true" ] && PROTOCOL="https"

for i in $(seq 1 12); do
    if curl -sf -k "${PROTOCOL}://localhost:${PORT}/health" &>/dev/null; then
        echo ""
        echo "════════════════════════════════════════════"
        echo " SERWER GOTOWY!"
        echo ""
        echo " Dashboard:  ${PROTOCOL}://$(hostname -I | awk '{print $1}'):${PORT}"
        echo " Health:     ${PROTOCOL}://localhost:${PORT}/health"
        echo " Login:      admin / admin  (ZMIEŃ HASŁO!)"
        echo ""
        echo " Logi:       $COMPOSE -f docker-compose.yml logs -f server"
        echo " Status:     $COMPOSE -f docker-compose.yml ps"
        echo " Zatrzymaj:  $COMPOSE -f docker-compose.yml down"
        echo "════════════════════════════════════════════"
        exit 0
    fi
    echo "  Próba $i/12 — czekam 5s..."
    sleep 5
done

echo ""
echo "UWAGA: Serwer nie odpowiada w ciągu 60s."
echo "Sprawdź logi: $COMPOSE -f docker-compose.yml logs server"
$COMPOSE -f docker-compose.yml logs --tail=30 server
exit 1
