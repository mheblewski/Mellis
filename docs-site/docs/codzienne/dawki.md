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

Mellis liczy dawkę na dwa sposoby. Od której liczby zaczyna karta, wybierasz w ustawieniach (rozdział „Skąd karta
bierze dawkę” niżej). Drugą liczbę karta zawsze pokazuje jako możliwość.

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

## Skąd karta bierze dawkę

Karta w rozmowie, karta zaplanowanego posiłku i karta **Bolus** zaczynają od **dawki z przelicznika** (węglowodany /
ICR). To ustawienie domyślne.

Jeśli wolisz, żeby karty zaczynały od kalkulatora, wybierz **Z kalkulatora** w **Mellis → Ustawienia → Ten telefon →
Dawka na kartach i w Bolus** (druga możliwość to **Z przelicznika**). To ustawienie należy do Ciebie, nie do
telefonu: działa u każdego podopiecznego i na każdym Twoim telefonie. Drugi opiekun ma własne.

| Ustawienie | Od jakiej dawki zaczyna karta | Co karta pokazuje jako możliwość |
|---|---|---|
| **Z przelicznika** (domyślne) | węglowodany / ICR | gdy kalkulator daje mniej: **Z kalkulatora · X j** |
| **Z kalkulatora** | **mniejsza** z liczb: dawka z przelicznika, wynik kalkulatora, dawka obniżona na spadek glukozy (niżej) | gdy kalkulator obniżył dawkę: **Z przelicznika · X j** |

Na karcie w rozmowie i na karcie zaplanowanego posiłku ta możliwość jest pod **Inny plan ▾**. Na karcie Bolus jest
to przełącznik w rogu pola insuliny (niżej). Przy ustawieniu „Z przelicznika” pod dawką na karcie w rozmowie widać, ile
dałby kalkulator i dlaczego, np. „Z przelicznika. Kalkulator: 0,3 j (aktywna insulina)”.

Przy obu ustawieniach:

- Gdy glukoza jest niska albo zaraz będzie, insulina teraz to **0 j**, a najpierw są węglowodany (rozdział „Gdy
  glukoza jest niska” niżej). Ustawienie tego nie zmienia.
- Mellis nigdy sam nie wpisuje więcej niż dawka z przelicznika. Jeśli kalkulator mówi „więcej”, bo glukoza jest
  wysoka, karta i tak zostaje przy dawce z przelicznika. Korektę na wysoką glukozę Mellis dodaje tylko wtedy, gdy o nią
  poprosisz: w rozmowie albo przełącznikiem na karcie Bolus (niżej, „Korekta do wyboru”).
- Dawka jest **zaokrąglana w dół** do kroku pompy, np. do 0,05 j. Nigdy w górę.

!!! example "Przykład: Ala, obiad 40 g"
    Wymyślone ustawienia: ICR 10 g/j, ISF 50 mg/dL na 1 j, cel 100 mg/dL.

    Glukoza 130 mg/dL, stała, prognoza pętli nie schodzi poniżej celu. Aktywna insulina 1,5 j, COB 0 g.

    - Z przelicznika: 40 / 10 = **4 j**.
    - Kalkulator: 40 / 10 + (130 − 100) / 50 − 1,5 = 4 + 0,6 − 1,5 = **3,1 j**.

    Przy ustawieniu „Z przelicznika” karta proponuje **4 j**, a jako możliwość „Z kalkulatora · 3,55 j”.

    Przy ustawieniu „Z kalkulatora”: prognoza pętli stoi na 130, więc nawet z 4 j linia przerywana nie schodzi poniżej
    celu. Mellis proponuje połowę drogi (patrz niżej): 3,1 + (4 − 3,1) / 2 = **3,55 j**, a pod dawką pisze: „↓ 0,45 j
    mniej niż z przelicznika (4 j): IOB i prognoza pętli”. Bez świeżej prognozy pętli zostaje 3,1 j („↓ 0,9 j mniej niż
    z przelicznika (4 j): aktywna insulina”). Jako możliwość karta pokazuje „Z przelicznika · 4 j”.

    Gdyby glukoza wynosiła 220 mg/dL, stała, a insulina z wcześniejszych bolusów już nie działała, kalkulator dałby
    4 + (220 − 100) / 50 = 6,4 j. Przy obu ustawieniach karta zaproponuje 4 j z przelicznika.

### Aktywna insulina obniża dawkę najwyżej o połowę

Gdy dawkę obniża głównie aktywna insulina, kalkulator nie zejdzie niżej niż **połowa dawki z przelicznika**
(zaokrąglona w dół do kroku pompy). Tak jest też wtedy, gdy dawkę obniżyła prognoza pętli, która pokazuje spadek, choć
glukoza stoi. Ta granica działa tylko wtedy, gdy:

