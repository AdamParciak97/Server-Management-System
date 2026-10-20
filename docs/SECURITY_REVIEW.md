# Przegląd bezpieczeństwa — 2026-10-15

Zakres: statyczny przegląd API agentów, middleware, sesji, konfiguracji integracji
i uploadu. To częściowy audyt, nie certyfikacja bezpieczeństwa. Nie odczytywano
rzeczywistych sekretów i nie wykonywano poleceń na zarządzanych hostach.

## SEC-001 — brak wymaganej tożsamości agenta [wysoki]

Aktualizacja 2026-10-19: dokończono cykl tokenów rejestracyjnych. Lista API nie
zawiera sekretu, tworzenie wymaga `tokens.write` i ograniczonego terminu ważności,
a unieważnienie zapisuje stan i audyt w jednej transakcji. Rejestracja wymaga
certyfikatu i warunkowo zużywa token w tej samej transakcji co zapis agenta;
predykat wyklucza tokeny użyte, wygasłe i unieważnione. Panel ujawnia nowy sekret
jednorazowo i czyści go przy wylogowaniu. Testy API obejmują uprawnienia, redakcję,
walidację, konflikty i błędy; pełna kontrola Go/vet/build i 209 testów Node przeszły.
Przeglądarka z lokalnym PostgreSQL potwierdziła tworzenie, historię bez sekretu
i trwałe unieważnienie. **Nadal niepotwierdzone: integracja mTLS i wyścigi
rejestracji/unieważnienia na PostgreSQL.**

**Potwierdzony w kodzie; poprawiony, testy regresji przeszły.**
`server/api/middleware.go:mtlsMiddleware` przepuszczał brak i nieznany certyfikat
do wszystkich handlerów agentów. `handleGetCommands` przyjmował `agent_id` z query,
a raport i wynik polecenia przyjmowały identyfikatory z JSON. Znajomość ID mogła
umożliwić dostęp do kolejki lub fałszowanie danych bez tożsamości certyfikatowej.

Poprawka: wyłącznie POST `/api/agent/register` przechodzi do osobnej walidacji
tokena rejestracyjnego; pozostałe endpointy odrzucają brak/nieznany certyfikat
HTTP 401. Testy `server/api/agent_auth_test.go` obejmują trzy trasy z podrobionym
ID i nagłówkiem proxy, dokładny wyjątek rejestracji oraz zachowanie walidacji.
Praca bez certyfikatów nie jest już obsługiwana przez operacyjne API agentów.
Agenci muszą korzystać z HTTPS i zarejestrowanego certyfikatu klienta.
Do dalszej weryfikacji: rzeczywiste uzgadnianie TLS, cykl życia i ważność certyfikatów.

## SEC-002 — wynik polecenia nie jest związany z agentem [wysoki]

**Potwierdzony w kodzie; poprawka zaimplementowana 2026-10-15, testy Go oczekują na supervisora.**
Wcześniej `server/db/commands.go:UpdateCommandResult` aktualizował po samym ID.
Agent A znający identyfikator polecenia B mógł sfałszować jego wynik. Możliwe było
też nadpisanie zakończonego/anulowanego polecenia oraz zgłoszenie wyniku przed wysłaniem.

Poprawka: uwierzytelniony agent jest osobnym argumentem zapisu. Atomowy UPDATE
wymaga zgodności ID polecenia i agenta, statusu `sent`/`running` i spełnionej
akceptacji. Dopuszczalne wyniki to wyłącznie `success`/`error`/`timeout`;
walidowane są UUID, nieujemny czas wykonania i niepusta data zakończenia.
Brak zmienionego wiersza zwraca jednakowe HTTP 409 dla cudzego, nieistniejącego,
niewysłanego lub zakończonego polecenia. Błędne dane zwracają 400, błąd zapisu 500.
Handlery kolejki i wyniku dodatkowo odrzucają brak tożsamości w kontekście (401);
query i JSON nie zastępują certyfikatu. Ochrona SEC-001 pozostaje zachowana.
Odrzucony wynik nie tworzy alertu. Alert zaakceptowanego błędu jest zapisywany
przed odpowiedzią, bez używania anulowanego kontekstu w gorutynie; błąd alertu jest logowany.

Przegląd ujawnił też nadpisywanie statusów przez pobieranie kolejki: SELECT i późniejszy
UPDATE nie sprawdzały ponownie stanu, a błąd UPDATE był ignorowany. UPDATE sprawdza
teraz agenta, `pending` i akceptację, zwraca ID faktycznie przejętych poleceń przez
RETURNING. Handler wysyła wyłącznie tę listę; błąd zapisu/odczytu zatrzymuje odpowiedź.

