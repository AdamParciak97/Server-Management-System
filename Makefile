.PHONY: build-server build-agent-linux build-agent-windows build-all \
        build-agents-docker gen-certs docker-up docker-down docker-logs \
        run-server run-agent vendor test clean package-image package-image-win \
        load-image

# ─── Build targets ────────────────────────────────────────────────────────────

build-server:
	CGO_ENABLED=0 go build -ldflags="-s -w" -o bin/sms-server ./server/

build-agent-linux:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" \
		-o bin/sms-agent-linux-amd64 ./agent/
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" \
		-o bin/sms-agent-linux-arm64 ./agent/

build-agent-windows:
	CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -ldflags="-s -w" \
		-o bin/sms-agent-windows-amd64.exe ./agent/

build-all: build-server build-agent-linux build-agent-windows

build-agents-docker:
	bash scripts/build-agents.sh

# ─── Vendoring ─────────────────────────────────────────────────────────────────

vendor:
	go mod tidy
	go mod vendor

# ─── Certificates ─────────────────────────────────────────────────────────────

gen-certs:
	mkdir -p certs
	bash scripts/gen-certs.sh

# ─── Docker ───────────────────────────────────────────────────────────────────

docker-up:
	docker-compose up -d --build

docker-down:
	docker-compose down

docker-logs:
	docker-compose logs -f server

# ─── Dev: run locally without docker ──────────────────────────────────────────

run-server:
	DATABASE_URL="postgres://sms:sms@localhost:5432/sms?sslmode=disable" \
	JWT_SECRET="dev-secret-key" \
	DB_ENCRYPTION_KEY="0000000000000000000000000000000000000000000000000000000000000001" \
	MIGRATIONS_DIR="file://server/migrations" \
	SERVER_ADDR=":8080" \
	go run ./server/

run-agent:
	go run ./agent/ -config agent/config.example.yaml

# ─── Tests ────────────────────────────────────────────────────────────────────

test:
	go test ./...

# ─── Clean ────────────────────────────────────────────────────────────────────

clean:
	rm -rf bin/

# ─── Deployment (offline) ─────────────────────────────────────────────────────

## Buduje obraz + pakuje do archiwum gotowego do przeniesienia na serwer
package-image:
	bash scripts/build-image.sh

## Wersja dla Windows PowerShell
package-image-win:
	powershell -ExecutionPolicy Bypass -File scripts/build-image.ps1

## Ładuje obrazy na serwerze docelowym (po skopiowaniu archiwum)
load-image:
	docker load -i images/sms-server.tar
	docker load -i images/postgres.tar

# ─── Download Chart.js locally ────────────────────────────────────────────────

download-vendor-js:
	mkdir -p server/static/vendor
	curl -fsSL "https://cdn.jsdelivr.net/npm/chart.js@4.4.2/dist/chart.umd.min.js" \
		-o server/static/vendor/chart.min.js
	@echo "Chart.js downloaded to server/static/vendor/chart.min.js"