- glukoza nie spada (trend z 15 minut nie mniejszy niż −10 mg/dL),
- glukoza jest na celu albo wyżej,
- węglowodany nie idą najpierw (glukoza nie jest niska i nie zanosi się na niską),
- to nie jest kolejna część rozłożonego bolusa.

Gdy glukoza spada albo jest poniżej celu, kalkulator może zejść niżej niż połowa. Pod ⓘ widać wtedy np. „Połowa dawki z
przelicznika: 2 j zamiast 4 j. Kalkulator pętli dałby 1,1 j (IOB 3,5 j), ale insulina w organizmie obniża dawkę
najwyżej o połowę, gdy glukoza nie spada.”

### Dawka z prognozą pętli

Gdy kalkulator pętli obniża dawkę z powodu aktywnej insuliny, a pętla ma świeżą prognozę, Mellis proponuje **połowę
drogi** od dawki kalkulatora do dawki, przy której prognoza pętli z tą dawką (linia przerywana na wykresie) przez 3
godziny nie schodzi poniżej celu (albo poniżej obecnej glukozy, gdy ta jest niższa od celu). Nigdy więcej niż z
przelicznika i nigdy mniej niż z kalkulatora; spadek glukozy i niska glukoza mają pierwszeństwo. Pod dawką widać wtedy
np. „↓ 0,8 j mniej niż z przelicznika (1,4 j): IOB i prognoza pętli”, szczegóły pod ⓘ.

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

Tak obniżoną dawkę karta proponuje przy ustawieniu „Z kalkulatora”. Przy ustawieniu „Z przelicznika” karta zostaje
przy dawce z przelicznika, a dawka obniżona na spadek jest możliwością „Z kalkulatora · X j”, z powodem pod dawką, np.
„Z przelicznika. Kalkulator: 1,2 j (glukoza spada)”. Zasada „najpierw węglowodany” (następny rozdział) działa przy obu
ustawieniach.

## Gdy glukoza jest niska: najpierw węglowodany

Gdy glukoza jest poniżej **70 mg/dL** albo pętla przewiduje spadek poniżej 70 mg/dL w ciągu ok. 30 minut, proponowana
dawka to **0 j**. Mellis podpowiada najpierw szybkie węglowodany (sok, glukoza), a insulinę dopiero po wzroście
glukozy. Ilość węglowodanów liczy tak samo jak w ostrzeżeniu o możliwym hipo (patrz
[Powiadomienia](powiadomienia.md)). Tak samo jest, gdy ostatni odczyt był poniżej 70, ale ma już kilkadziesiąt minut (do godziny): niski odczyt,
który nie jest świeży, to nie powód, żeby o nim zapomnieć.

Insulinę możesz wtedy podać, ale tylko po osobnym potwierdzeniu: przed Face ID pojawia się okno „Glukoza jest niska”
z przyciskiem **Podaj insulinę mimo niskiej glukozy**. Serwer odrzuca taką insulinę bez tego potwierdzenia. Same
węglowodany nigdy nie są blokowane.

## Linia pod dawką i ⓘ

Pod dawką jest jedna krótka linia:

- „Z przelicznika”, gdy dawka jest równa dawce z przelicznika,
- „↓ X j mniej niż z przelicznika (Y j): powód”, gdy Mellis ją obniżył. Powód to ten, który obniżył dawkę
  najbardziej: **aktywna insulina**, **glukoza spada**, **glukoza poniżej celu**, **prognoza poniżej celu** albo
  **niska glukoza — najpierw węglowodany**,
- „Z przelicznika: X j więcej niż kalkulator (powód)” na karcie Bolus i „Z przelicznika. Kalkulator: X j (powód)” na
  karcie w rozmowie, gdy w polu jest dawka z przelicznika, a kalkulator dałby mniej (tak jest od razu przy
  ustawieniu „Z przelicznika”),
- „Kalkulator: X j (powód)”, gdy w polu jest dawka wpisana przez Ciebie, np. „Kalkulator: 0 j (glukoza spada)”.
  Gdy kalkulator daje tyle samo, ile wpisano, linii nie ma.

Ikona ⓘ obok linii pokazuje pełne wyliczenie: dane, z których skorzystał kalkulator, i wzór, np. „40 g / ICR 10 +
(130 − 100) / 50 − IOB 1,5 j = 3,1 j”. Stamtąd prowadzi też link na tę stronę.

## Przełącznik kalkulator / ICR na karcie Bolus

