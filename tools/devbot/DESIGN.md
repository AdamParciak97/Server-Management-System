# Kierunek wizualny panelu SMS

Priorytet użytkownika: aplikacja ma robić wrażenie graficznie, a bot ma wykonywać
większe etapy rozwoju. Jeden cykl to dopracowany widok lub spójny przepływ,
obejmujący układ, detale, interakcje i responsywność. Nie pojedyncza kosmetyczna poprawka.

## System wizualny

- Zachowaj kierunek z `server/static/css/console.css`: grafitowe powierzchnie,
  miętowy akcent, czytelna typografia, subtelne obramowania. Czerwony i bursztynowy
  oznaczają ryzyko; nie używaj ich jako losowych ozdób.
- Sidebar, topbar i ekran logowania są wspólne. Rozwijaj istniejący system,
  nie twórz osobnych stylów dla każdego widoku.
- Ikony: sprite `server/static/icons.svg` i `UI.icon()`; bez emoji, bibliotek CDN
  i zewnętrznych fontów. Wszystko ma działać offline.
- Mocna hierarchia: tytuł, krótkie objaśnienie, główna akcja, najważniejsze dane,
  szczegóły. Unikaj ściany kilkunastu równorzędnych kart.
- Puste stany wyjaśniają skąd pochodzą dane i pokazują działającą następną akcję.
  Nie wstawiaj wymyślonych statystyk, wykresów trendu ani statusu „healthy” bez danych.
- Tabele, filtry, szczegóły i modale mają korzystać ze wspólnych tokenów i klas.
- Sprawdzaj desktop i szerokość 390 px: przewijanie tabel wewnątrz kontenera,
  brak poziomego przewijania całej strony, działająca nawigacja mobilna.
- Stany hover/focus/disabled/loading/error, etykiety formularzy, klawiatura,
  kontrast i `prefers-reduced-motion` są częścią ukończonego widoku.

## Weryfikacja i tempo

Czytaj tylko odpowiednie pliki oraz ostatni raport. Backlog czytaj od góry;
historyczny dziennik nie jest potrzebny w całości przy każdym cyklu.
Grupuj odczyty. Kończ etap sprawdzeniem Node i składni, a testy Go i Docker
pozostaw supervisorowi. Nie zmieniaj konfiguracji, supervisora ani mechanizmu
podglądu w trakcie automatycznych cykli.

Raportuj po polsku: co użytkownik zobaczy, co działa, jakie testy wykonano.