Dowody regresji w `server/db/command_results_test.go`: rzeczywisty zapis na tymczasowej
bazie SQLite z syntetycznymi agentami A/B, kontrola wszystkich pól po odmowie,
przejść statusów, akceptacji, nieistniejącego ID, walidacji, błędu bazy i dwóch
równoległych zgłoszeń (jedna wygrana). Adapter zmienia tylko znaczniki parametrów
SQL; test ma jedno połączenie i **nie dowodzi zachowania blokad PostgreSQL**.
`server/api/command_results_test.go` sprawdza osobno nadpisanie podrobionej
tożsamości, kody HTTP, brak alertów po odmowie i brak dostępu bez kontekstu.
Testów Go w tym cyklu nie uruchamiano; w PATH nie ma Go/gofmt, a użytkownik zlecił
testy Go i kompilację supervisorowi. Do zamknięcia: ich wynik oraz integracja
PostgreSQL z konkurencyjnym pollingiem/anulowaniem i wynikami A/B.

Ograniczenia: utrata odpowiedzi po oznaczeniu `sent` nadal nie ma mechanizmu
ponownego dostarczenia; zatwierdzenie wyniku i zapis alertu nie są wspólną transakcją.
Powtórny wynik zwraca 409 zamiast nadpisywać dane. Nie jest to dowód pełnej
niezawodności kolejki ani pełnego audytu RBAC/TLS.

## SEC-007 — okno pominięcia zatwierdzania skryptów [wysoki]

**Potwierdzony statycznie; poprawka zaimplementowana, test Go oczekuje na supervisora.**
`CreateCommand` zapisywał `pending` bez `requires_approval`, a handler ustawiał
flagę osobnym UPDATE. Polling między tymi zapisami mógł wydać skrypt bez akceptacji;
ścieżka grupowa ignorowała błąd drugiego zapisu. Scheduler używał samego CreateCommand,
więc skrypty z harmonogramu w ogóle nie otrzymywały flagi. Wymagane uprawnienie
tworzenia poleceń/harmonogramów; skutkiem mogło być ominięcie `commands.approve`.

INSERT zapisuje teraz wymóg zatwierdzenia razem z poleceniem (`run_script` bez dry-run),
dla wszystkich wywołań, także harmonogramów. Usunięto drugi zapis z handlera.
Test `TestScriptApprovalIsPersistedAtCreation` sprawdza rzeczywisty INSERT dla
skryptu, dry-run i zwykłego polecenia z pustym twórcą jak w schedulerze.
UI wyjaśnia konieczność zatwierdzenia każdej zaplanowanej instancji skryptu.
Migracja 009 ustawia flagę wcześniejszym skryptom `pending` bez dry-run i bez
akceptacji; zachowuje rekordy, wyniki oraz istniejące zatwierdzenia. Downgrade
celowo nie usuwa wymogu akceptacji. Test migracji sprawdza osiem stanów i powtórne
uruchomienie na SQLite; Go i migracja na PostgreSQL wymagają kontroli supervisora.
Już wysłanych/uruchomionych skryptów nie można tą zmianą wycofać.

## SEC-008 — wstrzyknięcie atrybutu przez nazwę usługi [średni]

**Potwierdzone generowanie niebezpiecznego HTML; poprawione i objęte testem Node.**
W formularzu Commands `service.name` z raportu agenta trafiało do `option value`
przez `App.escHtml`, które nie koduje cudzysłowów. Syntetyczna nazwa
`svc" onmouseover="bad()` mogła utworzyć dodatkowy atrybut. Wymaga kontroli
raportu/nazwy usługi i otwarcia formularza przez operatora. Nie wykonywano
payloadu XSS w przeglądarce; potwierdzono granicę HTML, a nie wykonanie skryptu.
Użyto lokalnego `esc()` kodującego także cudzysłowy. Test
`reported service names cannot inject attributes into the command composer`
sprawdza bezpieczny atrybut; nowe testy podsumowania obejmują również nazwy hostów
i treść skryptu. Wszystkie dane testowe są syntetyczne.

Rzeczywista kontrola cyklu: `node --test server/tests/*.test.cjs` — 155/155 OK
(33 Commands); `node --check` zmienionego JS/testu i `git diff --check` — OK.
Próba lokalnego smoke testu Chrome zakończyła się `CDP timed out: Runtime.enable`;
renderowanie, focus i działanie przeglądarkowe nie są przez ten wynik potwierdzone.

## SEC-003 — zwracanie haseł integracji do przeglądarki [wysoki]

**Potwierdzony w kodzie; implementacja dokończona 2026-10-15. Testy Node przeszły;
nowe testy Go i integracja PostgreSQL pozostają do uruchomienia przez supervisora.**
Wcześniej `GetAllSystemConfig` odszyfrowywało konfigurację, a
`handleGetLDAPSettings` / `handleGetSMTPSettings` odsyłały hasła do każdego
użytkownika z `settings.read`. Skutkiem było ujawnienie poświadczeń integracji
użytkownikowi bez prawa ich zmiany. Dowód: poprzednie handlery w diff oraz
przypisanie pola hasła w starym formularzu. Nie pobierano rzeczywistych sekretów.

