# Server Management System

Centralny system do inwentaryzacji serwerów, zdalnego wykonywania komend, monitoringu zgodności i dystrybucji agentów.

Projekt składa się z trzech części:

- `agent/`: agent instalowany na hostach Linux i Windows
- `server/`: centralny serwer API w Go
- `server/static/`: webowy dashboard HTML/CSS/JS

## Najważniejsze funkcje

- rejestracja agentów z użyciem `mTLS`
- cykliczne raportowanie stanu hosta
- zdalne wykonywanie komend i odbiór wyników
- harmonogram komend i maintenance windows
- inwentaryzacja pakietów, usług, procesów i konfiguracji
- baseline, diff konfiguracji i compliance policies
- alerty, audit log i RBAC
- upload oraz publiczne pobieranie paczek agentów
- LDAP group mapping i ustawienia SMTP
- offline buffer po stronie agenta oparty o SQLite

## Stack

- Go `1.23`
- PostgreSQL `16`
- Chi router, JWT, `golang-migrate`
- dashboard bez frameworka SPA, serwowany statycznie przez backend
- Docker Compose do lokalnego uruchamiania i deployu offline

## Architektura

1. Agent zbiera dane systemowe i wysyła raport do serwera.
2. Serwer zapisuje dane w PostgreSQL, udostępnia REST API i dashboard.
3. Operator zarządza hostami, komendami, politykami i paczkami z poziomu UI.
4. Agent pobiera oczekujące komendy, wykonuje je lokalnie i odsyła wynik.

## Szybki start lokalnie

### Wymagania

- Go `1.23+`
- Docker i Docker Compose
- OpenSSL do generowania certyfikatów

### 1. Uruchom PostgreSQL i serwer

```bash
docker compose up -d --build
```

Dashboard będzie dostępny pod `https://localhost:8443`.

Jeśli certyfikaty nie istnieją, wygeneruj je wcześniej:

```bash
make gen-certs
```

Domyślne konto po pierwszym uruchomieniu:

- login: `admin`
- hasło: `admin`

Hasło trzeba zmienić od razu po zalogowaniu.

### 2. Uruchom serwer bez Dockera

```bash
make run-server
```

### 3. Zbuduj agenta

```bash
make build-agent-linux
make build-agent-windows
```

Albo przez Dockera:

```bash
make build-agents-docker
```

### 4. Zainstaluj agenta

Linux:

```bash
SERVER_URL=https://your-server:8443 TOKEN=<registration-token> bash scripts/install-agent.sh
```

Windows PowerShell uruchomiony jako Administrator:

```powershell
.\scripts\install-agent.ps1 -ServerURL https://your-server:8443 -Token <registration-token>
```

Przykładową konfigurację znajdziesz w `agent/config.example.yaml`.

## Release i deploy offline

Projekt ma przygotowany flow pod release bundle przenoszony na serwer bez budowania na miejscu.

Budowa paczki:

```bash
make package-image
```

Na Windows:

```powershell
make package-image-win
```

Wynikiem jest archiwum `sms-deploy-YYYYMMDD_HHMM.tar.gz`, które zawiera:

- obraz `sms-server`
- obraz `postgres`
- pliki `docker-compose` do deployu
- certyfikaty serwera
- binarki agentów i instalatory

Szczegóły wdrożenia są opisane w `DEPLOYMENT.md`.

## Struktura repozytorium

```text
agent/
  buffer/       lokalny bufor SQLite
  collector/    zbieranie danych systemowych
  config/       konfiguracja YAML
  executor/     wykonywanie komend
  watchdog/     watchdog procesu
server/
  alerting/     logika alertów
  api/          REST API i middleware
  db/           warstwa dostępu do danych
  migrations/   migracje PostgreSQL
  scheduler/    harmonogram zadań
  static/       dashboard
scripts/        build, certyfikaty, instalatory
shared/         współdzielone modele danych
```

## Wybrane endpointy

Publiczne:

- `GET /health`
- `GET /api/ca.crt`
- `GET /api/packages/latest/{target}`

Agent:

- `POST /api/agent/register`
- `POST /api/agent/report`
- `GET /api/agent/commands`
- `POST /api/agent/commands/result`

Operator:

- `POST /api/auth/login`
- `GET /api/servers`
- `POST /api/commands`
- `GET /api/alerts`
- `GET /api/compliance`
- `POST /api/packages/upload`

## Bezpieczeństwo

- `mTLS` dla ruchu agent-serwer
- JWT dla użytkowników dashboardu
- RBAC oparte o uprawnienia i scope'y
- audit log operacji użytkowników
- rate limiting dla API i agentów
- szyfrowanie wrażliwych danych w bazie `AES-256-GCM`

## Pliki niewrzucane do repo

Publiczne repo nie powinno zawierać wygenerowanych artefaktów i sekretów:

- `certs/`
- `bin/`
- `sms-deploy-*.tar.gz`
- lokalnych plików `.env`

## Licencja

Brak zdefiniowanej licencji. Jeśli repo ma być otwarte publicznie, warto dodać `LICENSE`.
