# Server Management System

Centralny system do inwentaryzacji serwerów, zdalnego wykonywania komend, monitoringu zgodności i dystrybucji agentów.

Projekt składa się z trzech części:

- `agent/`: agent instalowany na hostach Linux i Windows
- `server/`: centralny serwer API w Go
- `server/static/`: webowy dashboard HTML/CSS/JS

## Najważniejsze funkcje

Tokeny rejestracyjne agentów są dostępne w **Settings → Registration tokens**.
Można ustawić ważność od godziny do 30 dni, sprawdzić stan i unieważnić
niewykorzystany token. Sekret jest widoczny tylko po utworzeniu — historia
nie pozwala go ponownie odczytać. Tworzenie i unieważnianie wymaga
`tokens.write`, odczyt historii `tokens.read`. Rejestracja agenta wymaga
certyfikatu klienta; unieważnienie tokena nie odłącza już zarejestrowanego agenta.

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

## Screenshots

### 1. Dashboard overview

- główny widok z podsumowaniem infrastruktury
- liczba agentów, alertów i statusów hostów
- wykresy albo kafelki z najważniejszymi metrykami

<img width="1894" height="913" alt="image" src="https://github.com/user-attachments/assets/da3aa4f4-a2b8-4501-9b02-89f185fc30ec" />


### 2. Server inventory

- lista serwerów
- szczegóły wybranego hosta
- pakiety, usługi, procesy albo diff konfiguracji

<img width="1906" height="905" alt="image" src="https://github.com/user-attachments/assets/5ab6de71-46fa-4f6d-8e92-f22fa993155e" />


### 3. Remote commands

- tworzenie lub podgląd zdalnej komendy
- status wykonania
- log wykonania albo historię komend

<img width="1903" height="903" alt="image" src="https://github.com/user-attachments/assets/26876e80-ccb3-4952-bc87-dffcbe731be9" />


### 4. Compliance and alerts

- widok compliance policies lub exceptions
- aktywne alerty
- stan zgodności hostów z politykami

<img width="1917" height="907" alt="image" src="https://github.com/user-attachments/assets/3b55c83e-2298-4411-91c2-48e4d1a26329" />

<img width="1900" height="899" alt="image" src="https://github.com/user-attachments/assets/66ebfcb8-f151-4fd0-af9a-16a335c8aff1" />

<img width="1908" height="905" alt="image" src="https://github.com/user-attachments/assets/204fce4a-0597-461d-adfb-27f4bbc95398" />

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

## Praca z poleceniami

Widok **Commands** łączy historię, szablony, harmonogramy i okna serwisowe.
Historia i podsumowania dotyczą ostatnich 100 wpisów zwróconych przez API;
wyszukiwanie i filtry obejmują ten zestaw. Szczegóły pokazują parametry, wynik,
błąd i daty wykonania. Formularz zachowuje konfigurację przy błędzie zapisu.

Przed wysłaniem sprawdź sekcję **Operation review**: cel, skutki, timeout,
parametry i dry-run. Skrypt bez dry-run czeka na akceptację użytkownika
z `commands.approve`; dotyczy to także każdej instancji z harmonogramu.
Tworzenie nadal wymaga `commands.write` i dostępu do zakresu celu.
Wynik jest przyjmowany tylko od agenta przypisanego do wysłanego polecenia.
Wyniki cudze, ponowione oraz dla poleceń anulowanych lub zakończonych otrzymują 409.

Wynik zlecenia grupowego pokazuje liczbę rzeczywiście utworzonych poleceń.
Pełna lista nieudanych celów i idempotentne ponawianie pozostają w backlogu:
po utracie odpowiedzi sprawdź historię przed ponownym wysłaniem. Anulowanie
w panelu nie gwarantuje zatrzymania procesu już uruchomionego na agencie.
Migracja 009 obejmuje też wcześniejsze niewysłane skrypty bez akceptacji;
nie zmienia już wysłanych poleceń ani zapisanych zatwierdzeń. Cofnięcie migracji
celowo zachowuje dodany wymóg akceptacji.

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

### Biblioteka paczek

Packages pokazuje wydania, docelowy system i architekturę, rozmiar oraz pełny SHA-256.
Filtry uwzględniają paczki uniwersalne; pusty stan prowadzi do formularza uploadu.
Formularz zachowuje dane po błędzie i blokuje podwójne wysłanie. Po utracie odpowiedzi
odśwież bibliotekę przed ponowieniem: zapis mógł się udać. Pobieraniem pliku i jego
postępem zarządza przeglądarka. Sam upload nie instaluje paczki ani nie uruchamia poleceń.