Odczyt używa teraz `GetPublicSystemConfig`: SQL zamienia wartości haseł na
informację o obecności, również dla starszych wartości jawnych; nie ładuje hasła
do pamięci handlera i nie odszyfrowuje go. Handler dodatkowo ogranicza odpowiedź
do jawnej listy pól danej integracji i normalizuje `*_configured`. GET/PUT mają
`Cache-Control: no-store`. Wewnętrzny odczyt dla LDAP i wysyłki SMTP pozostaje
oddzielny. Frontend filtruje publiczne pola, więc nawet starsza odpowiedź API
z hasłem nie wypełnia pola hasła ani nie trafia do zapamiętanej konfiguracji.

PUT sprawdza `settings.write`, typy i listę pól, ogranicza body do 64 KiB oraz
odrzuca dodatkowy dokument JSON. `secret_action=keep` lub brak akcji nie zapisuje
klucza sekretu. `replace` wymaga niepustej wartości; `clear` usuwa ją jawnie.
Sprzeczne kombinacje i zapis kluczy drugiej integracji są odrzucane. Zmieniane pola
są zapisywane transakcyjnie z szyfrowaniem przed rozpoczęciem transakcji; błąd
zapisu lub commit jest zwracany jako 500 bez szczegółów bazy. Pominięty sekret nie
jest odczytywany i ponownie zapisywany, więc zapis innych pól nie przywraca starego
hasła przy równoczesnej wymianie. Istniejący audyt tras zapisuje metodę, ścieżkę
i wynik bez body; gwarancja dostarczenia audytu pozostaje częścią SEC-006.

Panel ma jawne stany ładowania, nieudanego odczytu i ponowienia, blokadę edycji
przed odczytem oraz tryb tylko do odczytu. Usunięcie wymaga potwierdzenia, wymiana
zachowuje spacje; sukces czyści pole hasła. Podczas zapisu formularz blokuje
duplikaty i odświeżenie nadpisujące edycję. Spóźniona odpowiedź nie zmienia nowego
formularza po nawigacji. Nie weryfikowano połączeń LDAP/SMTP ani hostów.

Dowody: `server/api/settings_test.go` obejmuje macierz 401/403/200, oba endpointy,
allowlistę odpowiedzi, akcje sekretu, błędne typy/rozmiary i redakcję błędów.
`server/db/config_test.go` wykonuje produkcyjne SQL na izolowanej SQLite,
sprawdza szyfrowanie, zachowanie/wyczyszczenie sekretu oraz rollback po błędzie
drugiego zapisu i symulowanej odmowie commit. Testuje też zapytanie publiczne dla
jawnych, zaszyfrowanych i pustych sekretów. To nie dowodzi blokad PostgreSQL ani
wyniku commit po utracie połączenia. Testów Go lokalnie nie uruchamiano (brak Go
w PATH; testy i kompilację użytkownik powierzył supervisorowi).

Rzeczywiście wykonano `node --test server/tests/*.test.cjs`: **178/178 OK**, w tym
23 testy Settings z atrapami DOM/API. `node --check` 18 plików JS/CJS i
`git diff --check` zakończone powodzeniem. Rozszerzony test przeglądarkowy obejmuje
formularze Settings przy 1440/390 px, lecz uruchomienie lokalnego Chrome zakończyło
się `CDP timed out: Runtime.enable` przed asercjami. Układ, fokus i natywna obsługa
formularzy nadal wymagają kontroli w działającej przeglądarce.

## SEC-009 — nazwa konta w kodzie przycisków Settings [średni]

**Potwierdzona granica wstrzyknięcia; poprawiona i objęta testem Node.**
`renderUsers` umieszczało nazwę użytkownika w łańcuchu JavaScript atrybutu `onclick`
przez `App.escHtml`, które koduje HTML, ale nie apostrofy ani cudzysłowy.
Syntetyczna nazwa `');globalThis.syntheticAttack=1;//` zamykała argument.
Warunkiem jest kontrola nazwy konta i użycie przycisku przez operatora mającego
`users.write`. Nie wykonywano payloadu w przeglądarce ani na danych rzeczywistych.

Przyciski zawierają teraz wyłącznie liczbowy indeks i stałą akcję. `userAction`
pobiera dane z modelu i przekazuje je jako argumenty funkcji, bez generowania kodu
z nazwy/ID/roli. Test `account names cannot become JavaScript in Settings action
attributes` potwierdza dokładną treść wszystkich trzech handlerów dla nazwy
z apostrofem, cudzysłowem i próbą dodatkowego atrybutu.

## Kontrola zaległego błędu z przebiegu 000049-69b498e0

Log supervisora potwierdza 155/155 Node i sukces pakietu Go `server/db`, ale cały
zestaw Go przerwały trzy przypadki `TestHandlersRejectInvalidJSON/command_result`:
oczekiwano 400, otrzymano 401. Zastana poprawka `validation_test.go` dostarcza teraz
syntetyczną tożsamość agenta w kontekście przed walidacją JSON. Zachowano asercje
400 i niezależne testy odrzucenia nieuwierzytelnionego wyniku (401), bez osłabiania
kontroli produkcyjnej. Pełny ponowny wynik Go/vet/kompilacji jest nadal wymagany.

## SEC-004 — upload bez całkowitego limitu żądania [wysoki]

