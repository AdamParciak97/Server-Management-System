# Plan ukończenia bieżącej wersji

Stan na 20 października 2026. Zakres obejmuje domknięcie istniejących funkcji,
weryfikację bezpieczeństwa i przygotowanie sprawdzonego procesu wydania.
Estymaty oznaczają godziny aktywnej pracy wraz z poprawkami i testami.

| Etap | Zakres i warunek ukończenia | Szacunek |
| --- | --- | --- |
| 1. Polecenia | Dokończenie rozpoczętej migracji 014 i obsługi zleceń; wyniki dla każdego celu, ponawianie po utracie odpowiedzi bez duplikatów, trwały zapis wyniku i alertu. Testy błędów, ponowień i współbieżności. | 4–6 h |
| 2. PostgreSQL | Izolowana baza i powtarzalne testy migracji, rollbacku, sesji, tokenów, zakresów dostępu, inwentaryzacji, ustawień i paczek. Testy integracyjne wykonują się bez pomijania z powodu braku konfiguracji. | 5–8 h |
| 3. Agent i uprawnienia | Lokalna rejestracja mTLS, wygasłe i obce certyfikaty, współbieżne zużycie/unieważnienie tokena, pełna macierz tras HTTP dla ról i zakresów, przenoszenie hostów między grupami. | 4–6 h |
| 4. Konta, audyt i panel | Dokończenie administracji kontami/uprawnieniami i filtrów audytu; synchronizacja sesji między kartami. Kontrola głównych przepływów w przeglądarce przy 1440 i 390 px, klawiatury, dialogów i błędów. | 5–8 h |
| 5. Konfiguracja i zależności | Pierwszy administrator, sekrety, zaufane proxy, limity logowania i audyt. Aktualny skan zależności/obrazów, ocena wyników i poprawki potwierdzonych problemów blokujących wydanie. | 3–5 h |
| 6. Odtwarzanie i aktualizacja | Backup oraz odtworzenie bazy i uploadów na osobnych wolumenach, sprawdzenie aktualizacji i rollbacku, retencja danych, limity magazynu i osierocone pliki. Instrukcja odtworzona w praktyce. | 5–9 h |
| 7. Odbiór | Pełny zestaw testów, kompilacja serwera i obu agentów, kontrola czystej instalacji oraz głównych przepływów, aktualna dokumentacja i zamknięta lista usterek blokujących wydanie. | 2–4 h |
| **Razem** | **Bieżący zakres wydania** | **28–46 h** |

To około 4–6 dni przy ośmiu godzinach efektywnej pracy dziennie. Oczekiwanie
na limity, awarie połączenia i dostępność narzędzi wydłuża czas kalendarzowy.
Nowe istotne ustalenia bezpieczeństwa wymagają ponownej estymacji.

## Kolejność

Najpierw kończymy rozpoczęty przepływ poleceń oraz uruchamiamy izolowaną bazę.
Następnie zamykamy weryfikację dostępu i agentów, konta oraz panel, konfigurację
i odtwarzanie. Ostatni etap dotyczy kompletnej wersji z poprzednich etapów.

Dotychczasowe wpisy „implementacja gotowa” w backlogu pozostają otwarte do
uzyskania brakujących dowodów integracji i kontroli przeglądarkowej.
Zaliczenie testów jednostkowych nie zastępuje tych kontroli.

## Koniec zakresu

Wersja jest ukończona po spełnieniu kryteriów wszystkich siedmiu etapów.
Nowe funkcje i dodatkowe usprawnienia trafiają do kolejnego wydania.
Automatyczny tryb rozwoju obecnie szuka kolejnych usprawnień po opróżnieniu
backlogu; zamknięcie tej listy jest kryterium zatrzymania prac nad tą wersją.
