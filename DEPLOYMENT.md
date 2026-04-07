# SMS Deployment Guide

Ten plik opisuje dokladnie:
- jak zbudowac release,
- co skopiowac na serwer,
- co wrzucic do dashboardu,
- jak zainstalowac agenta na Linux i Windows.

## 1. Co powstaje po buildzie

Uruchom na maszynie buildowej:

Linux/macOS:

```bash
bash scripts/gen-certs.sh
bash scripts/build-image.sh
```

Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\gen-certs.ps1
powershell -ExecutionPolicy Bypass -File scripts\build-image.ps1
```

Po poprawnym buildzie dostajesz:

- archiwum release, np. `sms-deploy-20260330_1102.tar.gz`
- binarki agentow w `bin/`
- gotowy bundle do wdrozenia zawarty w archiwum

## 2. Co gdzie wrzucic

### 2.1. Na serwer centralny Linux

Na docelowy serwer centralny wrzucasz:

- `sms-deploy-YYYYMMDD_HHMM.tar.gz` do katalogu np. `/opt/`

Po rozpakowaniu masz katalog `sms-deploy/`, a w nim:

- `docker-compose.yml`
- `.env.example`
- `deploy.sh`
- `images/sms-server.tar`
- `images/postgres.tar`
- `certs/`
- `agents/`

### 2.2. Do katalogu `sms-deploy/certs/`

W tym katalogu musza byc pliki TLS serwera:

- `server.crt`
- `server.key`
- `ca.crt`

Jesli zbudowales release po wygenerowaniu certyfikatow, te pliki beda juz w archiwum.
Jesli nie, skopiuj je recznie do `sms-deploy/certs/` przed uruchomieniem `deploy.sh`.

### 2.2.1. Dokladnie ktory certyfikat gdzie ma byc

Na maszynie CA / buildowej zostaja:

- `certs/ca.key`
- `certs/ca.crt`
- `certs/server.key`
- `certs/server.crt`
- `certs/agents/<AGENT_ID>.key`
- `certs/agents/<AGENT_ID>.crt`

Na serwer centralny Linux trafia tylko:

- `sms-deploy/certs/server.crt`
- `sms-deploy/certs/server.key`
- `sms-deploy/certs/ca.crt`

Na host agenta Linux lub Windows trafia tylko:

- `ca.crt`
- `agent.crt`
- `agent.key`

Nigdy nie kopiuj na host agenta:

- `ca.key`
- `server.key`
- `server.crt`

Nigdy nie kopiuj na serwer centralny:

- `certs/agents/<AGENT_ID>.key`
- `certs/agents/<AGENT_ID>.crt`

### 2.3. Do dashboardu Packages

Jesli chcesz, aby instalatory agentow mogly pobierac binarke bezposrednio z serwera,
musisz zaladowac do dashboardu 3 paczki z katalogu `sms-deploy/agents/` albo `bin/`:

1. `sms-agent-linux-amd64`
2. `sms-agent-linux-arm64`
3. `sms-agent-windows-amd64.exe`

Upload robisz w dashboardzie:

- zaloguj sie
- przejdz do `Packages`
- kliknij `Upload Package`

Dla kazdego pliku ustaw:

1. Linux amd64
   - `Name`: `sms-agent`
   - `Version`: `1.0.0`
   - `OS Target`: `linux`
   - `Arch Target`: `amd64`
   - `File`: `sms-agent-linux-amd64`

2. Linux arm64
   - `Name`: `sms-agent`
   - `Version`: `1.0.0`
   - `OS Target`: `linux`
   - `Arch Target`: `arm64`
   - `File`: `sms-agent-linux-arm64`

3. Windows amd64
   - `Name`: `sms-agent`
   - `Version`: `1.0.0`
   - `OS Target`: `windows`
   - `Arch Target`: `amd64`
   - `File`: `sms-agent-windows-amd64.exe`

Bez tego endpointy:

- `/api/packages/latest/agent-linux`
- `/api/packages/latest/agent-linux-arm64`
- `/api/packages/latest/agent-windows`

nie beda mialy czego zwracac.

### 2.4. Na host zarzadzany z Linux

Na serwer Linux, na ktorym instalujesz agenta, wrzucasz do jednego katalogu roboczego:

- `install-agent.sh`
- `sms-agent-linux-amd64` albo `sms-agent-linux-arm64`
- `ca.crt`
- `agent.crt`
- `agent.key`

### 2.5. Na host zarzadzany z Windows

Na host Windows wrzucasz do jednego katalogu roboczego:

- `install-agent.ps1`
- `sms-agent-windows-amd64.exe`
- `ca.crt`
- `agent.crt`
- `agent.key`

## 3. Wdrozenie serwera centralnego krok po kroku

Na serwerze centralnym Linux:

```bash
cd /opt
tar xzf sms-deploy-YYYYMMDD_HHMM.tar.gz
cd sms-deploy
cp .env.example .env
```

Edytuj `.env` i ustaw minimum:

- `POSTGRES_PASSWORD`
- `JWT_SECRET`
- `DB_ENCRYPTION_KEY`

Jesli w `certs/` nie ma jeszcze certyfikatow, skopiuj tam:

- `server.crt`
- `server.key`
- `ca.crt`

Uruchom:

```bash
bash deploy.sh
```

Po starcie:

- otworz dashboard
- zaloguj sie `admin / admin`
- natychmiast zmien haslo admina

## 4. Przygotowanie tokenu rejestracyjnego

W dashboardzie:

- przejdz do `Settings`
- sekcja `Registration Tokens`
- kliknij `Generate Token`

Zapisz token. Bedzie potrzebny przy instalacji agenta.

## 5. Przygotowanie certyfikatu dla kazdego agenta

Instalator agenta zaklada, ze obok niego beda pliki:

- `agent.crt`
- `agent.key`
- `ca.crt`

Dla kazdego hosta wygeneruj osobny certyfikat agenta.

Najpierw wygeneruj zestaw CA + certyfikat serwera:

Linux/macOS:

```bash
bash scripts/gen-certs.sh
```

Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\gen-certs.ps1
```

