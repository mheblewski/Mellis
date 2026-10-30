# Jak Mellis proponuje dawki

Ta strona wyjaśnia, skąd bierze się dawka, którą widzisz na karcie **Bolus**, na karcie w rozmowie, przy drugiej
części rozłożonego bolusa i przy bolusie odłożonym na później. Wszystko poniżej liczy serwer Mellis według stałych
zasad, bez AI. AI może dawkę wyjaśnić albo zaproponować inną, ale ta sama kontrola sprawdza każdą dawkę przed
wysłaniem.

!!! warning "Ty decydujesz"
    Mellis to projekt DIY, nie wyrób medyczny. Propozycja dawki to podpowiedź, nie zalecenie lekarza. Zanim wyślesz
    bolus, spójrz na glukozę, wykres i to, ile węglowodanów naprawdę ma posiłek. Możesz dawkę zmienić, wpisać własną
    albo nic nie wysłać. Maksymalny bolus i inne limity nadal pilnuje Twoja pętla (Trio albo Loop).

## Dwie liczby: przelicznik i kalkulator

Mellis liczy dawkę na dwa sposoby i porównuje wyniki.

**Dawka z przelicznika** to węglowodany podzielone przez ICR z pory posiłku:

```
dawka z przelicznika = węglowodany / ICR
```

**Kalkulator** liczy tak jak kalkulator bolusa w Trio. Bierze pod uwagę także to, co już się dzieje w organizmie:

```
kalkulator = (węglowodany + COB) / ICR
           + (glukoza + trend z 15 min − cel) / ISF
           − aktywna insulina (IOB)
```

- **COB** to węglowodany z wcześniejszych posiłków, które jeszcze się wchłaniają. Ich bolus jest już w IOB, więc
  bez COB kalkulator odjąłby tę insulinę drugi raz. Mellis liczy najwyżej 120 g COB, tyle co domyślny limit Trio.
- **Trend** to zmiana glukozy przewidywana na najbliższe 15 minut według sensora. Przy spadku obniża wynik, przy
  wzroście go podnosi.
- **ISF i cel** pochodzą z ostatniego obliczenia pętli, więc uwzględniają też cel tymczasowy, np. 150 przy wysiłku.
  Jeśli pętla ich nie podała, Mellis bierze je z profilu: za cel uznaje środek zakresu. Cel jest zawsze
  ograniczony do przedziału **80–250 mg/dL**.
- **Aktywna insulina (IOB)** to insulina z wcześniejszych bolusów i z SMB, która jeszcze działa. Ujemne IOB
  (np. gdy pętla wstrzymała bazę) jest liczone jako 0: nie jest powodem, żeby dać więcej insuliny.

Kalkulator działa tylko na świeżych danych: odczyt glukozy z ostatnich 15 minut i obliczenie pętli dla tego odczytu.
Jeśli ich nie ma, Mellis zostaje przy dawce z przelicznika, a pod dawką widać „Z przelicznika — kalkulator
niedostępny”.

## Mellis może dawkę tylko obniżyć

Proponowana dawka to **mniejsza** z tych liczb:

- dawka z przelicznika,
- wynik kalkulatora,
- dawka obniżona na spadek glukozy (niżej).

Mellis nigdy nie wpisuje więcej niż dawka z przelicznika. Jeśli kalkulator mówi „więcej”, bo glukoza jest
wysoka, Mellis i tak zostaje przy dawce z przelicznika. Korektę na wysoką glukozę dodaje tylko wtedy, gdy o nią
poprosisz: w rozmowie albo przyciskiem ± na karcie Bolus (niżej, „Korekta do wyboru”).

Na koniec dawka jest **zaokrąglana w dół** do kroku pompy, np. do 0,05 j. Nigdy w górę.

