# Bezpieczeństwo i prywatność

## Gdzie są Twoje dane

| Dane | Gdzie |
|---|---|
| Glukoza, insulina, węglowodany | Twój Nightscout oraz kopia na **Twoim** serwerze Mellis |
| Posiłki, zdjęcia, rozmowy, ustawienia | **Twój** serwer Mellis |
| Klucze zdalnego sterowania Trio i Loopa (Shared Secret, kod Loopa, `.p8`) | pęk kluczy na telefonie opiekuna, **nigdy na serwerze** |
| Klucz powiadomień APNs | Twój serwer: służy tylko do powiadomień, nie wyśle polecenia do pętli |
| Pytania do AI z potrzebnym fragmentem danych | dostawca AI, którego wybrałeś (Anthropic albo OpenAI) |

Autorzy Mellisa **nie mają dostępu do niczego**: nie ma centralnego serwera, kont ani analityki.

!!! info "Dostawcy AI"
    Według swoich obecnych zasad Anthropic i OpenAI domyślnie nie uczą modeli na danych wysyłanych przez API.
    Sprawdź ich aktualne zasady. Mellis wysyła do AI rok urodzenia podopiecznego i dane potrzebne do odpowiedzi,
    bez imienia (chyba że sam je wpiszesz w pytaniu), nigdy kluczy ani tokenów.

## Jak telefony rozpoznają się na serwerze

- Nie ma haseł do zgadnięcia ani wykradzenia. Każdy telefon ma własny klucz w **Secure Enclave**, czyli części
  iPhone'a, z której klucza nie da się skopiować.
- Zaproszenie działa 7 dni i tylko raz, a właściciel może je cofnąć. Kod do połączenia kolejnego telefonu tej samej
  osoby działa 10 minut.
- Właściciel widzi wszystkie połączone telefony i może każdy odłączyć jednym stuknięciem.

## Zdalny bolus

- **Każde polecenie wymaga Face ID** i jest podpisane osobnym kluczem, który działa tylko po Face ID (kod
  telefonu go nie zastąpi).
- Zanim telefon wyśle polecenie, pokazuje je serwerowi. Serwer sprawdza podpis i zapisuje polecenie w historii.
  Bez ważnego podpisu Mellis polecenia nie wyśle.
- Podpis obejmuje imię podopiecznego i dawkę: polecenie dla jednej osoby nie trafi do drugiej.
- Samo polecenie idzie z telefonu prosto do pętli przez powiadomienia Apple. Trio i Loop same sprawdzają swoje
  limity.
- Zgodę na zdalny bolus daje tylko właściciel, a druga osoba potwierdza ją Face ID.

## Twój serwer

- Instalator ustawia HTTPS i otwiera na zewnątrz tylko to, co potrzebne.
- Token Nightscouta jest tylko do odczytu i jest przechowywany w bazie w postaci zaszyfrowanej.
- Aktualizuj serwer: nowe wersje zawierają też poprawki bezpieczeństwa.

## Prognoza glukozy

Prognoza w Mellisie to prognoza Twojej pętli (Trio albo Loopa), bez dodatkowych korekt. Na karcie Bolus Mellis
dodaje do niej tylko działanie wpisanej insuliny i węglowodanów, liczone z ISF i ICR, i zakłada, że pętla nic więcej
nie zmieni. To przybliżenie, nie obietnica: decyzję o dawce podejmujesz Ty.

## Znalazłeś lukę?

Nie zgłaszaj jej publicznie. Napisz przez **Security → Report a vulnerability** na stronie projektu na GitHubie.