`POST /api/packages/upload` wymaga `packages.write` (lub administratora) i przyjmuje
multipart: pojedynczy `file`, `name`, `version`, opcjonalnie `os_target`, `arch_target`,
`description`. Limit pliku to **500 MiB**, całego żądania **501 MiB**, opisu 4096 bajtów
UTF-8. Nazwa i wersja: 1–128 znaków ASCII, początek alfanumeryczny, dalej litery,
cyfry, `.`, `_`, `+`, `-`. Nazwa pliku: do 180 znaków ASCII, początek alfanumeryczny,
dalej te same znaki oraz spacje i nawiasy. Ścieżki w nazwach są odrzucane. Cele:
pusty (uniwersalny), `linux`/`windows`, `amd64`/`arm64`. Pola nieznane lub powtórzone,
pusty plik i uszkodzony multipart dają 400; przekroczenia limitów dają 413.
Konflikt istniejącej nazwy, wersji i celu w bazie daje 409; zachowuje dotychczasową paczkę.

Plik jest zapisywany strumieniowo z SHA-256, synchronizowany i publikowany przed
zapisem rekordu PostgreSQL. Obsłużone błędy usuwają pliki utworzone przez dane żądanie.
API zwraca `filename`, bez wewnętrznego `file_path`; Commands korzysta z tej nazwy,
zachowując rozszerzenie instalatora. Odczyt listy wymaga `packages.read`, usuwanie
`packages.write`; mutacje przechodzą przez istniejący middleware audytu.

**Paczki są publiczne** pod istniejącymi trasami `/api/packages/public/{id}` oraz
`/api/packages/latest/{target}` — służą dystrybucji instalatorów. Nie umieszczaj w nich
sekretów ani prywatnej konfiguracji. SHA-256 identyfikuje plik, nie potwierdza zaufania
do wydawcy. Download przesyła załącznik jako `application/octet-stream` z `nosniff`
i obsługą zakresów bajtów; zapisane ścieżki spoza katalogu paczek i dowiązania są odrzucane.
Katalog uploadu musi pozostawać zapisywalny tylko dla procesu serwera.

Nagłe zabicie procesu może zostawić osierocony plik; filesystem i PostgreSQL nie
tworzą wspólnej transakcji. Automatyczne uzgadnianie takich plików, kwoty magazynu,
idempotentny upload i test rzeczywistej awarii PostgreSQL pozostają do zrobienia.
Przy błędzie usuwania pliku po skasowaniu rekordu API i panel zgłaszają konieczność
sprawdzenia magazynu przez administratora. Nie usuwa się automatycznie starych danych.

### Ustawienia LDAP i SMTP

Settings zawiera osobne formularze integracji z informacją o obecności zapisanego
hasła. Hasła nie są odsyłane do przeglądarki ani wstawiane do formularza.
Domyślna akcja **Keep current credential** zachowuje hasło podczas edycji innych
pól. **Replace credential** wymaga nowego hasła (spacje są zachowywane), a
**Remove credential** wymaga potwierdzenia w formularzu. Usunięcie może zatrzymać
logowanie LDAP lub wysyłkę poczty. Informacja „Credential configured” oznacza tylko
obecność wartości w bazie; nie jest testem połączenia z usługą.

`GET /api/settings/ldap` i `/api/settings/smtp` wymagają `settings.read` i zwracają
odpowiednio `ldap_bind_password_configured` / `smtp_password_configured` jako
łańcuch `"true"` lub `"false"`, zamiast pól hasła. Odpowiedzi mają `Cache-Control:
no-store`. `PUT` na tych samych trasach wymaga `settings.write`, przyjmuje częściowy
obiekt konfiguracji i `secret_action`: `keep` (także domyślnie), `replace` lub
`clear`. `replace` wymaga niepustego `ldap_bind_password` / `smtp_password`;
pozostałe akcje odrzucają niepuste pole hasła. Pusty stary formularz hasła bez akcji
zachowuje sekret. Klienci API ustawiający hasło muszą dodać `secret_action: "replace"`.

Zapis jest transakcyjny, szyfruje nowe sekrety i nie zmienia pominiętych pól.
Nieznane pola, niewłaściwe typy i żądania powyżej 64 KiB są odrzucane. Błąd zapisu
nie zwraca sekretów ani szczegółów bazy; panel zachowuje wpisane dane do ponowienia.
Po utracie odpowiedzi zapis mógł dojść do skutku — komunikat nie obiecuje jego
wycofania. Równoległe jawne zmiany tego samego pola obowiązują w kolejności zapisów;
formularz nie ma jeszcze kontroli wersji konfiguracji.

