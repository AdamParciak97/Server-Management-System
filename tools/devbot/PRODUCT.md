# Rozwój pełnego produktu

Użytkownik oczekuje równocześnie nowych funkcji, dobrego interfejsu, bezpieczeństwa
i niezawodności. Sam redesign nie zamyka zadania. Pracuj w większych, spójnych etapach.

## Wybór następnego etapu

1. Najpierw napraw potwierdzone błędy krytyczne/wysokiego ryzyka i nieprzechodzące testy.
2. Następnie realizuj kolejkę funkcji i bezpieczeństwa z początku BACKLOG.md.
3. Gdy pilne błędy są zamknięte, przeplataj funkcje, audyt/niezawodność i UX.
   Nie wybieraj w nieskończoność samych kosmetycznych zmian.
4. Sprawdź istniejącą implementację przed dodaniem funkcji. Rozwijaj ją zamiast
   tworzyć drugi system użytkowników, harmonogramów, alertów czy raportów.
5. Gdy etap jest zablokowany zewnętrznie, zapisz dowód i wybierz niezależne zadanie.
   Nie powtarzaj tego samego błędu narzędzia przez cały cykl.

## Co oznacza ukończona funkcja

- Działający przepływ UI → API → baza/agent, z autoryzacją i walidacją na serwerze.
- Obsługa błędów, stanu pustego i ładowania, czytelny interfejs zgodny z DESIGN.md.
- Migracje kompatybilne z istniejącymi danymi; brak resetowania bazy.
- Testy zachowania, w tym odmowy dostępu i próby wejścia poza scope.
- Dokumentacja użycia i ograniczeń. Bez mocków udających działający produkt.
- Niezależne testy supervisora. Sam wpis w backlogu nie potwierdza ich sukcesu.

## Badanie bezpieczeństwa

Przeglądaj zaufanie do agentów, JWT/sesje, uprawnienia i zakresy grup, IDOR,
XSS, SQL/command injection, upload/download i ścieżki plików, SSRF, sekrety,
rate limiting, limity rozmiaru żądań, audyt, konfigurację TLS i zależności.
Utrzymuj `docs/SECURITY_REVIEW.md`: identyfikator, priorytet, dowód, wymagane
warunki, wpływ, poprawka i rzeczywisty test. Oddziel potwierdzone błędy od podejrzeń.
Nie deklaruj braku podatności na podstawie samego przejścia testów lub skanera.

Testy dynamiczne wyłącznie w lokalnym podglądzie/izolowanych kontenerach,
na syntetycznych danych i kontach. Nie skanuj zarządzanych hostów, sieci firmowej
ani usług zewnętrznych. Nie wykonuj prawdziwych poleceń na agentach w testach.
Nie odczytuj realnych sekretów; certyfikaty i klucze testowe generuj jako fixture.
Skan zależności powinien korzystać z aktualnej bazy podatności, a raport wskazywać
datę, wersję narzędzia i zakres. Jeśli brak sieci uniemożliwia skan, zapisz to.
Nie zmieniaj uprawnień supervisora i nie obchodź sandboxa.

## Gotowość do wdrożenia

Pozostają wymagane: konfiguracja bez domyślnych sekretów, bezpieczny pierwszy
administrator, kopia i odtworzenie bazy oraz plików, test migracji, instrukcja
aktualizacji/rollback, kontrola zdrowia, retencja i limity danych, obserwowalność,
skan zależności i testy integracyjne. Lokalny podgląd nie jest dowodem gotowości
produkcyjnej. Nie wdrażaj na produkcję w ramach automatycznych cykli.
