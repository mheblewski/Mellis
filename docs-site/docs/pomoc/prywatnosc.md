# Polityka prywatności

Mellis to oprogramowanie, które instalujesz u siebie: na własnym serwerze i na własnych iPhone'ach. Ta strona
opisuje, jakie dane Mellis zbiera, dokąd je wysyła i jak je usunąć.

!!! note "To nie jest porada prawna"
    Opisujemy, jak działa program. Jeśli nie wiesz, jakie obowiązki masz Ty, zapytaj prawnika.

## Kto odpowiada za dane

Za dane odpowiada osoba albo rodzina, która uruchomiła swój serwer Mellis. W rozumieniu RODO to ona jest
**administratorem danych**: decyduje, kogo zaprosić, którego dostawcę AI wybrać i jak długo trzymać dane.

Autorzy Mellisa **nie mają dostępu do Twoich danych**:

- nie ma centralnego serwera Mellisa ani kont u autorów,
- aplikacja i serwer nie mają analityki, telemetrii ani zbierania raportów o awariach,
- aplikacja łączy się tylko z Twoim serwerem i z Apple.

Dane o zdrowiu są danymi szczególnej kategorii, a często dotyczą osoby niepełnoletniej. To Ty decydujesz, czy
i komu je powierzasz (dostawcy serwera, dostawcy AI, innym opiekunom), i Ty za to odpowiadasz.

## Co jest na Twoim serwerze

| Dane | Skąd |
|---|---|
| Kopia odczytów glukozy, insuliny, węglowodanów i stanu pętli | pobierana z Twojego Nightscouta |
| Podopieczni (imię, rok urodzenia), opiekunowie, zaproszenia, połączone telefony | wpisujesz w aplikacji |
| Posiłki, zdjęcia posiłków, rozmowy z Mellisem, przypomnienia | wpisujesz w aplikacji |
| Historia poleceń zdalnego bolusu (dawka, kto, kiedy, podpis) | wysyłasz z telefonu |
| Ustawienia i klucze serwera (Nightscout, AI, APNs) | wpisujesz w instalatorze |

Serwer stoi u firmy, od której go wynajmujesz (albo u Ciebie w domu). Ta firma ma fizyczny dostęp do maszyny.

## Dokąd trafiają dane

### Nightscout

Mellis **tylko czyta** z Twojego Nightscouta: odczyty, wpisy pętli, profil i stan urządzeń. Niczego do niego nie
zapisuje. Token Nightscouta jest tylko do odczytu i leży w bazie zaszyfrowany.

### Dostawca AI

Pytania do Mellisa obsługuje dostawca, którego wybrałeś w instalatorze: **Anthropic** albo **OpenAI**. Serwer
wysyła mu:

- treść pytania albo wiadomości, w tym rozmowę, której ona dotyczy,
- dane potrzebne do odpowiedzi: odczyty, dawki, posiłki, ustawienia terapii, rodzaj pętli,
- **rok urodzenia** podopiecznego (żeby odpowiedź pasowała do wieku),
- zdjęcia, jeśli je dołączysz,
- Twoje „Instrukcje dla Mellisa”, jeśli je wpisałeś.

Mellis **nie wysyła imion** podopiecznych ani opiekunów, chyba że sam je wpiszesz w wiadomości albo instrukcjach.
Nigdy nie wysyła kluczy ani tokenów.

Jeśli na serwerze jest **klucz OpenAI**, to nawet przy Anthropic jako głównym dostawcy OpenAI dostaje też:

- nagrania głosowe do zamiany na tekst (nagranie nie jest zapisywane na serwerze),
- pytania do wyszukiwania w bazie wiedzy o cukrzycy (z wiekiem podopiecznego i rodzajem pętli).

Bez klucza OpenAI mowę na tekst zamienia iPhone (rozpoznawanie mowy Apple: na telefonie, gdy ten to obsługuje,
inaczej przez serwery Apple).

Dostawcy AI przechowują i przetwarzają te dane **według swoich zasad**. Mellis tego nie kontroluje i niczego tu
nie gwarantuje. Sprawdź aktualne zasady Anthropic i OpenAI dla API. Przy OpenAI Mellis nie wyłącza zapisywania
odpowiedzi po stronie OpenAI (dzięki temu kolejne pytania w rozmowie są tańsze).

### DiabCalc

Gdy Mellis liczy posiłek, może wyszukać produkty w publicznej bazie DiabCalc. Wysyła tylko **nazwę produktu**
(np. „chleb pszenny”), bez konta i bez danych o podopiecznym. Wyłączysz to, ustawiając na serwerze
`DIABCALC_MCP_URL=` (pusta wartość).

### Apple: powiadomienia