Gdy kalkulator daje mniej niż przelicznik, w rogu pola insuliny jest mały pionowy przełącznik z dwóch pól: u góry
**±** (kalkulator), na dole **ICR** (sam przelicznik). Wypełnione pole pokazuje, która dawka jest teraz w polu.

Od której dawki zaczyna pole, zależy od ustawienia **Dawka na kartach i w Bolus** (rozdział „Skąd karta bierze
dawkę”):

- **Z przelicznika** (domyślne): po wpisaniu węglowodanów w polu jest dawka z przelicznika, wypełnione jest **ICR**.
  Linia pod dawką mówi, o ile ta dawka jest większa niż z kalkulatora i dlaczego, np. „Z przelicznika: 0,9 j więcej
  niż kalkulator (aktywna insulina)”. Stuknij przełącznik, a w polu pojawi się dawka z kalkulatora (wypełni się ±).
- **Z kalkulatora**: w polu jest dawka z kalkulatora, wypełnione jest **±**. Stuknij przełącznik, a w polu pojawi się
  dawka z przelicznika (wypełni się ICR), z tą samą linią pod dawką.

Kolejne stuknięcie wraca do drugiej dawki. Gdy wpiszesz własną dawkę, żadne pole nie jest wypełnione; stuknięcie ±
wstawia dawkę z kalkulatora, a ICR dawkę z przelicznika. Gdy glukoza jest niska albo zaraz będzie, pole zaczyna od
**0 j** przy obu ustawieniach. Gdy ten sam posiłek dostał już bolus, pole też zaczyna od 0 j.

Wybór dawki z przelicznika, gdy kalkulator daje mniej, to Twoja decyzja. Ta dawka jest jedną z propozycji karty
Bolus, więc nie wywołuje ostrzeżenia „Dawka wyższa niż propozycje” (niżej). Jej skutek widać na linii przerywanej
„z tą dawką”.

Ten sam przełącznik ma drugi tryb: korektę do wyboru (następny rozdział). Naraz działa tylko jeden z nich. Gdy kalkulator
obniżył dawkę, przełącznik zawsze działa tak jak wyżej.

## Korekta do wyboru (przełącznik)

Gdy glukoza jest wysoka i nic nie wskazuje na spadek, Mellis może zaproponować **połowę korekty**. Nigdy nie wpisuje
jej sam: w polu zostaje zwykła dawka (wypełnione ICR), a pod dawką widać np. „Korekta do wyboru: +0,2 j
(przełącznik)”. Stuknij przełącznik, a w polu pojawi się dawka z korektą (wypełni się ±), a linia pod dawką powie,
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
- wynik jest zaokrąglany **w dół** do kroku pompy (np. 0,1 j), a przełącznik pojawia się dopiero, gdy korekta to co
  najmniej jeden krok,
- cel, ISF i aktywna insulina są te same co w kalkulatorze (ujemne IOB liczy się jako 0),
- ⓘ pokazuje glukozę, trend, aktywną insulinę, cały wzór z liczbami i dlaczego tylko połowa.

Korekta na karcie w rozmowie, gdy o nią poprosisz, celuje w ten sam cel co kalkulator: cel pętli (także tymczasowy),
a gdy pętla go nie podała, środek zakresu z profilu, zawsze w przedziale 80–250 mg/dL.

### Kiedy Mellis nie proponuje korekty

Przełącznik w tym trybie się nie pokazuje, gdy zachodzi którykolwiek z warunków:

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
- kalkulator obniżył dawkę (wtedy przełącznik działa w trybie obniżania),
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

## Wykres: linia przerywana „z tą dawką”

Linia ciągła na wykresie karty Bolus to prognoza pętli, podpisana jej nazwą (np. „Trio”). Pętla nie zna dawki,
której jeszcze nie podano: ⓘ przy „Prognoza” mówi, że ta linia jest bez tej dawki. Legenda zawsze mieści się w jednym
wierszu: „— Trio” i „- - z tą dawką” albo „- - z węglami”. Gdy wpisana dawka różni się od dawki z przelicznika o co najmniej jeden krok pompy, pojawia się
druga, przerywana linia **„z tą dawką”**: prognoza pętli z odjętym działaniem insuliny **ponad** węglowodany z
przelicznika (dawka − węglowodany/ICR; przy 0 g cała dawka). Tę różnicę Mellis rozkłada w czasie według krzywej
działania insuliny (czas działania z profilu) razy ISF. Węglowodanów nie modeluje.