!!! example "Przykład: Ala, obiad 40 g"
    Wymyślone ustawienia: ICR 10 g/j, ISF 50 mg/dL na 1 j, cel 100 mg/dL.

    Glukoza 130 mg/dL, stała, prognoza pętli nie schodzi poniżej celu. Aktywna insulina 1,5 j, COB 0 g.

    - Z przelicznika: 40 / 10 = **4 j**.
    - Kalkulator: 40 / 10 + (130 − 100) / 50 − 1,5 = 4 + 0,6 − 1,5 = **3,1 j**.

    Mellis proponuje 3,1 j, a pod dawką pisze: „↓ 0,9 j mniej niż z przelicznika (4 j): aktywna insulina”.

    Gdyby glukoza wynosiła 220 mg/dL, stała, a insulina z wcześniejszych bolusów już nie działała, kalkulator dałby
    4 + (220 − 100) / 50 = 6,4 j. Mellis i tak zaproponuje 4 j z przelicznika.

## Gdy glukoza spada

Gdy glukoza spada albo prognoza pętli schodzi poniżej celu, część posiłku i tak „pokryje” ten spadek. Mellis
szacuje, ile gramów na to pójdzie, i proponuje insulinę tylko na resztę węglowodanów. Patrzy przy tym na:

- prognozę pętli za ok. 1,5 godziny w porównaniu z celem,
- najniższy punkt prognozy w najbliższej godzinie w porównaniu z 80 mg/dL,
- węglowodany, o które prosi Trio (carbsReq),
- bez prognozy pętli: trend sensora na najbliższe 30 minut.

Wygrywa największa potrzeba. Kiedy na spadek pójdzie mniej niż 2 g, dawka się nie zmienia. Gdy glukoza spada szybko
(o 2 mg/dL na minutę albo szybciej) i jest nie wyższa niż 150 mg/dL, Mellis podpowiada, żeby podać bolus na koniec
posiłku albo po kontroli za 15–20 minut. Możesz też odłożyć bolus: Mellis przypomni o nim, gdy glukoza przestanie
spadać.

## Gdy glukoza jest niska: najpierw węglowodany

Gdy glukoza jest poniżej **70 mg/dL** albo pętla przewiduje spadek poniżej 70 mg/dL w ciągu ok. 30 minut, proponowana
dawka to **0 j**. Mellis podpowiada najpierw szybkie węglowodany (sok, glukoza), a insulinę dopiero po wzroście
glukozy. Tak samo jest, gdy ostatni odczyt był poniżej 70, ale ma już kilkadziesiąt minut (do godziny): niski odczyt,
który nie jest świeży, to nie powód, żeby o nim zapomnieć.

Insulinę możesz wtedy podać, ale tylko po osobnym potwierdzeniu: przed Face ID pojawia się okno „Glukoza jest niska”
z przyciskiem **Podaj insulinę mimo niskiej glukozy**. Serwer odrzuca taką insulinę bez tego potwierdzenia. Same
węglowodany nigdy nie są blokowane.

## Linia pod dawką i ⓘ

Pod dawką jest jedna krótka linia:

- „Z przelicznika”, gdy dawka jest równa dawce z przelicznika,
- „↓ X j mniej niż z przelicznika (Y j): powód”, gdy Mellis ją obniżył. Powód to ten, który obniżył dawkę
  najbardziej: **aktywna insulina**, **glukoza spada**, **glukoza poniżej celu**, **prognoza poniżej celu** albo
  **niska glukoza — najpierw węglowodany**.

Ikona ⓘ obok linii pokazuje pełne wyliczenie: dane, z których skorzystał kalkulator, i wzór, np. „40 g / ICR 10 +
(130 − 100) / 50 − IOB 1,5 j = 3,1 j”. Stamtąd prowadzi też link na tę stronę.

## Przycisk ± na karcie Bolus

Gdy kalkulator obniżył dawkę, w rogu pola insuliny jest przycisk ±:

- **wypełniony**: w polu jest dawka z kalkulatora,
- stuknij go, a w polu pojawi się dawka z przelicznika. Przycisk zmieni się na pusty, a linia pod dawką powie, o ile
  ta dawka jest większa niż z kalkulatora i dlaczego, np. „Z przelicznika: 0,9 j więcej niż kalkulator (aktywna
  insulina)”,