Powiadomienia idą przez serwery Apple (APNs). Ich treść widać na ekranie blokady, a może zawierać: wartość glukozy,
dawki i węglowodany, ilość insuliny w zbiorniku, imię podopiecznego (gdy telefon ma ich kilku), imię opiekuna („Opiekun Tomek podał…”)
i początek odpowiedzi Mellisa. Live Activity na ekranie blokady pokazuje glukozę, IOB, COB i stan pompy.
Serwer zna też tokeny powiadomień Twoich telefonów.

### Zdalny bolus (Trio, Loop)

Polecenie idzie **z telefonu opiekuna prosto do pętli** przez powiadomienia Apple, kluczem `.p8` rodziny. Serwer
Mellisa sprawdza i zapisuje polecenie, ale sam go nie wysyła.

Klucze zdalnego sterowania (Shared Secret Trio, kod QR Loopa, klucz `.p8`) są w **pęku kluczy telefonu**: tylko na
tym telefonie, bez synchronizacji iCloud. Na serwer nie trafiają. Gdy właściciel przekazuje je innemu opiekunowi,
telefon szyfruje je dla telefonu odbiorcy, a serwer przechowuje tylko zaszyfrowaną paczkę. Usuwa ją po odebraniu,
a nieodebraną po 7 dniach.

### Połączenie z serwerem

Aplikacja łączy się z serwerem przez HTTPS. Jeśli w instalatorze wybrałeś **Cloudflare Tunnel**, ruch przechodzi
przez Cloudflare.

## Jak długo dane są przechowywane

| Co | Jak długo |
|---|---|
| Dane na serwerze (odczyty, posiłki, rozmowy, zdjęcia, historia poleceń) | dopóki ich nie usuniesz. Usunięta rozmowa znika z aplikacji, ale zostaje w bazie |
| Nocne kopie zapasowe (baza, zdjęcia, rejestr kosztów AI, ustawienia bez kluczy) | 14 dni, potem serwer sam je kasuje |
| Dziennik zdarzeń bezpieczeństwa (połączenia i odłączenia telefonów, odmowy dostępu) | 180 dni |
| Rejestr kosztów AI | kwoty i liczba wywołań, bez treści pytań. Dopóki nie usuniesz serwera |
| Logi kontenerów | do 5 plików po 10 MB na usługę, starsze są nadpisywane |
| Kopie pobrane na Maca i kopia w `/opt/mellis-kopia` | dopóki sam ich nie usuniesz |

## Jak usunąć dane

1. **Serwer:** `mellis` → **Odinstaluj** → **Usuń wszystko**. Usuwa bazę, zdjęcia, ustawienia, klucze i nocne
   kopie. Usuń też ręcznie `/opt/mellis-kopia`, jeśli kiedyś wybrałeś „Zachowaj dane”, i kopie pobrane na Maca.
   Szczegóły: [Odinstalowanie](../utrzymanie/odinstalowanie.md).
2. **Telefon:** usuń ustawienia zdalnego sterowania w aplikacji (klucze w pęku kluczy mogą przetrwać usunięcie
   aplikacji), potem usuń aplikację.
3. **Dostawca AI:** usuń klucz `mellis` w konsoli Anthropic albo OpenAI. Dane, które dostawca już ma, usuniesz
   według jego zasad (u OpenAI także zapisane odpowiedzi).
4. **Nightscout** jest Twój i działa niezależnie od Mellisa: jego dane usuwasz u siebie.

## Strona z instrukcją

Ta instrukcja jest na GitHub Pages. Czcionki i skrypt do diagramów są na tej samej stronie: przeglądarka nie łączy
się z Google Fonts ani z innymi serwisami. Nie ma tu analityki ani ciasteczek. GitHub, który hostuje stronę, widzi
adres IP i przeglądarkę odwiedzającego, jak każdy serwer WWW.

## Kontakt

Błędy i pytania o program zgłaszaj na [GitHubie](https://github.com/mheblewski/Mellis/issues). Autorzy nie mają
Twoich danych, więc nie mogą ich udostępnić, poprawić ani usunąć: zrobisz to sam na swoim serwerze. O dane
zapisane u dostawcy AI pytaj tego dostawcę.

Zobacz też: [Bezpieczeństwo i prywatność](bezpieczenstwo.md).

## Wsparcie projektu

Przycisk „Wesprzyj Mellisa” w aplikacji i „Przybij piątkę” na tej stronie otwierają w przeglądarce stronę
[suppi.pl/mellis](https://suppi.pl/mellis). Mellis nie przekazuje tam żadnych danych. Jeśli zdecydujesz się wesprzeć
projekt, płatność i Twoje dane obsługuje Suppi według swojego regulaminu i polityki prywatności. Wsparcie jest
dobrowolne i nie odblokowuje żadnych funkcji.