Szczyt krzywej jest taki jak w pętli, gdy da się go odczytać z danych: Loop wysyła rodzaj insuliny przy każdej dawce
(Fiasp i Lyumjev: szczyt 55 min, Novolog/Humalog/Apidra: 75 min). Trio trzyma ustawienie krzywej w telefonie i nie
wysyła go do Nightscouta, więc dla Trio Mellis przyjmuje 75 min (insulina szybkodziałająca). Którą krzywą liczy, widać
pod ⓘ przy „Prognoza”, np. „Krzywa insuliny: rapid-acting (szczyt 75 min, domyślnie), DIA 10 h”.

- Dawka większa niż z przelicznika: linia przerywana idzie niżej. Gdy dawka jest też większa od wszystkich propozycji
  karty, a linia schodzi poniżej 100 mg/dL, w sprawdzeniach pojawia się **„Po tej dawce ok. X mg/dL”** (czerwone
  poniżej 70). X to najniższy punkt tej linii, więc wykres i ostrzeżenie zawsze się zgadzają. Dawka w zakresie
  propozycji ostrzega tylko wtedy, gdy linia schodzi poniżej 70 mg/dL (np. korekta do wyboru przy spadającej
  prognozie).
- Dawka mniejsza niż z przelicznika: linia przerywana idzie trochę wyżej.
- Węglowodany wpisane, pole dawki puste: linia przerywana **„z węglami”** pokazuje wzrost od tych
  węglowodanów (węglowodany × ISF / ICR, rozłożone tą samą krzywą). Bez ostrzeżenia „Po tej dawce”.
- Dawka równa dawce z przelicznika albo nic nie wpisano: jedna linia, jak dotąd.

Na wykresie jest najwyżej **jeden czerwony znacznik**: najniższy punkt poniżej 70 mg/dL linii, która się liczy
(przerywanej, gdy jest, inaczej linii pętli), z podpisem wartości i godziny, np. „52 · 21:15”. Gdy linia nie schodzi
poniżej 70, znacznika nie ma.

Linia zakłada, że pętla nic więcej nie zmieni. Trio zwykle i tak zmniejszy albo doda insulinę, więc w praktyce
przebieg bywa łagodniejszy.

### Gdy linia prognozy jest włączona

**Linia prognozy** jest włączona od razu (wyłączasz ją w **Mellis → Ustawienia → Ten telefon → Linia prognozy**). Wtedy
wykres karty Bolus pokazuje też, co jest w planie: drugą część bolusa, insulinę na WBT, zaplanowany posiłek i czas, gdy
po tłustym posiłku glukoza może wzrosnąć później („Możliwy późny wzrost”). Chmura wokół linii pętli to jej typowy
błąd: mniej więcej połowa odczytów wypada w niej, a połowa poza nią. Bez nowej dawki linia jest taka sama jak na
ekranie Teraz.

Prognoza po około godzinie często rozmija się z rzeczywistością, dlatego przy włączonej linii Mellis nie podaje
liczby, która wygląda na pewniejszą, niż jest:

- ostrzeżenie „Po tej dawce” mówi, że cukier może spaść niżej, i przypomina, że linia przerywana zakłada, że pętla nic
  więcej nie zmieni, ale nie podaje wartości w mg/dL;
- czerwony znacznik pokazuje tylko godzinę spadku poniżej 70, np. „< 70 · 21:15”, zamiast „52 · 21:15”.

Wykres służy do porównania dawek, a nie do odczytu cukru. Brak ostrzeżenia nie znaczy, że niskiego cukru nie będzie.

## Ostrzeżenia przed wysłaniem

Przy wysyłaniu serwer liczy wszystko jeszcze raz, na najnowszych danych. Te ostrzeżenia trzeba przeczytać
i potwierdzić, zanim dawka pójdzie do pętli:

| O czym ostrzega | Kiedy się pojawia |
|---|---|
| **Karta Bolus: dawka ponad propozycje** (jedno ostrzeżenie albo żadne) | Propozycje karty Bolus to dawka z kalkulatora (z prognozą pętli), dawka z przelicznika (węglowodany / ICR) i korekta do wyboru, gdy jest proponowana. Dawka od najmniejszej do największej z nich, wybrana przełącznikiem albo wpisana, i dawka mniejsza od nich: **bez ostrzeżenia** (skutek widać na linii przerywanej). Dawka większa od największej propozycji: **„Dawka wyższa niż propozycje (+X j)”** (czerwone), gdy przekracza ją o co najmniej 1 j albo o 50 % (większa z tych wartości), bez względu na wykres. Poniżej tej granicy liczy się linia przerywana: jej najniższy punkt w ciągu 3 godzin poniżej 100 mg/dL daje **„Po tej dawce ok. X mg/dL”** (czerwone poniżej 70, pomarańczowe 70–99); 100 mg/dL i więcej: bez ostrzeżenia. Bez linii przerywanej (brak prognozy pętli) ostrzega „Dawka wyższa niż propozycje” przy przekroczeniu o co najmniej 0,5 j albo 25 %. Nigdy oba naraz: przy dużym przekroczeniu wartość linii jest w tekście „Dawka wyższa niż propozycje”. Gdy kalkulator nie mógł policzyć (brak świeżej glukozy albo IOB), jedyną propozycją jest dawka z przelicznika, a zwykłe ostrzeżenie jest pomarańczowe. Do największej propozycji wlicza się też wynik kalkulatora z pełną korektą, więc dawka, której wymagają dane, nie ostrzega. |
| **Dawka większa niż z danych** (rozmowa, WBT, druga część) | dawka z karty w rozmowie, z okna WBT (z węglowodanami) albo druga część bolusa jest większa od wyniku kalkulatora o co najmniej 0,5 j albo o co najmniej 25 % tego wyniku (większa z tych wartości). COB z wcześniejszych posiłków nie podnosi tej granicy ponad dawkę z przelicznika z korektą ponad IOB. Tam też zostaje **„Dawka inna niż z ICR”**: dawka różni się od przelicznika o ponad 20 % i nie jest obniżeniem z kalkulatora. |
| **Niedawno podana insulina** | w ostatnich 90–120 minutach (jedna trzecia czasu działania insuliny) podano co najmniej 1 j: bolusy, SMB albo zdalny bolus, którego Nightscout jeszcze nie pokazuje. Pojawia się, gdy kalkulator nie mógł policzyć aktywnej insuliny, a poza kartą Bolus także wtedy, gdy dawka jest większa niż z kalkulatora (na karcie Bolus kalkulator liczy tę insulinę w IOB, a ilość podaną ostatnio podaje ostrzeżenie o dawce ponad propozycje). |
| **Ten posiłek już wysłano** | w ostatnich 90 minutach wysłano bolus z tymi samymi węglowodanami (z dokładnością do 1 g albo 5 %) albo z tą samą nazwą posiłku, z karty Bolus, z rozmowy albo z nowego posiłku. Karta w rozmowie ostrzega też, gdy w ciągu 3 godzin wysłano już kartę na ten posiłek. Druga dawka podałaby insulinę drugi raz. |
| **Kalkulator dawki niedostępny** | kalkulator nie zadziałał. Dawka nie została sprawdzona, więc sprawdź ją sam. |
| **Nie udało się sprawdzić, czy ten posiłek już wysłano** | serwer nie mógł przejrzeć historii bolusów. Sprawdź ją, zanim podasz. |
| **Nie wiadomo, czy bolus został podany** | w ostatnich 3 godzinach pompa odpowiedziała niewyraźnie na zdalny bolus, a pętla nie zapisała go w Nightscoucie. Treść: „Nie wiadomo, czy bolus X j sprzed Y min został podany: pompa odpowiedziała niewyraźnie. Mellis liczy go jako podany, więc dalsze dawki są o niego mniejsze. Sprawdź historię bolusów w pompie: jeśli go tam nie ma, brakującą insulinę podaj w zakładce Bolus.” Insulina idzie dopiero po osobnym kroku: okno „Sprawdź historię bolusów w pompie” z przyciskiem **Sprawdziłem: tamtego bolusa nie ma, podaj**. |

Niska glukoza ma własne, osobne potwierdzenie, opisane wyżej.

### Gdy pompa odpowiedziała niewyraźnie {#gdy-pompa-odpowiedziala-niewyraznie}

Czasem pompa odpowiada na zdalny bolus niewyraźnie („Bolus mógł się nie udać”). Zwykle bolus jest wtedy podany, więc
Mellis nie pokazuje go jako odrzuconego i nie proponuje go jeszcze raz. Karta Bolus pokazuje krok „Sprawdzam”, dopóki
sprawdza, czy pętla zapisała bolus w Nightscoucie:

- gdy pętla zapisała bolus (zwykle po kilku sekundach), krok zmienia się na „Bolus podany”,
- gdy bolusa nie ma po około 30 sekundach, karta pokazuje „Nie wiadomo” i „Bolusa nie ma w Nightscout: sprawdź
  historię w pompie”, a powiadomienie mówi „Nie wiadomo, czy bolus został podany” i „Pompa odpowiedziała niewyraźnie.
  Sprawdź historię bolusów w pompie, zanim podasz kolejny.”

Taki bolus Mellis liczy jako podany w każdej sumie dawek posiłku, także wtedy, gdy liczy kolejną część rozłożonego
bolusa albo resztę dawki. Przez 3 godziny następna dawka ma ostrzeżenie „Nie wiadomo, czy bolus został podany” z tabeli wyżej.