Na maszynie, na ktorej masz `ca.crt` i `ca.key`, wygeneruj certyfikat konkretnego agenta:

```bash
AGENT_ID=srv-app-01 \
AGENT_CN=srv-app-01.test.pl \
AGENT_DNS=srv-app-01.test.pl,srv-app-01 \
AGENT_IPS=192.168.100.101 \
bash scripts/gen-agent-cert.sh
```

albo:

```bash
AGENT_ID=twoj-unikalny-uuid \
AGENT_CN=twoj-host.test.pl \
AGENT_DNS=twoj-host.test.pl \
AGENT_IPS=192.168.100.101 \
bash scripts/gen-agent-cert.sh
```

PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\gen-agent-cert.ps1 `
  -AgentId "srv-app-01" `
  -AgentCN "srv-app-01.test.pl" `
  -AgentDns @("srv-app-01.test.pl","srv-app-01") `
  -AgentIps @("192.168.100.101")
```

Powstana pliki:

- `certs/agents/<AGENT_ID>.crt`
- `certs/agents/<AGENT_ID>.key`

Przed instalacja skopiuj je na host docelowy pod nazwami:

- `agent.crt`
- `agent.key`

oraz dolacz `ca.crt`.

Mapowanie nazw jest takie:

- `certs/agents/<AGENT_ID>.crt` -> kopiujesz jako `agent.crt`
- `certs/agents/<AGENT_ID>.key` -> kopiujesz jako `agent.key`
- `certs/ca.crt` -> kopiujesz jako `ca.crt`

Mozesz podawac dla agenta:

- `AGENT_CN` / `-AgentCN` - Common Name
- `AGENT_DNS` / `-AgentDns` - lista nazw DNS do SAN
- `AGENT_IPS` / `-AgentIps` - lista adresow IP do SAN

## 6. Instalacja agenta na Linux

### Wariant A: instalacja z lokalnej binarki

Na host Linux skopiuj z `sms-deploy/agents/`:

- `install-agent.sh`
- odpowiednia binarke
- `ca.crt`

oraz dograj:

- `agent.crt`
- `agent.key`

Nastepnie uruchom:

amd64:

```bash
chmod +x install-agent.sh sms-agent-linux-amd64
SERVER_URL=https://twoj-serwer:8443 TOKEN=<TOKEN> bash install-agent.sh
```

arm64:

```bash
chmod +x install-agent.sh sms-agent-linux-arm64
SERVER_URL=https://twoj-serwer:8443 TOKEN=<TOKEN> AGENT_BINARY=sms-agent-linux-arm64 bash install-agent.sh
```

### Wariant B: instalacja przez pobranie binarki z serwera

Ten wariant dziala tylko wtedy, gdy wgrales paczki do `Packages`.

Na host Linux skopiuj:

- `install-agent.sh`
- `agent.crt`
- `agent.key`
- opcjonalnie `ca.crt`

Uruchom:

```bash
chmod +x install-agent.sh
SERVER_URL=https://twoj-serwer:8443 TOKEN=<TOKEN> bash install-agent.sh
```

Skrypt pobierze binarke z:

- `/api/packages/latest/agent-linux`

## 7. Instalacja agenta na Windows

### Wariant A: instalacja z lokalnej binarki

Na host Windows skopiuj:

- `install-agent.ps1`
- `sms-agent-windows-amd64.exe`
- `ca.crt`
- `agent.crt`
- `agent.key`

Uruchom PowerShell jako Administrator:

```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force
.\install-agent.ps1 -ServerURL https://twoj-serwer:8443 -Token <TOKEN>
```

### Wariant B: instalacja przez pobranie binarki z serwera

Ten wariant dziala tylko wtedy, gdy wgrales paczki do `Packages`.

Na host Windows skopiuj:

- `install-agent.ps1`
- `agent.crt`
- `agent.key`
- opcjonalnie `ca.crt`

Uruchom:

```powershell
Set-ExecutionPolicy Bypass -Scope Process -Force
.\install-agent.ps1 -ServerURL https://twoj-serwer:8443 -Token <TOKEN>
```

Skrypt pobierze binarke z:

- `/api/packages/latest/agent-windows`

## 8. Co sprawdzic po instalacji agenta

### Linux

```bash
systemctl status sms-agent
journalctl -u sms-agent -f
curl http://127.0.0.1:9100/health
```

### Windows

```powershell
Get-Service SMSAgent
Invoke-WebRequest http://127.0.0.1:9100/health
```

## 9. Najwazniejsze zasady

1. Serwer centralny dostaje tylko archiwum `sms-deploy-*.tar.gz`.
2. Certyfikaty serwera musza trafic do `sms-deploy/certs/`.
3. Paczki agentow wrzucasz do dashboardu `Packages` tylko wtedy, gdy chcesz pobierac binarki z serwera.
4. Na host agenta zawsze musisz dostarczyc `agent.crt` i `agent.key`, bo konfiguracja instalatora ich oczekuje.
5. `ca.crt` powinien byc:
   - w `sms-deploy/certs/` na serwerze centralnym
   - obok instalatora agenta albo dostepny przez `/api/ca.crt`

## 10. Minimalny, dzialajacy scenariusz

Jesli chcesz po prostu uruchomic calosc najszybciej:

1. Wygeneruj certyfikaty.
2. Zbuduj release.
3. Skopiuj `sms-deploy-*.tar.gz` na serwer centralny.
4. Rozpakuj, ustaw `.env`, sprawdz `certs/`, uruchom `deploy.sh`.
5. Zaloguj sie do dashboardu.
6. Wgraj 3 paczki agentow do `Packages`.
7. Wygeneruj token rejestracyjny.
8. Wygeneruj certyfikat dla konkretnego agenta.
9. Skopiuj na host agenta instalator + binarke + `ca.crt` + `agent.crt` + `agent.key`.
10. Uruchom instalator.