### Konto i aktywne sesje

W **Settings → Your account & sessions** każdy użytkownik, również readonly,
może odczytać własne sesje, wylogować pozostałe i zmienić lokalne hasło.
Nie wymaga to uprawnień administracji ustawieniami. Lista pokazuje do 100
najnowszych aktywnych sesji, oznacza bieżącą oraz podaje czas utworzenia,
odświeżenia i wygaśnięcia. Opis przeglądarki pochodzi od klienta, a odświeżenie
tokenu nie jest informacją o urządzeniu online.

**Sign out other sessions** wymaga potwierdzenia i obejmuje wszystkie pozostałe
sesje, również niewidoczne na liście. Escape anuluje potwierdzenie. Zmiana hasła
wymaga dotychczasowego hasła i 8–72 bajtów nowego; unieważnia wszystkie sesje,
w tym bieżącą. Hasła LDAP zmienia się w katalogu. Po awarii zapisu formularz
pozwala ponowić próbę, a przy braku potwierdzenia wylogowania panel odróżnia
lokalne usunięcie danych logowania od cofnięcia sesji na serwerze.

API: `GET /api/account/sessions`, `POST /api/account/sessions/revoke-others`,
`POST /api/account/password` i `POST /api/auth/logout` wymagają Bearer JWT
z aktywną sesją. Operacje dotyczą wyłącznie uwierzytelnionego konta; endpointy
sesji nie przyjmują identyfikatora właściciela ani refresh tokenu. Cofnięcie
sesji działa przy następnym żądaniu; nie anuluje już autoryzowanych operacji.
Rotacja refresh tokenu jest transakcyjna i jednorazowa, bez przedłużania
siedmiodniowego terminu sesji. Błąd magazynu daje 503; nieważna sesja daje 401.

**Aktualizacja z migracją 011 wymaga ponownego logowania wszystkich użytkowników.**
Historyczne tokeny pozostają w bazie jako unieważnione; dane operacyjne są
zachowane. Stare JWT bez identyfikatora sesji nie działają. Nie ma jeszcze
retencji starych sesji/tokenów ani synchronizacji rotacji między kartami;
utrata odpowiedzi po zatwierdzonej rotacji może wymagać nowego logowania.
Testy PostgreSQL sesji wymagają jawnego `SMS_TEST_POSTGRES_DSN` wskazującego
izolowaną lokalną bazę `sms_test_*`; bez niego są pomijane. Stan weryfikacji
i ograniczenia opisano w `docs/SECURITY_REVIEW.md`.

### Prywatne widoki inwentaryzacji i strony wyników

**Servers → Saved views** zapisuje wyszukiwanie, status, grupę, system, sortowanie
i liczbę wierszy na stronie. **Save as new view** tworzy widok; **Update view**
zmienia nazwę i filtry wybranego widoku. Usuwanie wymaga potwierdzenia i nie
usuwa hostów. Każde konto z `servers.read`, również readonly, może mieć do 20
własnych widoków. Po błędzie listy widoków inwentaryzacja nadal działa;
**Retry saved views** ponawia tylko pobranie preferencji.

Lista pobiera z API jedną stronę (domyślnie 25, w panelu również 50/100 hostów).
Zmiana filtrów zaczyna od pierwszej strony, a Refresh zachowuje filtry i stronę.
API koryguje stronę, gdy liczba hostów zmaleje. Liczniki floty dotyczą całego
bieżącego zakresu dostępu; licznik przy paginacji podaje liczbę pasujących hostów.
Sortowanie nazw jest leksykograficzne według `lower(hostname)` w PostgreSQL,
z ID jako rozstrzygnięciem remisu; `node10` poprzedza `node2`. Ostatni kontakt
sortuje malejąco z brakującą datą na końcu. Status umieszcza offline jako pierwszy.
CSV nadal eksportuje cały dozwolony zakres, zgodnie z etykietą **Export all CSV**.

API (Bearer JWT z aktywną sesją oraz `servers.read`):

- `GET /api/inventory/servers?search=host&status=offline&sort=seen&page=1&page_size=25`
  zwraca `data: {items, total, page, page_size, summary}`; opcjonalne `group`
  przyjmuje UUID lub `__ungrouped__`, a `os` — `linux`/`windows`.
