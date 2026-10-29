# Mellis — zasady logo

## 1. Znak
**Idea:** koliber zawisa w powietrzu i sięga dziobem dokładnie po to, czego potrzebuje. Bursztynowa kropka to odczyt
glukozy. Mellis robi to samo: jest precyzyjny, spokojny i pojawia się we właściwym momencie.

| Wersja | Plik | Do czego |
|---|---|---|
| Ikona aplikacji | `app-icon.svg`, `app-icon-dark.svg`, `png/app-icon*.png` | iOS (AppIcon), wersja ciemna systemu |
| Ikona TEST | `app-icon-test.svg`, `app-icon-test-dark.svg` | aplikacja testowa (AppIcon-Test) |
| Znak (mały) | `mark.svg`, `mark-on-dark.svg`, `mark-black.svg`, `mark-white.svg` | obok nazwy, nagłówki, `Logo` w aplikacji |
| Koliber (duży) | `bird.svg`, `bird-on-dark.svg`, `bird-black.svg` | duże formaty: strona, druk, prezentacje |
| Logo poziome | `logo-horizontal.svg`, `-on-dark`, `-black`, `png/logo-horizontal*.png` | dokumenty, strona, stopki |
| Web | `web/favicon.ico`, `web/favicon.svg`, `web/apple-touch-icon.png`, `web/icon-192.png`, `web/icon-512.png` | przeglądarka, PWA |

Znak mały i koliber duży to ten sam ptak. W małym zostaje jedno pióro i grubszy dziób, żeby był czytelny od 24 px.
Poniżej 64 px zawsze używaj znaku małego.

## 2. Pole ochronne
Wokół logo zostaw wolne miejsce równe **wysokości głowy kolibra**. Pole rośnie i maleje razem z logo.

## 3. Minimalny rozmiar
| Wersja | Ekran |
|---|---|
| Logo poziome | 120 px szerokości |
| Znak mały | 20 px (favicon: `web/favicon.ico`) |
| Koliber duży | 64 px |

## 4. Kolory
| Nazwa | HEX | Rola |
|---|---|---|
| Petrol | `#0E5A61` | kolor główny: ptak, tło ikony |
| Turkus | `#14B8A6` | skrzydło |
| Jasny turkus | `#A7F3E6` | skrzydło na ciemnym tle ikony |
| Bursztyn | `#FFB547` | kropka (odczyt): **tylko kropka**, nigdy inne elementy |
| Atrament | `#0B3A3F` | napis „Mellis” na jasnym tle |
| Petrol nocny | `#0A2B2F` | tło ikony w trybie ciemnym |
| Mięta | `#E6FFFA` | ptak na ciemnym tle |

Dozwolone pary logo i tła: kolor na białym, wersja `-on-dark` na petrolu lub czerni, czarna na białym, biała na
zdjęciu (tylko na spokojnym fragmencie).

## 5. Napis
Napis w plikach logo jest złożony z **Manrope** (licencja SIL OFL, wolno używać w logo) i zamieniony na krzywe.
„Mellis” jest w całości pogrubione (700, 112 px w plikach logo, na tej samej linii bazowej co dawny napis), zawsze
z wielkiej litery. Kropkę nad „i” zastępuje bursztynowy odczyt: koło w miejscu i wielkości kropki kroju.
Nazwa pochodzi od *diabetes mellitus* (łac. *mel*, miód), stąd dwa „l”.
W aplikacji napis jest tekstem systemowym (`BrandWordmark`): „Mellis” w kolorze tekstu z bursztynową kropką nad „ı”.
SF Pro nie wolno używać w plikach logo, bo licencja Apple pozwala na nią tylko w interfejsie.

## 6. Czego nie robić
Nie rozciągaj i nie ściskaj. Nie obracaj ptaka (zadarty dziób przestaje wyglądać jak koliber). Nie zmieniaj kolorów
spoza palety. Nie dodawaj cieni, obrysów ani gradientów. Nie przesuwaj kropki ani nie łącz jej z dziobem. Nie przepisuj
napisu ręcznie, tylko użyj pliku.

## 7. Pliki źródłowe
Kształty są budowane skryptem z węzłów o ciągłych stycznych. Wszystkie szczeliny mają tę samą szerokość, a pióra mają
długości 100/82/66%. 