## Karta dawki w rozmowie i przy zaplanowanym posiłku {#karta-dawki}

Karta w rozmowie i karta na stronie zaplanowanego posiłku wyglądają tak samo: to ponumerowane kroki, każdy z jedną
liczbą i jednym przyciskiem.

- Nad krokami jest jedno zdanie o planie, gdy jest co powiedzieć, np. „Bolus w dwóch dawkach: pierwsza teraz, druga
  później.” albo „Glukoza 85 i spada, dlatego najpierw szybkie węgle.”
- Gdy trzeba najpierw dosłodzić, pierwszy krok **TERAZ** to szybkie węglowodany, z przyciskiem **Pomiń**. Krok z
  dawką ma wtedy tytuł **POTEM, DO POSIŁKU**, a przycisk insuliny nie jest wypełniony i ma pod sobą „Insulina dopiero
  po węglach.”
- Krok z dawką teraz ma tytuł **TERAZ**. Na stronie zaplanowanego posiłku przed jego porą tytuł to np. **NA POCZĄTEK
  POSIŁKU · O 14:39**, a przycisk zaczyna się od „Posiłek trwa”. Przycisk mówi dokładnie, co pójdzie do pętli, np.
  „Podaj 3 j i 45 g” albo „Wpisz 40 g do Trio”.
- Każda dawka na później to osobny krok z godziną albo warunkiem, np. **DRUGA DAWKA · OK. 18:59**, z napisem „Nie
  podawaj teraz.” i z liczbami tej dawki. Mellis przypomni o niej obu opiekunom. Dawkę z „ok.” policzy od nowa, gdy
  przyjdzie jej czas.
- Gdy plan karty prowadzi do spadku, ostrzeżenie jest nad krokami.
- **Inny plan ▾** pokazuje inne plany dla tego samego posiłku (niżej). **Szczegóły ›** pokazuje prognozę z tym planem,
  wzór dawki i cały plan na osi czasu.

Karta, której ważność minęła, nie pokazuje starych kroków. Mówi „Ta dawka jest nieaktualna”, kiedy ją policzono, i ma
przycisk **Przelicz na aktualnych danych**. Nic nie zostało wysłane.

Karta zaplanowanego posiłku powstaje tylko od 30 minut przed jego porą do 30 minut po niej, tylko gdy posiłek jest
nadal w planie i nikt nie podał jeszcze do niego bolusa.

### Inny plan

Pod **Inny plan ▾** są gotowe plany, które Mellis liczy tak samo jak kartę. Po wybraniu Mellis liczy kartę od nowa na
aktualnych danych i zastępuje nią poprzednią. Plan, który daje to samo co karta, się nie pokazuje. Możliwe plany:

| Przycisk | Kiedy jest | Co robi |
|---|---|---|
| **Z kalkulatora · X j** | karta jest z przelicznika, a kalkulator daje mniej | ta sama karta z dawką z kalkulatora |
| **Z przelicznika · X j** | kalkulator obniżył dawkę karty, a węglowodany nie idą najpierw | ta sama karta z dawką z przelicznika |
| **Więcej później** | karta dzieli dawkę 70/30 | podział 60/40 (niżej) |
| **Bez podziału · X j** | karta dzieli dawkę | cała dawka teraz, bez kolejnej części |
| **Podziel na dwie** | podział jest zalecany, a karta daje całość naraz | podział zalecany dla tego posiłku |
| **Dawka później** | karta daje insulinę teraz, bez podziału | węglowodany teraz, dawka za 20 minut |
| **Połowa dawki teraz · X j** | węglowodany idą najpierw, a insulina teraz to 0 j | połowa dawki z przelicznika teraz, reszta, gdy glukoza przestanie spadać |
| **Cała dawka teraz · X j** | węglowodany idą najpierw, a insulina teraz to 0 j | cała dawka z przelicznika teraz |
| **Plan karty** | karta powstała z innego planu | powrót do pierwszego planu karty |

Karta niższa niż dawka z przelicznika zawsze ma przycisk z całą dawką: **Z przelicznika · X j** albo, gdy węglowodany
idą najpierw, **Cała dawka teraz · X j**.

Gdy wybrany plan prowadzi do spadku, Mellis najpierw pyta. Tak jest zawsze, gdy plan daje więcej insuliny niż karta,
a prognoza schodzi poniżej 54 mg/dL. Okno pokazuje
dawkę planu, powód („Spokojniejszy jest plan z karty.”) i dwa przyciski: **Zostaw plan z karty** i **Zmień plan mimo
to**.

Gdy w rozmowie podasz własną dawkę albo własny plan, karta trzyma się Twojego planu i nie pokazuje innych.

### Reszta dawki