- `GET /api/inventory/groups` zwraca wyłącznie ID i nazwy grup w aktualnym zakresie.
- `GET/POST /api/inventory/views` oraz `PUT/DELETE /api/inventory/views/{id}`
  obsługują własne widoki. Zapis przyjmuje `{name, filters}`; właściciel wynika
  z sesji. `filters` zawiera `search`, `status`, `group`, `os`, `sort`, `page_size`.

API ogranicza stronę do 100 rekordów, wyszukiwanie do 200 bajtów, nazwę do 80
znaków i żądanie zapisu do 4 KiB. `%` i `_` w wyszukiwaniu są znakami dosłownymi.
Zapisany widok nie przechowuje uprawnień: po utracie dostępu do zapisanej grupy
API zwraca 403. Panel zachowuje ten filtr; **Clear filters** pozwala wrócić do
aktualnie dostępnych hostów. Cudzy i nieistniejący widok dają jednakowe 404.

Migracja **012** dodaje tabelę preferencji i indeksy bez zmiany istniejących
hostów. Jej rollback usuwa zapisane widoki i nowe indeksy. Stare `/api/servers`
pozostaje dla kompatybilności pozostałych ekranów; nowy widok Servers nie
korzysta z tego pełnego odczytu. Liczniki i strona są czytane w jednej transakcji
Repeatable Read; między żądaniami zawartość floty może się zmienić. To paginacja
OFFSET, bez gwarancji niezmiennego zestawu podczas przechodzenia między stronami.
Testy PostgreSQL wymagają jawnego `SMS_TEST_POSTGRES_DSN` do lokalnej bazy
`sms_test_*`. Bieżące wyniki i braki weryfikacji opisują backlog i SECURITY_REVIEW.

### Grupy i wymagania agentów

W **Settings → Server groups** odśwież listę grup, utwórz grupę (globalne
`groups.write`) lub otwórz **Requirements**. Edytor pobiera zapisane nazwy,
w tym niestandardowe, zanim pozwoli je zmienić. Wpisz jedną nazwę na wiersz.
Wyczyszczenie wcześniej niepustej listy wymaga potwierdzenia. Zapis nie instaluje
oprogramowania: lista służy Compliance i alertom przy odbiorze raportów.
Błąd odczytu blokuje edycję, a błąd zapisu zachowuje szkic.

- `GET /api/groups/{id}/required-agents` wymaga `groups.read` i zakresu grupy.
- `PUT` wymaga `groups.write`, przyjmuje `{"agents":[...]}` i zastępuje cały zestaw.
  Obie metody zwracają `data: {group_id, agents}`. Limit: 50 nazw po 100 znaków
  i 8 KiB żądania. Nazwy są przycinane i deduplikowane. Puste nazwy, znaki
  kontrolne, obce pola i dodatkowy JSON są odrzucane. Pusta tablica usuwa wymagania.
- Transakcja blokuje wiersz grupy, więc równoległe zastąpienia nie mieszają
  zestawów. Obowiązuje ostatni zapis, bez wykrywania konfliktu dwóch operatorów.
- Usunięcie grupy wymaga potwierdzenia. HTTP 409 oznacza zależności, np. hosty,
  zakresy kont lub mapowania LDAP. Przed odpięciem zakresu konta przejrzyj
  uprawnienia: brak zakresów oznacza dostęp globalny, administrator widzi wszystko.

Migracja **013** zmienia klucze obce zakresów kont i mapowań LDAP z CASCADE na
RESTRICT, zachowując rekordy. Rollback celowo pozostawia te ograniczenia, aby
usunięcie grupy nie rozszerzało dostępu konta. Starszy serwer może wyświetlić
ogólny błąd zamiast 409, lecz baza nadal blokuje usunięcie.

Eksport CSV obejmuje dozwolony zakres konta, bez filtrów aktualnej strony.
Koduje przecinki/cudzysłowy i poprzedza apostrofem komórki mogące uruchomić
formułę arkusza. E-mail raportu także wymaga dostępu do grupy jego hosta.
API agentów odrzuca wygasłe lub jeszcze nieważne certyfikaty, również przed
zużyciem tokena rejestracyjnego. Pozostaje model przypiętego odcisku po rejestracji
z tokenem, bez nowego mechanizmu rotacji certyfikatów ani weryfikacji CA.


### Mechanizmy aplikacji

- `mTLS` dla ruchu agent-serwer
- JWT dla użytkowników dashboardu
- RBAC oparte o uprawnienia i scope'y
- audit log operacji użytkowników
- rate limiting dla API i agentów
- szyfrowanie wrażliwych danych w bazie `AES-256-GCM`

## Licencja

MIT — [LICENSE](LICENSE).
