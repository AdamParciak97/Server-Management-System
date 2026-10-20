# Bot rozwoju aplikacji

## Aplikacja i bot w tle — podgląd na żywo

```powershell
python tools/devbot/devbot.py start
```

Uruchamia bota bez otwartego terminala. Bot startuje lokalną aplikację w Dockerze:

- aplikacja: http://127.0.0.1:8787
- postęp, wyniki testów i ostatni raport: http://127.0.0.1:8787/__devbot
- pierwsze logowanie w nowej bazie: `admin` / `admin`

Podgląd ma własną bazę i wolumeny Docker (`new-glpi-preview`), dostępne tylko
lokalnie porty 8787 i 18765. Nie wymaga certyfikatów. Pierwsze uruchomienie
naprawia błędny fabryczny hash hasła `admin` tylko w bazie podglądu;
nie nadpisuje hasła zmienionego przez użytkownika. Pierwszy start
buduje obraz i pobiera PostgreSQL, więc może potrwać kilka minut.
Po każdym cyklu z udanymi testami bot buduje i uruchamia nową wersję.
Przeglądarka sprawdza ją co 3 sekundy i odświeża stronę, odkładając odświeżenie,
gdy kursor znajduje się w polu formularza. W trakcie restartu API może być
przez chwilę niedostępne. Zmiany widoczne są po całym cyklu, nie po każdym
zapisaniu pliku. Początkowy start pokazuje bieżący kod z dysku.

```powershell
# Sama aplikacja, bez pracy modelu (uruchamia lub aktualizuje podgląd)
python tools/devbot/devbot.py preview
# Zatrzymanie bota; aplikacja nadal działa
python tools/devbot/devbot.py stop
# Po zatrzymaniu bota: wyłączenie podglądu, bez usuwania danych
python tools/devbot/devbot.py preview-stop
```

Log uruchomienia bota: `.devbot/supervisor.stdout.log` i `.stderr.log`.
Log budowy aplikacji: `.devbot/preview-build.stderr.log`.
`preview_enabled: true` w konfiguracji włącza podgląd także dla `run` i `once`.
Komenda `check` wykonuje tylko testy. Komputer i Docker muszą pozostać włączone.
Po restarcie komputera ponownie uruchom `start`; bot i serwer podglądu
nie są instalowane jako usługi systemowe.

Lokalny bot korzysta z Codex CLI zalogowanego przez ChatGPT. Wykonuje większe,
spójne etapy z `BACKLOG.md`, zgodnie z `PRODUCT.md` i kierunkiem wizualnym w `DESIGN.md`.
Zleca zmiany i testy, a następnie samodzielnie sprawdza
wynik poleceniami testowymi. Po udanym cyklu przechodzi do kolejnego. Gdy
wyczerpie kolejkę, szuka uzasadnionego usprawnienia istniejącej aplikacji.

## Uruchomienie na Windows

Wymagania: Python 3.11+, Node.js 22+, Git, Codex CLI i uruchomiony Docker Desktop z silnikiem
Linux. Domyślne testy działają w Dockerze, więc lokalne Go nie jest wymagane.
Pierwsze testy potrzebują internetu do pobrania obrazu i zależności Go.

W katalogu projektu:

```powershell
codex.cmd login
python tools/devbot/devbot.py doctor
python tools/devbot/devbot.py run
```

`codex.cmd` omija problem blokowania npm-owego skryptu `codex.ps1` przez
politykę wykonywania PowerShell. Bot sam wybiera ten wariant na Windows.
Na Linux użyj `codex login` i `python3` zamiast `python`.

Proces działa aż do zatrzymania albo błędu wymagającego interwencji. Komputer
musi pozostać włączony, a proces uruchomiony. Zamknięcie terminala lub restart
komputera może zakończyć proces; ponowne `run` odczytuje zapisany stan.
Bot nie instaluje automatycznego startu systemowego.

## Sterowanie

```powershell
# Jeden cykl bez zapętlenia; respektuje zapisany czas oczekiwania
python tools/devbot/devbot.py once

# Stan, ostatni raport, logi testów i czas kolejnej próby (Unix timestamp)
python tools/devbot/devbot.py status

# Zatrzymanie, także podczas oczekiwania lub aktywnego zadania
python tools/devbot/devbot.py stop

# Same testy aplikacji, bez użycia modelu i bez zmiany terminu wznowienia bota
python tools/devbot/devbot.py check

# Testy samego bota; nie zużywają limitu Codex
python -m unittest discover -s tools/devbot -p "test_*.py" -v
```