Gdy karta daje teraz mniej niż węglowodany / ICR (albo 0 j), a nie ma kolejnej części z własnymi węglowodanami,
pokazuje krok **RESZTA** z dawką „ok. X j” i napisem „Bez przypomnienia”. Reszta to węglowodany karty minus to, co
pokrywa dawka teraz. Przycisk **Przypomnij** pozwala wybrać, kiedy Mellis ma przypomnieć o reszcie:

- „Za 15 min”, „Za 30 min”, „Za 1 h”, „Za 1,5 h” albo „Za 2 h”,
- „Gdy glukoza przestanie spadać”, gdy glukoza spada albo węglowodany idą najpierw. To przypomnienie przychodzi
  najpóźniej po 3 godzinach.

Wybrana pora zmienia resztę w kolejny krok karty, a dawka teraz zostaje taka sama. Przycisk **Zmień** przy tym kroku
zmienia porę, a **Bez przypomnienia** usuwa przypomnienie. Dawkę reszty Mellis liczy od nowa, gdy przychodzi jej
czas, według zasad dla kolejnej części (rozdział „Druga część i bolus odłożony” niżej). Gdy zmienisz dawkę na karcie
przed wysłaniem, reszta liczy się od dawki, która naprawdę poszła z tej karty.

### Godzina kolejnej dawki {#godzina-kolejnej-dawki}

Przy kolejnej dawce z godziną (np. **DRUGA DAWKA · OK. 20:13**) jest przycisk **Zmień**. Wybierasz, ile po posiłku ma
przyjść przypomnienie: **30 min**, **1 h**, **1,5 h** albo **2 h**, z godziną zegarową obok. Później niż 2 h się nie
da: od 2,5 h po posiłku przychodzi przypomnienie o insulinie na tłuszcz i białko (WBT).

- **Przed wysłaniem** karta liczy się od nowa z nową godziną. Dawka teraz zostaje bez zmian.
- **Po wysłaniu** przypomnienie przesuwa się dla wszystkich opiekunów. Dawkę Mellis i tak liczy od nowa, gdy
  przyjdzie jej czas. Przesunąć można tylko dawkę, której przypomnienie jeszcze nie przyszło.

Dawki **Gdy glukoza przestanie spadać** nie da się przestawić na godzinę: czeka, aż spadek się skończy.

### Karta po wysłaniu {#karta-po-wyslaniu}

Po wysłaniu karta zostaje w krokach. Zdanie na górze mówi, co się stało, a obramowany jest zawsze tylko jeden krok:
ten, na który teraz czekasz.

| Co widać na górze | Co to znaczy |
|---|---|
| „Pierwsza dawka podana o 19:19. Nie podawaj jej ponownie.” | Trio podało bolus. Krok 1 ma zielony znaczek, przez chwilę pokazuje „Wysłano · Podano · Zapisano”, potem zwija się do jednej linii. Obramowany jest następny krok. |
| „Dawka idzie do Trio. Nie wysyłaj jej ponownie.” | Polecenie jest w drodze. Obramowany jest krok 1 z postępem wysyłki. |
| „Trio odrzuciło bolus. Węglowodany są już zapisane.” | Węglowodany są w Trio, bolus nie. Przycisk **Podaj sam bolus** wysyła samą insulinę, węglowodanów nie wysyła drugi raz. |
| „Nic nie zostało podane.” | Trio odrzuciło całe polecenie albo nie dało się go wysłać. Przycisk **Podaj ponownie**. |
| „Trio nie odpowiedziało. Bolus mógł zostać podany: nie wysyłaj go ponownie.” | Nie wiadomo, czy bolus poszedł. Bez przycisku ponowienia: sprawdź telefon z Trio albo historię bolusów w pompie. |

Gdy wysłano mniej, niż było na karcie (np. dawkę zmniejszoną w oknie potwierdzenia), krok 1 mówi „Mniej niż na karcie
(8 j i 40 g). Reszty tej części nikt nie przypomni.” Brakującą część podajesz wtedy sam, np. w zakładce Bolus.

## Rozłożony bolus przy tłustym posiłku {#rozlozony-bolus}

Karta w rozmowie i karta zaplanowanego posiłku same proponują podział dawki, gdy posiłek ma dużo tłuszczu i białka w
stosunku do węglowodanów. Potrzebne są do tego białko i tłuszcz posiłku. Mellis patrzy na dwie liczby:

- **WBT na WW**: WBT posiłku podzielone przez jego węglowodany w WW (1 WW to 10 g węglowodanów),
- **tłuszcz w energii posiłku**: jaka część kalorii posiłku pochodzi z tłuszczu.