- stuknij jeszcze raz, żeby wrócić do dawki z kalkulatora. Tak samo wrócisz do niej po wpisaniu własnej dawki.

Wybór dawki z przelicznika to Twoja decyzja. Jeśli ta dawka jest dużo większa niż wynik kalkulatora, przy wysyłaniu
zobaczysz ostrzeżenie (niżej).

Ten sam przycisk ma drugi tryb: korektę do wyboru (następny rozdział). Naraz działa tylko jeden z nich. Gdy kalkulator
obniżył dawkę, przycisk zawsze działa tak jak wyżej.

## Korekta do wyboru (przycisk ±)

Gdy glukoza jest wysoka i nic nie wskazuje na spadek, Mellis może zaproponować **połowę korekty**. Nigdy nie wpisuje
jej sam: w polu zostaje zwykła dawka, przycisk ± w rogu pola insuliny jest **pusty**, a pod dawką widać np. „Korekta
do wyboru: +0,2 j (±)”. Stuknij go, a w polu pojawi się dawka z korektą, przycisk się wypełni, a linia pod dawką powie,
ile dodano. Dlaczego (glukoza, trend, aktywna insulina, wzór) jest pod ⓘ. Stuknij jeszcze raz, żeby wrócić do dawki
bez korekty.

**Bez węglowodanów (0 g)**, czyli sama korekta:

```
korekta = 0,5 × ((glukoza + trend z 15 min − cel) / ISF − aktywna insulina)
```

COB nie jest tu liczone. Pod dawką widać np. „+0,2 j korekty (połowa)”, a pod ⓘ m.in. „glukoza 210 i rośnie, aktywna
insulina 0,3 j”. Na karcie Bolus można wtedy wysłać samą insulinę, tak jak dotąd.

**Do posiłku**:

```
dawka z korektą = węglowodany / ICR + 0,5 × ((glukoza − cel) / ISF − aktywna insulina)
```

Trend i COB nie są tu liczone. Pod dawką widać np. „+0,2 j korekty do przelicznika (połowa)”, a pod ⓘ m.in. „glukoza
190, aktywna insulina 0,1 j”.

W obu przypadkach:

- korekta to najwyżej **1 j**,
- wynik jest zaokrąglany **w dół** do kroku pompy (np. 0,1 j), a przycisk pojawia się dopiero, gdy korekta to co
  najmniej jeden krok,
- cel, ISF i aktywna insulina są te same co w kalkulatorze (ujemne IOB liczy się jako 0),
- ⓘ pokazuje glukozę, trend, aktywną insulinę, cały wzór z liczbami i dlaczego tylko połowa.

### Kiedy Mellis nie proponuje korekty

Przycisk ± w tym trybie się nie pokazuje, gdy zachodzi którykolwiek z warunków:

- glukoza poniżej **150 mg/dL** (w nocy, od 0:00 do 6:00 w strefie czasowej profilu: poniżej **180 mg/dL**),
- glukoza spada (trend z 15 minut poniżej 0); do posiłku także, gdy rośnie szybciej niż o 30 mg/dL na 15 minut,
- w ostatnich **90 minutach** był bolus, zdalny bolus albo SMB (od 0,1 j), albo historii bolusów nie da się odczytać,
- bez węglowodanów: w ostatnich **2 godzinach** wpisano węglowodany (albo nie da się tego sprawdzić),
- odczyt glukozy albo obliczenie pętli ma więcej niż **15 minut**,
- najniższa prognoza pętli (minPredBG) jest poniżej **54 mg/dL** (do posiłku: poniżej **100 mg/dL**), albo pętla
  jej nie podała,
- glukoza jest niska albo zaraz będzie (zasada „najpierw węglowodany”),
- w ostatnich **30 minutach** glukoza spadała (o 10 mg/dL na 15 minut albo szybciej), był odczyt poniżej 70,
  Mellis obniżył dawkę na spadek albo wysłano węglowodany na niedocukrzenie,
- kalkulator obniżył dawkę (wtedy przycisk działa w trybie obniżania),
- to druga część rozłożonego bolusa albo bolus odłożony,
- kalkulator jest niedostępny.