Możesz też zatrzymać proces przez Ctrl+C. Zatrzymanie w trakcie edycji pozostawia
niedokończone zmiany; kolejny cykl dostaje instrukcję ich sprawdzenia i dokończenia.
Blokada systemowa zapobiega uruchomieniu dwóch kopii bota w tym samym katalogu.

## Limity i wznowienie

- Bot pracuje w pętli bez limitu liczby cykli, dopóki ma dostęp do modelu.
- Błąd limitu uruchamia oczekiwanie: domyślnie 15 minut, potem 30 i 60 minut.
  Następne próby następują co godzinę. Jeśli błąd zawiera obsługiwany czas
  `resets_at`/`reset_at` (Unix timestamp) lub `try again in …`, bot respektuje
  również ten termin, nawet gdy jest późniejszy.
- Kolejna próba jest rzeczywistym wznowieniem pracy. Bot nie korzysta z
  nieudokumentowanego endpointu sprawdzającego saldo. Nie gwarantuje zużycia
  dokładnie 100% tokenów ani wznowienia dokładnie w sekundzie odnowienia limitu.
- Nowy proces odczytuje zapisany termin i nie ponawia żądań przed jego upływem.
  Nowy cykl rozpoczyna świeży kontekst z kolejką, bieżącymi zmianami i wskazaniami
  poprzednich logów; nie odtwarza całej rozmowy z poprzedniej sesji.
- Błędy logowania i rozliczeń zatrzymują pracę. Inne błędy (także testów) mają
  najwyżej trzy kolejne próby, aby nie powtarzać bez końca tej samej awarii.
  Po usunięciu przyczyny uruchom ponownie `run`.
- Wymuszone jest logowanie ChatGPT; bot nie przełącza się na płatny klucz API.
  Obowiązują limity i ustawienia rozliczeń Twojego konta.

## Zadania, testy i wyniki

Edytuj `tools/devbot/BACKLOG.md`, aby ustalić kolejność i kierunek prac.
Aktualne priorytety to nowe funkcje, badanie bezpieczeństwa i naprawy podatności,
niezawodność oraz wygląd. Potwierdzone pilne podatności i blokujące błędy
naprawiane są w pierwszej kolejności. Ustalenia audytu trafiają do
`docs/SECURITY_REVIEW.md`; testy dynamiczne dotyczą wyłącznie lokalnych danych testowych.
Model aktualizuje dziennik, a niezależna kontrola supervisora decyduje, czy
cykl przeszedł testy. Sam znacznik wykonania zadania w kolejce nie jest dowodem
przejścia tej kontroli.

`config.json` pozwala wybrać model (`null` = bieżący model CLI), okresy czekania
oraz timeouty. Supervisor najpierw uruchamia testy panelu Node.js.
`test_runner: "docker"` uruchamia następnie `go test -count=1 ./...`,
`go vet ./...`, kompilację serwera Linux i agentów Linux/Windows. Każdy cykl
wymusza ponowne wykonanie warstwy testów. Wariant `"go"` wymaga Go w PATH
i sprawdza testy, vet oraz kompilację na bieżącym systemie. Kontrola nie obejmuje
automatycznie interakcji w przeglądarce ani integracji z produkcyjną bazą.

Stan i logi są w ignorowanym przez Git i Docker katalogu `.devbot/`:

- `state.json`: faza pracy, następna próba, wyniki i ścieżki logów;
- `runs/<cykl>/report.md`: ostatni raport modelu;
- `runs/<cykl>/codex.stdout.log`: zdarzenia JSONL, w tym raportowane zużycie;
- `runs/<cykl>/test-*.stdout.log` i `test-*.stderr.log`: wyniki testów.

Logi są lokalne, mogą zawierać fragmenty kodu i narastają z każdym cyklem.
Raportowane zużycie ostatniej sesji nie jest pozostałym saldem konta.

Bot edytuje bieżący katalog projektu. Przed długą pracą warto zapisać własne
zmiany w Git i pracować na osobnej gałęzi. Instrukcja bota wyklucza commit,
push, deploy i komendy na zarządzanych hostach; zmiany pozostają do przeglądu.
Codex działa w `workspace-write` z `approval=never`, więc czynności wymagające
szerszych uprawnień kończą się odmową. Instrukcje w prompcie nie są izolacją
systemową. Testy są wykonywane przez lokalnego supervisora z jego uprawnieniami.

Mechanizm wykorzystuje udokumentowane `codex exec --json` i zapis raportu:
[oficjalna dokumentacja OpenAI](https://learn.chatgpt.com/docs/non-interactive-mode).