| Posiłek | Plan |
|---|---|
| poniżej **25 g** węglowodanów | cała dawka naraz |
| od 25 g, co najmniej **0,5 WBT na WW** albo tłuszcz co najmniej **35 %** energii | **70/30**: 70 % węglowodanów i ich dawka teraz, reszta węglowodanów i ich dawka za ok. **60 minut** |
| od 25 g, co najmniej **0,8 WBT na WW** albo tłuszcz co najmniej **40 %** energii | **60/40**: 60 % teraz, reszta za ok. **90 minut** |

Podziału nie ma też wtedy, gdy na później zostałyby mniej niż 4 g węglowodanów. Przy podziale 70/30 przycisk **Więcej
później** zmienia go na 60/40, a **Bez podziału** daje całą dawkę teraz.

Mniejszy posiłek dostaje całą dawkę naraz, a tłuszcz i białko pokrywa przypomnienie o WBT. Przypomnienie włącza się
samo, gdy posiłek ma co najmniej 1,5 WBT, co najmniej 18 g tłuszczu albo co najmniej 20 g białka, i przychodzi ok. 2,5
godziny po początku posiłku. Bez historii wcześniejszych dawek na WBT standardowa dawka to WBT × 10 / ICR × 30 %.

## Druga część i bolus odłożony

Druga część rozłożonego bolusa i bolus odłożony na później są liczone według tych samych zasad, gdy przychodzi ich
czas. Aktywnej insuliny i COB Mellis nie liczy tu drugi raz, bo należą do pierwszej części tego samego posiłku.
Dawkę obniża tylko glukoza poniżej celu albo spadająca i zasada „najpierw węglowodany”.

Po **scaleniu posiłków** w karcie Posiłki (**Scal**) kolejna część zostaje bez zmian, gdy wybierzesz „Zostaw
podział”. Węglowodany doliczone ze scalonych posiłków nie zwiększają tej części: miały już własne bolusy. Gdy
wybierzesz „Nowy podział w czacie”, zaplanowana część zostaje pominięta, a nowy podział liczy rozmowa dla całego
scalonego posiłku, z dawkami już podanymi. Dawka WBT scalonego posiłku jest liczona od nowa z całego posiłku.

## Skąd te wzory

**Kalkulator** to klasyczny kalkulator bolusa z terapii pompowej: (węglowodany + COB) / przelicznik + (glukoza +
trend − cel) / ISF − aktywna insulina. Tak samo liczą kreatory bolusa w pompach i w pętlach.

**Różnica wobec Trio.** Kalkulator bolusa w Trio (plik źródłowy BolusCalculationManager.swift) dodaje te same
składniki, ale z całego wyniku bierze 80 % („Recommended Bolus Percentage”). W aplikacji Mellis odejmowana jest cała
aktywna insulina, a sama z siebie aplikacja nigdy nie proponuje więcej niż dawka z przelicznika (węglowodany / ICR).

**Dlaczego „połowa drogi”.** Algorytm samej pętli (oref, OpenAPS) też działa tylko na część tego, co pokazuje jego
prognoza: SMB podaje domyślnie połowę insulinReq (smb_delivery_ratio 0,5), bo prognozy bywają zbyt optymistyczne.
Mellis korzysta z prognozy pętli tak samo ostrożnie: przesuwa dawkę kalkulatora tylko w połowie drogi do dawki, przy
której prognoza z tą dawką zostaje na celu albo wyżej. Nigdy ponad dawkę z przelicznika, a zasady przy spadku i
niskiej glukozie zawsze mają pierwszeństwo.

**Jak to sprawdzono.** Sprawdzone wstecz na kilkuset dawkach jednej osoby: zmiana podnosi dawkę rzadko i zwykle o
0,1 j, bez nowych ciężkich niedocukrzeń (poniżej 54 mg/dL). To nie jest badanie kliniczne. Mellis to projekt DIY:
decyzja o każdej dawce zostaje przy Tobie.

Więcej: [dokumentacja Trio](https://triodocs.org/) i [dokumentacja OpenAPS](https://openaps.readthedocs.io/)
(rozdziały o SMB i determine-basal).

## Czego Mellis nie robi

- Nie podnosi dawki ponad dawkę z przelicznika bez Twojej prośby (rozmowa albo przełącznik z korektą do wyboru).
- Nie proponuje pełnej korekty ani insulinReq pętli.
- Nie stosuje „procentu bolusa” z Trio (domyślnie 80 %), super bolusa ani bolusa zmniejszonego.
- Nie zmienia dawki na podstawie historii podobnych posiłków. Tę historię pokazuje tylko rozmowa.
- Nie zmienia ustawień pętli ani jej limitów.