**Potwierdzony w kodzie; implementacja poprawki 2026-10-15 (po cyklu 56),
nowe testy Go oczekują na supervisora.** Poprzednio `ParseMultipartForm(500 << 20)`
określał jedynie próg pamięci, a `io.ReadAll(file)` wczytywał cały plik. Brakowało
limitu body i sprzątania po błędzie bazy. Warunek: `packages.write`; wpływ: zużycie
pamięci/dysku i osierocone pliki. Dodatkowo `name` trafiało do `filepath.Join` bez
walidacji: segmenty `../../../` mogły wyprowadzić ścieżkę poza magazyn. Download
(także publiczny/latest) i delete ufały zapisanej ścieżce; JSON ujawniał ją klientowi.

Poprawka `server/api/packages.go`: MaxBytesReader 501 MiB dla całego body
(również bez Content-Length i po końcowym separatorze), limit pliku 500 MiB,
ograniczone metadane, dokładnie jeden plik i odrzucanie pól powtórzonych/nieznanych.
Streaming do losowego pliku 0600, SHA-256 w trakcie zapisu, Sync/Close, rename
przed INSERT; defer usuwa wyłącznie pliki utworzone przez to żądanie po błędzie.
Nazwa/version/oryginalny filename mają allowlisty, wartości formularza nie tworzą
katalogów. Download i delete wymagają zwykłego pliku bez dowiązań, bezpośrednio
w uploadDir; download porównuje Lstat/Stat i używa otwartego deskryptora.
Nagłówki: attachment przez mime.FormatMediaType, octet-stream, nosniff, CSP sandbox.
API publikuje basename jako `filename`, bez katalogu; Commands zachowuje rozszerzenie
instalatora. Istniejący JWT/RBAC i middleware audytu pozostają w routerze;
handler uploadu dodatkowo sprawdza uprawnienie przed czytaniem/zapisem.

Dowody testowe: `server/api/packages_test.go` zawiera prawdziwe małe strumienie
multipart i tymczasowy katalog: 401/403, prawidłowy hash/rozmiar/atrybucja,
plik przed i po metadanych, granice rozmiaru i nieznana długość, epilog, duplikaty,
traversal Unix/Windows, pusty/przerwany upload, anulowany kontekst i błąd zapisu
rekordu. Atrapa persystencji odczytuje opublikowany plik; to **nie jest integracja
PostgreSQL**. Asercje sprzątania zachowują wcześniejszy syntetyczny plik.
Konflikt unikalności PostgreSQL (23505) ma osobny test mapowania na 409 i sprzątania
nowego pliku; nie nadpisuje dotychczasowej paczki. Download
ma testy zakresów 206, nagłówków, ścieżek zewnętrznych i symlink (skip tylko gdy
system nie umożliwia tworzenia symlink). **Nie uruchomiono nowych testów Go lokalnie:
brak Go/gofmt; wymagany wynik supervisora.** Node: 23 nowe testy Packages i regresja
Commands sprawdzają formularz, uprawnienia, błędy, duplikaty, filtry, URL instalatora,
kodowanie danych i spóźnione odpowiedzi; pełny wynik podany w dzienniku cyklu.

Zakres i ograniczenia: publiczna dystrybucja paczek jest istniejącą funkcją produktu,
teraz jawnie opisaną w panelu. Nie jest magazynem prywatnych plików. Checksum nie
weryfikuje wydawcy. Katalog wymaga zaufanego lokalnego właściciela; to nie ochrona
przed administratorem podmieniającym drzewo filesystem. Awaria procesu między zapisem
pliku a INSERT może zostawić plik; brak wspólnej transakcji FS/SQL. Potrzebne testy
PostgreSQL, uzgadnianie osieroconych plików, kwoty/retencja i idempotentne ponawianie.
Usunięcie rekordu z błędem usunięcia pliku zwraca ostrzeżenie zamiast ukrywać problem.
Kontrola Chrome zatrzymała się ponownie na `CDP timed out: Runtime.enable`, przed
asercjami widoku 1440/390 px; dodano scenariusze do inventory-browser.cjs.

## SEC-010 — nazwy paczek w wykonywalnym kodzie przycisków [średni]

**Potwierdzony statycznie; naprawiony 2026-10-15.** Packages wstawiał nazwę i wersję
do argumentów JavaScript w `onclick`, używając App.escHtml, które koduje tylko `&<>`.
Zapis nazwy typu `x');alert(1);//` przez użytkownika z packages.write mógł wykonać
kod po kliknięciu Delete przez inną osobę. Starsze rekordy również stanowią wejście
niezaufane. Poprawka: delegacja zdarzeń i wyszukanie rekordu po ID, bez danych w kodzie
handlera, osobne kodowanie cudzysłowów/apostrofów we wszystkich atrybutach, nazwy
potwierdzenia przekazywane jako tekst. Regresja Node obejmuje złośliwe ID, nazwę,
wersję, opis, system i SHA-256; sprawdza brak wstrzykniętych atrybutów, skryptów
i inline handlerów w wierszu. Test przechodzi na syntetycznych danych.