### Dlaczego tylko połowa

Pętla sama koryguje wysoką glukozę: podnosi bazę i daje SMB. W godzinach z bardzo małą bazą (np. 0,05 j/h) Trio
często nie może dać SMB, bo jego limit SMB wynosi wtedy 0. Dlatego korekta zostaje w rękach opiekuna. Pełna korekta
(ani insulinReq pętli) nie jest proponowana, bo pętla i tak doda swoją insulinę, gdy tylko będzie mogła. Zasady
dobrano ostrożnie, na podstawie przeglądu dwóch tygodni danych: pełna korekta i insulinReq pętli wyraźnie częściej
prowadziły tam do szacowanych niedocukrzeń niż połowa korekty z tymi warunkami. Przegląd nie jest badaniem
klinicznym. To wciąż Twoja decyzja: patrz na wykres i na to, czy niedawno nie było posiłku lub bolusa, którego Mellis
nie widzi.

## Ostrzeżenia przed wysłaniem

Przy wysyłaniu serwer liczy wszystko jeszcze raz, na najnowszych danych. Te ostrzeżenia trzeba przeczytać
i potwierdzić, zanim dawka pójdzie do pętli:

| O czym ostrzega | Kiedy się pojawia |
|---|---|
| **Dawka większa niż z danych** | dawka jest większa od wyniku kalkulatora o co najmniej 0,5 j albo o co najmniej 25 % tego wyniku (większa z tych wartości). Dotyczy dawki wpisanej ręcznie, wybranej przyciskiem ± i zaproponowanej przez AI. COB z wcześniejszych posiłków nie podnosi tej granicy ponad dawkę z przelicznika z korektą ponad IOB. Dawka z korektą do wyboru sama tego ostrzeżenia nie wywołuje; dawka wpisana ponad nią jest sprawdzana tak samo jak dotąd. |
| **Niedawno podana insulina** | w ostatnich 90–120 minutach (jedna trzecia czasu działania insuliny) podano co najmniej 1 j: bolusy, SMB albo zdalny bolus, którego Nightscout jeszcze nie pokazuje. Pojawia się, gdy kalkulator nie mógł policzyć aktywnej insuliny albo gdy dawka jest większa niż z kalkulatora. |
| **Ten posiłek już wysłano** | w ostatnich 90 minutach wysłano bolus z tymi samymi węglowodanami (z dokładnością do 1 g albo 5 %) albo z tą samą nazwą posiłku, z karty Bolus, z rozmowy albo z nowego posiłku. Karta w rozmowie ostrzega też, gdy w ciągu 3 godzin wysłano już kartę na ten posiłek. Druga dawka podałaby insulinę drugi raz. |
| **Kalkulator dawki niedostępny** | kalkulator nie zadziałał. Dawka nie została sprawdzona, więc sprawdź ją sam. |
| **Nie udało się sprawdzić, czy ten posiłek już wysłano** | serwer nie mógł przejrzeć historii bolusów. Sprawdź ją, zanim podasz. |

Niska glukoza ma własne, osobne potwierdzenie, opisane wyżej.

## Druga część i bolus odłożony

Druga część rozłożonego bolusa i bolus odłożony na później są liczone według tych samych zasad, gdy przychodzi ich
czas. Aktywnej insuliny i COB Mellis nie liczy tu drugi raz, bo należą do pierwszej części tego samego posiłku.
Dawkę obniża tylko glukoza poniżej celu albo spadająca i zasada „najpierw węglowodany”.

## Czego Mellis nie robi

- Nie podnosi dawki ponad dawkę z przelicznika bez Twojej prośby (rozmowa albo przycisk ± z korektą do wyboru).
- Nie proponuje pełnej korekty ani insulinReq pętli.
- Nie stosuje „procentu bolusa” z Trio (domyślnie 80 %), super bolusa ani bolusa zmniejszonego.
- Nie zmienia dawki na podstawie historii podobnych posiłków. Tę historię pokazuje tylko rozmowa.
- Nie zmienia ustawień pętli ani jej limitów.
