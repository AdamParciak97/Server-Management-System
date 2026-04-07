# SMS Quickstart Commands

Ten plik zawiera gotowe komendy do:
- zbudowania release,
- wrzucenia serwera na Linux,
- wygenerowania certyfikatu agenta,
- instalacji agenta Linux lub Windows.

Podmien tylko:
- `CENTRAL_HOST`
- `LINUX_AGENT`
- `AGENT_ID`
- `TOKEN`
- `user`

## 1. Build na Windows

```powershell
cd D:\cursor\kursor-projekty\new-glpi

powershell -ExecutionPolicy Bypass -File scripts\gen-certs.ps1
powershell -ExecutionPolicy Bypass -File scripts\build-image.ps1
```

Po tym masz:

- archiwum serwera: `sms-deploy-YYYYMMDD_HHMM.tar.gz`
- certyfikaty serwera: `certs\server.crt`, `certs\server.key`, `certs\ca.crt`
- binarki agentow: `bin\sms-agent-linux-amd64`, `bin\sms-agent-linux-arm64`, `bin\sms-agent-windows-amd64.exe`

## 2. Przerzut serwera centralnego na Linux

Z Windows:

```powershell
scp .\sms-deploy-YYYYMMDD_HHMM.tar.gz user@CENTRAL_HOST:/opt/
```

Na serwerze centralnym Linux:

```bash
cd /opt
tar xzf sms-deploy-YYYYMMDD_HHMM.tar.gz
cd sms-deploy
cp .env.example .env
nano .env
```

W `.env` ustaw:

- `POSTGRES_PASSWORD`
- `JWT_SECRET`
- `DB_ENCRYPTION_KEY`

Jesli trzeba recznie dograc certyfikaty, do `/opt/sms-deploy/certs/` wrzucasz:

- `server.crt`
- `server.key`
- `ca.crt`

Start:

```bash
cd /opt/sms-deploy
bash deploy.sh
```

## 3. Logowanie i token rejestracyjny

W przegladarce:

- wejdz na `https://CENTRAL_HOST:8443`
- zaloguj sie `admin / admin`
- zmien haslo
- `Settings` -> `Registration Tokens` -> `Generate Token`
- skopiuj `TOKEN`

## 4. Generowanie certyfikatu konkretnego agenta

Na Windows:

```powershell
cd D:\cursor\kursor-projekty\new-glpi
powershell -ExecutionPolicy Bypass -File scripts\gen-agent-cert.ps1 `
  -AgentId "AGENT_ID" `
  -AgentCN "agent-host.test.pl" `
  -AgentDns @("agent-host.test.pl","agent-host") `
  -AgentIps @("192.168.100.101")
```

Powstana:

- `certs\agents\AGENT_ID.crt`
- `certs\agents\AGENT_ID.key`

Na host agenta kopiujesz je pod nazwami:

- `agent.crt`
- `agent.key`

Dodatkowo kopiujesz:

- `certs\ca.crt` jako `ca.crt`

## 5. Linux agent: co kopiujesz

Na host Linux do `/root/sms-agent/` wrzucasz:

- `scripts/install-agent.sh`
- `bin/sms-agent-linux-amd64` albo `bin/sms-agent-linux-arm64`
- `certs/ca.crt` jako `ca.crt`
- `certs/agents/AGENT_ID.crt` jako `agent.crt`
- `certs/agents/AGENT_ID.key` jako `agent.key`

Przyklad z Windows:

```powershell
scp .\scripts\install-agent.sh .\bin\sms-agent-linux-amd64 .\certs\ca.crt .\certs\agents\AGENT_ID.crt .\certs\agents\AGENT_ID.key root@LINUX_AGENT:/root/sms-agent/
```

Na hoście Linux:

```bash
cd /root/sms-agent
mv AGENT_ID.crt agent.crt
mv AGENT_ID.key agent.key
chmod +x install-agent.sh sms-agent-linux-amd64
SERVER_URL=https://CENTRAL_HOST:8443 TOKEN=TOKEN bash install-agent.sh
```

Sprawdzenie:

```bash
systemctl status sms-agent
curl http://127.0.0.1:9100/health
```

## 6. Windows agent: co kopiujesz

Na host Windows do `C:\Temp\sms-agent\` wrzucasz:

- `scripts\install-agent.ps1`
- `bin\sms-agent-windows-amd64.exe`
- `certs\ca.crt` jako `ca.crt`
- `certs\agents\AGENT_ID.crt` jako `agent.crt`
- `certs\agents\AGENT_ID.key` jako `agent.key`

Na hoście Windows, PowerShell jako Administrator:

```powershell
cd C:\Temp\sms-agent
Set-ExecutionPolicy Bypass -Scope Process -Force
Rename-Item .\AGENT_ID.crt agent.crt
Rename-Item .\AGENT_ID.key agent.key
.\install-agent.ps1 -ServerURL https://CENTRAL_HOST:8443 -Token TOKEN
```

Sprawdzenie:

```powershell
Get-Service SMSAgent
Invoke-WebRequest http://127.0.0.1:9100/health
```

## 7. Gdzie jaki plik lezy finalnie

Serwer centralny:

- `/opt/sms-deploy/certs/server.crt`
- `/opt/sms-deploy/certs/server.key`
- `/opt/sms-deploy/certs/ca.crt`

Host agenta Linux/Windows:

- `ca.crt`
- `agent.crt`
- `agent.key`

Tylko na maszynie buildowej/CA:

- `ca.key`