### Uzupełnienie wyniku SEC-002/003/007 po supervisorze 56

Logi `000056-50386eac`: 178/178 Node, pełne Go (`server/api`, `server/db`, bufor),
vet i kompilacja serwera Linux oraz agentów Linux/Windows zakończone kodem 0.
Potwierdza to wcześniej oczekujące testy Go i poprawkę fixture tożsamości agenta.
Nie zamyka integracji PostgreSQL, migracji 009 ani kontroli renderowania. Nie jest
wynikiem nowych testów uploadu dodanych w bieżącym etapie.

## SEC-005 — cykl życia sesji i odświeżanie [wysoki, poprawka oczekuje testów Go/PostgreSQL]

**Dowód i warunki (przegląd kodu, 2026-10-19):** poprzedni `handleRefreshToken`
z HEAD wykonywał oddzielne Validate/Revoke/Save i ignorował błędy dwóch zapisów.
Dwa żądania z tym samym ważnym refresh tokenem mogły przejść odczyt przed jego
unieważnieniem. Zmiana hasła aktualizowała sam hash, a middleware sprawdzał JWT
bez stanu konta/sesji. Posiadacz wcześniej wydanych tokenów mógł więc zachować
dostęp po zmianie hasła lub dezaktywacji. Sukces HTTP nie dowodził zapisu tokenu.
Są to potwierdzone braki w kodzie; wyścigu nie odtworzono jeszcze na PostgreSQL.

**Poprawka:** zachowano i dokończono pozostawiony przepływ `account_sessions`
(migracja 011), login → atomowa rotacja → własna lista/wylogowanie → zmiana hasła.
Transakcje blokują najpierw aktywnego użytkownika przez `FOR UPDATE`. Rotacja
warunkowo zużywa dokładnie jeden token i zapisuje następcę przed wysłaniem
odpowiedzi. Błędy INSERT/commit propagują się; sesja ma stały termin siedmiu dni
od logowania. Zmiana hasła ponownie porównuje poprzedni hash pod blokadą i razem
zapisuje nowe hasło, cofnięcie wszystkich sesji/tokenów i audyt. Wylogowanie
pozostałych sesji zachowuje bieżącą i obejmuje również wpisy poza limitem listy.
JWT wymaga HS256, terminu ważności i identyfikatora aktywnej sesji. Middleware
odczytuje aktualne uprawnienia, rolę i zakresy; awaria magazynu daje 503 zamiast
domyślnego nieograniczonego dostępu. Usunięcie konta dezaktywuje je i cofa sesje
w jednej transakcji. LDAP nie reaktywuje wyłączonego konta ani nie przejmuje
lokalnej nazwy użytkownika; błąd odczytu mapowań blokuje logowanie.

**Audyt dokończenia:** API listy/wylogowania bierze właściciela i bieżącą sesję
z uwierzytelnionego kontekstu, nie z parametrów klienta. Lista nie zawiera
tokenów/hashów i ma `no-store`. Opis przeglądarki jest niezaufany i escapowany.
Zmiana hasła odrzuca obce pola, dodatkowy JSON i treść powyżej 4 KiB; poprzedni
pojedynczy Decode pomijał końcówkę żądania. Bcrypt ma jawny limit 8–72 bajtów.
Panel nie oznacza błędnej odpowiedzi 200 jako potwierdzonej zmiany hasła lub
wylogowania. Po awarii wylogowania usuwa lokalne dane i uczciwie informuje,
że cofnięcie sesji na serwerze nie zostało potwierdzone. Spóźniona odpowiedź
nie usuwa danych nowego logowania ani nie nadpisuje nowego widoku konta.

**Rzeczywista weryfikacja:** `node --test server/tests/*.test.cjs` — 238/238 OK,
w tym 18 testów panelu konta oraz testy klienta sesji, błędnych potwierdzeń,
spóźnionych odpowiedzi, XSS i zachowania fokusu w atrapach DOM. Dodano/uzupełniono
`server/api/sessions_test.go`, `password_test.go` i `server/db/sessions_test.go`:
odmowy dostępu, trzy role, właściciel A/B, awarie odczytu/zapisu/commit/audytu,
jeden zwycięzca ośmiu rotacji, wyścigi zmiana hasła/dezaktywacja/wylogowanie,
wygaśnięcie, migracja historycznego tokenu i odrzucenie starego hasha bez skutków.
**Testów Go nie uruchomiono w tym cyklu** (zgodnie z podziałem z supervisorem;
Go/gofmt niedostępne w PATH). Testy bazy wymagają jawnego
`SMS_TEST_POSTGRES_DSN`, bazy `sms_test_*` na loopback, także dla fallbacków;
tworzą odrębny syntetyczny schemat. Bez tej konfiguracji są pomijane, a wynik
zwykłego Go/build nie potwierdzi współbieżności ani migracji na PostgreSQL.

**Ograniczenia:** próba Edge `inventory-browser.cjs` — kod 1,
`CDP timed out: Runtime.enable`, przed asercjami; układ 1440/390 px i natywny focus
pozostają niepotwierdzone. Migracja 011 wymusza ponowne logowanie, zachowując
historyczne tokeny jako unieważnione. Cofnięcie sesji blokuje następne żądania,
nie cofa operacji już autoryzowanej. Utrata odpowiedzi po zatwierdzonej rotacji
może wymagać ponownego logowania; nie ma jeszcze synchronizacji rotacji między
kartami współdzielącymi localStorage ani retencji starych sesji/tokenów.
Nie przeprowadzono skanu zależności ani testów na rzeczywistych hostach.

## INV-001 — zapisane widoki i paginacja inwentaryzacji [przegląd 2026-10-19]

Zakres: nowe `/api/inventory/servers`, `/groups`, `/views`, migracja 012 oraz
przepływ UI → API → PostgreSQL. Nie potwierdzono nowej podatności wysokiego
ryzyka w tym przepływie. Poniższe ustalenia nie obejmują całego RBAC aplikacji.

- **Izolacja właściciela:** API nie przyjmuje user_id ani zakresów z body.
  GET, UPDATE i DELETE w `server/db/inventory.go` zawierają `user_id` z aktualnej
  sesji; aktualizacja/usunięcie dodatkowo wymaga ID widoku. Cudze i nieistniejące
  ID zwracają identyczne 404. Uprawnienie `servers.read` jest wymagane także przy
  zapisie własnych preferencji; readonly nie dostaje prawa modyfikacji hostów.
- **Zakres hostów:** predykat `group_id = ANY($n::uuid[])` działa w SQL przed
  zliczaniem i LIMIT/OFFSET. Podsumowanie obejmuje tylko dozwoloną flotę.
  Zapisany UUID grupy nie stanowi uprawnienia: jawny filtr spoza aktualnego
  scope daje 403, również przy ponownym użyciu starego widoku. Brak zakresów
  i admin zachowują istniejącą semantykę globalnego dostępu; jej zmiany nie są
  częścią tego etapu. Pusta, nie-nil lista zakresów na poziomie DB daje zero hostów.
- **SQL i limity:** wartości są parametrami; ORDER BY pochodzi z trzech stałych
  wariantów. `strpos` wyszukuje dosłownie także `%`, `_` i apostrofy. Limit strony
  1–100, numer 1–1000000, search 200 bajtów, body 4 KiB, nazwa 80 znaków bez
  znaków sterujących. Nieznane/powtórzone parametry query, błędne kodowanie query,
  obce pola JSON i dodatkowy dokument są odrzucane. Blokada wiersza użytkownika
  serializuje tworzenie widoków i limit 20, także dla równoległych zapisów.
- **Spójność i błędy:** licznik całego zakresu, licznik filtrowany i strona mają
  jeden snapshot Repeatable Read. Błędy DB nie zamieniają się w pustą flotę;
  klient sprawdza dane strony, liczniki i potwierdzenia zapisu/usunięcia.
  Nieprawidłowe liczniki nie są interpolowane jako HTML. Lista nie zwraca
  fingerprintu certyfikatu; odpowiedzi mają `Cache-Control: no-store`.
- **XSS i interakcje:** nazwy widoków trafiają do `textContent` opcji lub
  `App.escHtml` w formularzu/potwierdzeniu, a nie do kodu handlerów. Starsze listy,
  strony i zakończenia operacji po opuszczeniu widoku nie zmieniają nowego ekranu.
  Zapis nie zamyka formularza bez potwierdzenia API; usunięcie wymaga dialogu.

**Potwierdzony problem dostępności, priorytet zwykły:** poprzedni Servers
łączył `getServers()` z `listGroups()` w jednym Promise.all. Użytkownik mający
`servers.read` bez `groups.read` otrzymywał błąd całej inwentaryzacji. Nowy
endpoint grup wymaga `servers.read` i zwraca tylko dozwolone ID/nazwy potrzebne
w filtrze. Nie rozszerza operacji administracji grupami.

**Rzeczywiste wyniki:** 253/253 testy Node zaliczone, w tym 15 nowych przypadków
transportu, paginacji, zapisu/aktualizacji/usuwania, XSS, awarii i spóźnionych
odpowiedzi. Zachowano asercje wcześniejszych testów; atrapy zwracają teraz tylko
stronę danych i obsługują nowe żądanie po zmianie filtra. `node --check` dla
zmienionych JS/CJS oraz `git diff --check` zaliczone. Próba lokalnego Edge na
syntetycznej flocie ponownie zakończyła się `CDP timed out: Runtime.enable` przed
asercjami — **renderowanie 1440/390 px, natywny dialog i fokus niepotwierdzone**.

`server/api/inventory_test.go` dodaje testy ról/uprawnień, granic, zakresów,
walidacji właściciela i bezpiecznych błędów. `server/db/inventory_test.go` dodaje
testy predykatów oraz opcjonalną integrację migracji, stron, literalnego search,
izolacji dwóch kont, trwałego zapisu i równoległego limitu 20 na PostgreSQL.
**Nowych testów Go nie uruchamiano; oczekują na supervisora.** Zmienna
`SMS_TEST_POSTGRES_DSN` nie jest ustawiona (sprawdzono tylko obecność), więc
integracja wymaga jawnej konfiguracji izolowanej lokalnej bazy. Logi supervisora
67 potwierdzają Go/vet/build dla wcześniejszego SEC-005, nie dla tego etapu.

Ograniczenia: pozostałe ekrany nadal mają zgodnościowy `/api/servers`; OFFSET
i zliczanie wymagają pomiaru na dużej syntetycznej flocie. Aktualizacja tego
samego widoku w dwóch kartach ma semantykę ostatniego zapisu; POST po utracie
potwierdzenia nie ma klucza idempotencji. Audyt korzysta z istniejącego middleware
(zapis akcji i wyniku bez body), którego gwarancja trwałości pozostaje w SEC-006.
Nie wykonano skanu sieci/zależności ani operacji na rzeczywistych hostach.

## SEC-006 — adres klienta, limity, konfiguracja [do oceny]

Router bezwarunkowo używa `middleware.RealIP`, a audyt czyta X-Forwarded-For.
Sprawdzić granicę zaufania do reverse proxy i możliwość obchodzenia limitu.
Przejrzeć domyślne klucze i start bez TLS. Przed produkcją konieczny także
aktualny skan zależności i obrazów; taki skan nie został jeszcze wykonany.


## SEC-011 — obejścia zakresów grup w raportach i mutacjach [wysoki]

**Potwierdzone statycznie 2026-10-19; poprawki zaimplementowane, nowe testy Go
oczekują na supervisora.** Dokończono zastane pliki `group_access.go` i
`scoped_mutations.go` oraz powiązane zmiany handlerów. Sama obecność tych plików
nie była dowodem zakończenia poprzedniego cyklu.

Dowody i warunki:

- `handlers_server.go:handleExportReport` pobierał `ListAgents` i wypisywał każdy
  rekord bez kontroli grupy. Konto z `servers.read` i ograniczonym zakresem mogło
  pobrać metadane całej floty przez `/api/reports/export?format=csv`.
  Wcześniejsza deklaracja README o zakresie eksportu nie odpowiadała kodowi.
- `handlers_reports.go:handleEmailReport` pobierał raport po ID i hosta bez
  sprawdzenia jego grupy. Użytkownik z `servers.read`, znanym cudzym ID raportu
  i skonfigurowanym SMTP mógł wysłać cudzy raport do wybranego odbiorcy.
- Bazowy `handleAcknowledgeAlert` sprawdzał scope przez listę ograniczoną do
  500 wpisów i pomijał kontrolę po błędzie odczytu. Starszy poprawny alert poza
  limitem był z kolei odrzucany. Usuwanie polityki/wyjątku także dopuszczało zapis
  po błędzie odczytu listy. Ograniczony operator mógł usunąć globalną politykę.
- Usuwanie grupy i zmiana wymaganych agentów nie sprawdzały scope. Ograniczony
  operator mógł tworzyć globalną politykę/grupę. Pusty cel przypisania hosta
  omijał kontrolę docelowej grupy, wynosząc host poza zakres operatora.

Poprawki: eksport kontroluje `servers.read` i zakres przed serializacją każdego
rekordu, z `no-store`. E-mail sprawdza grupę hosta przed odczytem SMTP lub wysyłką.
Mutacje alertów/polityk/wyjątków mają scope w SQL; brakujący i cudzy zasób zwracają
jednakowe 404, a awaria zapisu 503 bez szczegółów. Wymagania i usuwanie grupy
sprawdzają uprawnienie oraz zakres przed odczytem/zapisem. Globalną politykę/grupę
może tworzyć konto bez ograniczenia zakresu lub administrator. Pusty cel przy
odpinaniu hosta również podlega kontroli zakresu.

Dodano `api/rbac_test.go`: niezależna macierz czterech ról i katalogu uprawnień,
grupy read/write/delete, custom permissions, scope raportów i poleceń grupowych,
odmowa bez dostępu do magazynu i redakcja błędów. `api/inventory_export_test.go`
wykonuje handler z flotą A/B/bez grupy: oba kierunki izolacji, role, brak uprawnień,
awaria i pusty CSV. `db/rbac_test.go` wykonuje rzeczywiste mutacje SQL dla zasobów
własnych/cudzych/globalnych i pustego/globalnego scope; po odmowie sprawdza
zachowane rekordy oraz brak autora potwierdzenia. **Go i PostgreSQL nie uruchomiono.**

Pozostają pełna macierz tras HTTP z sesjami, lokalna atrapa SMTP, wyścigi
przenoszenia hostów i operacje na pojedynczych poleceniach. Eksport nadal pobiera
flotę do pamięci przed filtrowaniem; ograniczenie SQL i pomiary dużej floty
pozostają zadaniem niezawodności. Test helpera nie jest pełnym testem trasy.

## SEC-012 — usunięcie ostatniego scope rozszerzało dostęp [wysoki]

**Potwierdzone w schemacie i autoryzacji; implementacja gotowa 2026-10-19.**
Migracja 006 definiowała CASCADE dla zakresów kont i mapowań LDAP, a `isScoped`
traktuje brak scope jako dostęp globalny. Usunięcie grupy mogło więc usunąć
ostatnie ograniczenie innego konta. Warunek: zakres odnoszący się do usuwanej
grupy i brak innych zależności blokujących jej usunięcie.

Migracja 013 zmienia obie relacje na RESTRICT bez usuwania rekordów. Handler
zwraca 409 dla naruszenia klucza obcego; panel opisuje zależności. Rollback
celowo zachowuje RESTRICT, analogicznie do migracji 009. Test PostgreSQL tworzy
konto z jedną grupą i mapowanie LDAP, stosuje migrację, próbuje usunięcia
i sprawdza zachowane rekordy; powtarza kontrolę po rollbacku. **Test oczekuje na
testową bazę i supervisora.** Celowe usunięcie ostatniego scope przez administratora
w API kont nadal oznacza globalny dostęp — nie zmieniano tego kontraktu.

## SEC-013 — API przyjmowało nieważne czasowo certyfikaty agentów [wysoki]

**Potwierdzone statycznie; poprawka i testy dodane 2026-10-19.** Konfiguracja
`tls.RequestClientCert` nie weryfikuje dat certyfikatu klienta. Middleware
sprawdzał tylko odcisk w bazie, a rejestracja tylko obecność certyfikatu.
Posiadacz klucza zarejestrowanego wygasłego certyfikatu zachowywał dostęp.
Ważny token można było zużyć z wygasłym lub jeszcze nieważnym certyfikatem.

Wspólny `clientCertificateFingerprint` odrzuca brak certyfikatu/DER, przyszły
NotBefore i osiągnięty NotAfter przed odczytem tożsamości lub zużyciem tokena.
Tożsamość nadal pochodzi z przypiętego odcisku, nie query/body/nagłówków proxy.
`certificate_validity_test.go` obejmuje daty, brak/nieznany odcisk, awarię bazy,
poprawną tożsamość i rejestrację. Używa syntetycznych pól x509 i atrap magazynu;
**nie jest testem uzgadniania TLS, CA ani rotacji/revokacji certyfikatów**.
Go pozostawiono supervisorowi. Rzeczywiste lokalne mTLS pozostaje otwarte.

## SEC-014 — niekodowane CSV i interpretacja formuł [średni]

**Potwierdzone statycznie; poprawione 2026-10-19.** Eksport sklejał pola hostów
przecinkami. Przecinek/cudzysłów/nowa linia zmieniały strukturę, a początkowy
operator formuły mógł być interpretowany przez arkusz. Warunki: kontrola
metadanych hosta/grupy i otwarcie CSV w arkuszu wykonującym formuły.
Nie wykonywano payloadu ani zewnętrznych odwołań.

Eksport używa `encoding/csv`; wartości zaczynające się =/+/-/@ po białych znakach
lub zawierające tab/CR/LF otrzymują apostrof. Test handlera ponownie parsuje CSV,
sprawdza sześć kolumn, zawartość i neutralizację formuł. To kontrola pliku,
nie test konkretnego arkusza ani dalszej edycji CSV. Go oczekuje na supervisora.

## GROUP-001 — trwałe wymagania agentów i panel grup

Zastany formularz miał zawsze puste checkboxy i nie odczytywał zapisanej listy;
zapis mógł nieświadomie wyczyścić wymagania. Nowy GET i edytor wymagają udanego
odczytu, zachowują niestandardowe nazwy, blokują zapis readonly i wymagają
potwierdzenia wyczyszczenia. Nazwy trafiają do `textContent`, escapowanego HTML
lub `textarea.value`; akcje grup używają indeksów zamiast tekstu API w kodzie JS.

API waliduje 8 KiB, 50 nazw po 100 znaków, obce pola, dodatkowy JSON i znaki
kontrolne. SQL serializuje zastąpienia blokadą wiersza grupy; rollback chroni
poprzedni zestaw po błędzie INSERT. Test PostgreSQL sprawdza trwały odczyt,
rollback, dwa równoległe zestawy bez mieszania i pusty zapis do brakującej grupy.
Nadal obowiązuje ostatni zapis, bez wersjonowania.

**Wykonano lokalnie 272/272 testy Node (19 nowych), kod 0**: odczyt/zapis,
transport, uprawnienia, potwierdzenia, walidacja, szkic, spóźnione odpowiedzi
i niezależność od awarii innych sekcji. To atrapy DOM/API, nie test SQL/renderowania.
Składnia pięciu zmienionych JS/CJS oraz `git diff --check` — OK. Próba Edge
z rozszerzonym scenariuszem 1440/390 px zatrzymała się na
`CDP timed out: Runtime.enable` przed asercjami. Testowy `SMS_TEST_POSTGRES_DSN`
nie jest ustawiony (sprawdzono tylko obecność). Go/Docker i skanu sieci/zależności
nie wykonywano. Trwałość istniejącego middleware audytu pozostaje w SEC-006.
