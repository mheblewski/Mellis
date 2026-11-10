# Powiadomienia

Mellis wysyła powiadomienia z serwera, więc przychodzą także wtedy, gdy aplikacja jest zamknięta.

!!! tip "Przy pierwszym uruchomieniu"
    Gdy iOS zapyta, czy Mellis może wysyłać powiadomienia, wybierz **Zezwól**. Jeśli wybrałeś **Nie zezwalaj**,
    zmienisz to w **Ustawieniach iOS → Powiadomienia → Mellis**.

| Powiadomienie | Kiedy przychodzi | Co zrobić |
|---|---|---|
| **95 −4 · możliwe niedocukrzenie** (albo **niedocukrzenie**, **pilne niedocukrzenie**) | prognoza pokazuje spadek poniżej 70 mg/dL; tylko jeśli włączyłeś ostrzeżenia na tym telefonie. Tytuł to obecna glukoza i jej zmiana w 5 minut, a treść to pełne zdania, np. „Ok. 14:30 glukoza może spaść poniżej 70. Mellis proponuje 4 g szybkich węglowodanów.” Gdy nikt nie potwierdzi alertu, przychodzi przypomnienie „nadal możliwe niedocukrzenie” | podaj węglowodany w pętli albo zapisz je kartą w rozmowie; stuknij, żeby zobaczyć wykres, prognozę i wyliczenie dawki |
| **Druga część bolusa · 30 g**, **Druga dawka · …** | o ustawionej godzinie albo gdy glukoza zacznie rosnąć, jeśli tak wybrałeś przy dawce | stuknij, sprawdź dawkę i wyślij |
| **Bolus po posiłku · 40 g** | odłożony bolus: glukoza przestała spadać. W powiadomieniu nie ma dawki: karta liczy ją po otwarciu na aktualnych danych | stuknij, sprawdź dawkę i wyślij |
| **Dawka mniejsza niż z przelicznika** | tylko gdy na serwerze włączono `MEAL_UNDERDOSE_ENABLED` (domyślnie wyłączone): dawka do posiłku była wyraźnie mniejsza niż węglowodany / ICR, a glukoza szybko rośnie ([warunki i treść](#dawka-mniejsza-niz-z-przelicznika)) | stuknij: karta liczy resztę dawki na aktualnych danych; sprawdź ją i zdecyduj |
| **⚠️ Nie wiadomo, czy bolus został podany** | pompa odpowiedziała niewyraźnie na zdalny bolus, a pętla nie zapisała go w Nightscoucie w ciągu ok. 30 sekund; treść: „Pompa odpowiedziała niewyraźnie. Sprawdź historię bolusów w pompie, zanim podasz kolejny.” | sprawdź historię bolusów w pompie; Mellis liczy ten bolus jako podany ([więcej](dawki.md#gdy-pompa-odpowiedziala-niewyraznie)) |
| **Przypomnienie o WBT** | ok. 2,5 godziny po tłustym albo białkowym posiłku, jeśli wybrałeś przypomnienie | stuknij i zdecyduj o dawce na tłuszcz i białko |
| treść przypomnienia, np. **Zmierz glukozę** | przypomnienie ustawione w czacie: tytułem jest sama notatka | stuknij, żeby wrócić do rozmowy |
| **Pytanie od Mellis** | AI potrzebuje od Ciebie doprecyzowania, żeby odpowiedzieć | stuknij i odpowiedz |
| **Odpowiedź gotowa** | AI odpowiedziało na Twoje pytanie, a aplikacja jest zamknięta albo w tle | stuknij, żeby przeczytać |
| **Mało insuliny w zbiorniku**, potem **Wymień zbiornik insuliny** | insuliny zostało na mniej niż dobę, a potem na mniej niż 8 godzin średniego zużycia, np. „Insuliny w zbiorniku zostało na ok. 8 godz. (6 j).”; każde raz na napełnienie zbiornika | stuknij, żeby zobaczyć sprzęt; wymień zbiornik albo wkład |
| **❗ 65 −4** (glukoza nisko), **⚠️ 185 +11** (spada / rośnie / wysoko), **⚠️ 140 ⇊ −19** (szybko się zmienia) | powiadomienia o glikemii, jeśli je włączyłeś: tytuł to glukoza i zmiana w 5 minut (strzałka tylko przy szybkiej zmianie), opis mówi, co się dzieje, a pod spodem IOB i COB | sprawdź glukozę i zdecyduj, czy reagować |
| **Brak odczytów z sensora** | przez 10 minut nie przyszedł żaden odczyt, np. „Ostatni odczyt 10 min temu. Sprawdź sensor i telefon, który odbiera odczyty.”, a od 30 minut także „Zmierz glukozę glukometrem.”; potem co 5 minut, dopóki odczyty nie wrócą | sprawdź sensor, telefon z pętlą i Nightscouta |
| **Dziś wymiana wkłucia** albo **Dziś wieczorem wymiana wkłucia** | wkłucie będzie miało 3 dni (od ostatniego wpisu „Site Change” w Nightscoucie), np. „Wkłucie będzie miało 3 dni o 19:40.”, a gdy wypada to w nocy, „Najlepiej zmień je dziś wieczorem.”; raz na wkłucie | zaplanuj wymianę i zapisz ją w pętli |
| **Wkłucie ma już 3 dni** | minęły 3 dni, np. „Założone w poniedziałek o 19:40. Zmień je teraz.”; raz na wkłucie | zmień wkłucie i zapisz zmianę w pętli |
| **Słaba bateria pompy**, potem **Bateria pompy prawie pusta** | bateria pompy poniżej 25 %, a potem poniżej 15 %; każde raz na baterię | wymień baterię |
| **Druga dawka podana · 1,5 j**, **Dawka na WBT podana · 1,2 j** | inny opiekun podał dawkę, o której było przypomnienie; treść kończy się „Nie podawaj jej ponownie.” | nic: przypomnienie znika też u Ciebie |
| **Obiad o 12:30**, **Obiad 12:30 bez bolusa**, **Czy obiad został zjedzony?** | plan posiłków: przypomnienie przed zaplanowanym posiłkiem z aktualną glukozą, jedno powiadomienie, gdy po porze posiłku nie było bolusa, i pytanie, gdy bolus podano, a glukoza nie rośnie; tylko jeśli na tym telefonie są włączone powiadomienia planu | stuknij, żeby otworzyć stronę posiłku i sprawdzić dawkę |
| **WF o 14:45** | plan zajęć: przed zajęciami, tylko gdy glukoza jest niska albo spada | sprawdź glukozę; przed zajęciami mogą być potrzebne węglowodany |

<figure class="screen" markdown>
![Propozycja dosłodzenia w rozmowie](../assets/screens/karta-doslodzenia.png){ loading=lazy }
<figcaption>Propozycja dosłodzenia w rozmowie. Stuknij „Podano 6 g”, żeby zapisać dosłodzenie albo wysłać je do pętli.</figcaption>
</figure>

!!! info "Alarm sprzed ponad 30 minut"
    Starszy alarm (albo propozycja dosłodzenia w czacie) ma znaczek **„Nieaktualne · … temu”**, a glukoza przy nim
    jest podpisana **„wtedy:”**, bo to odczyt z chwili alarmu, nie obecny. Z takiego alarmu Mellis nic nie wyśle do
    pętli: prognoza i dawka są sprzed zmiany glukozy. Nadal możesz zapisać, co podano, kartą w rozmowie („Podano
    6 g”). Gdy trzeba dosłodzić teraz, sprawdź aktualną glukozę i wyślij dosłodzenie z karty Posiłki („+” →
    „Dosłodzenie”).

!!! info "Kiedy przychodzi ostrzeżenie i skąd ta dawka"
    Ostrzeżenie przychodzi, gdy glukoza jest poniżej 70 mg/dL albo gdy spadek poniżej 70 w ciągu ok. 30 minut
    potwierdza prognoza. Sam szybki spadek na sensorze potwierdza go dopiero poniżej **110 mg/dL**: wyżej taki spadek
    zwykle wyhamowuje, gdy pętla zatrzyma bazę, więc o ostrzeżeniu decyduje wtedy tylko prognoza.

    Dawka sprowadza najniższy punkt prognozy z najbliższych 30 minut do 90 mg/dL:

    ```text
    dawka = (90 − najniższa prognoza) / (ISF / ICR)
    ```

    ISF / ICR mówi, o ile mg/dL podnosi glukozę 1 g węglowodanów. Wynik jest w granicach od 4 g do 20 g naraz i
    zawsze jest zaokrąglony w górę do parzystej liczby gramów, bo tabletki glukozy mają po 2 albo 4 g (najwyżej 1 g
    więcej). Poniżej 54 mg/dL to co najmniej tyle, ile podnosi glukozę o ok. 70 mg/dL. Gdy glukoza jest niska i nie
    rośnie, dawka nie jest mniejsza niż mała porcja dla wieku podopiecznego, liczona z roku urodzenia. Węglowodany, które jeszcze się
    wchłaniają (COB), są w prognozie. Po 15 minutach Mellis sprawdza glukozę jeszcze raz i przypomina, jeśli trzeba
    więcej. Liczba węglowodanów, o które prosi Trio (carbsReq), jest tylko informacją: Trio liczy ją na całe
    działanie aktywnej insuliny, a węglowodany w trakcie wchłaniania odejmuje tylko częściowo, więc zwykle wychodzi
    za dużo.

!!! info "Nowa rozmowa po godzinie"
    Gdy otwierasz kartę Rozmowy, a ostatnia rozmowa była cicha od ponad godziny, Mellis pokazuje pustą, nową rozmowę.
    Poprzednia zostaje w liście ☰. Rozmowa otwarta z powiadomienia albo z listy, wiadomość w trakcie pisania i pytanie,
    na które Mellis czeka, zostają na ekranie.

!!! info "„Gdy glukoza zacznie rosnąć”"
    Przy rozłożonym albo odłożonym bolusie możesz wybrać przypomnienie o drugiej części „gdy glukoza zacznie rosnąć”.
    Przychodzi, gdy trzy kolejne odczyty z około 10 minut rosną. Serwer pilnuje go przez godzinę: jeśli glukoza w tym
    czasie nie zacznie rosnąć, przypomnienie wygasa bez powiadomienia.

## Powiadomienia o glikemii

Domyślnie są **wyłączone**. Włączasz je na każdym telefonie osobno: **Mellis → Ustawienia → podopieczny →
Powiadomienia o glikemii**.

| Kiedy | Tytuł | Opis |
|---|---|---|
| glukoza poniżej 70 | **❗ 65 −4** (czerwony wykrzyknik) | Glukoza poniżej 70 i spada. (albo „i rośnie”, albo bez tego przy zmianie +0) |
| 70–79 i spada | **⚠️ 76 −11** | Glukoza spada. |
| przekroczenie 160 (raz), potem powyżej 160 przy wzroście o 5 lub więcej w 5 min | **⚠️ 165 +7** | Glukoza rośnie. |
| przekroczenie 180 (raz), potem powyżej 180 przy wzroście o 5 lub więcej w 5 min | **⚠️ 185 +11** | Glukoza powyżej 180 i rośnie. |
| powyżej 250 przy wzroście o 5 lub więcej w 5 min | **⚠️ 255 +12** | Glukoza powyżej 250 i rośnie. |
| dwie strzałki (⇈ albo ⇊) | **⚠️ 140 ⇊ −19** | Glukoza szybko spada. (albo „szybko rośnie”) |
| powrót do 70–180 po powiadomieniu o glukozie poniżej 70 albo powyżej 180 | **✅ 120 +3** | Glukoza wróciła do zakresu. |
| 10 minut bez odczytu | **Brak odczytów z sensora** | Ostatni odczyt 12 min temu. Sprawdź sensor i telefon, który odbiera odczyty. |

Tytuł to obecna glukoza i jej zmiana w 5 minut (przy braku zmiany „+0”). Strzałka trendu jest tylko przy szybkiej
zmianie (⇈ albo ⇊). W opisie Mellis dopisuje „rośnie” albo „spada” według tej zmiany, a pod spodem jest linijka
z **IOB i COB**, np. „IOB 1,3 j · COB 15 g”. Powyżej 160 decyduje zmiana w 5 minut (+5 lub więcej), nie strzałka; przekroczenie 160 i 180 przychodzi
zawsze raz, nawet gdy glukoza rośnie wolniej. „Spada” w progu 70–79 Mellis bierze ze strzałki, którą widzisz
w aplikacji. Gdy telefon dostaje powiadomienia o kilku podopiecznych, imię jest w drugiej
linijce, pod glukozą.

- Serwer sprawdza każdy nowy pomiar raz. Na jeden pomiar telefon dostaje najwyżej jedno powiadomienie: najważniejsze
  z tych, które masz włączone (niska glukoza przed szybką zmianą, szybka zmiana przed wysoką glukozą).
- Dopóki stan trwa, to samo powiadomienie wraca po czasie z sekcji **Powtarzaj**. Wyższy próg przychodzi od razu
  (np. z 180 na 250), a niższy nie wraca, dopóki nie minie czas od wyższego.
- **Powrót do zakresu** przychodzi raz po każdym wyjściu poza zakres, o którym telefon dostał powiadomienie (glukoza
  poniżej 70, powyżej 180 albo powyżej 250), gdy pierwszy odczyt wróci do 70–180.
- **Brak odczytów z sensora** przychodzi po 10 minutach bez odczytu i potem co 5 minut, dopóki odczyty nie wrócą. Od
  30 minut prosi też o pomiar glukometrem.
- Na telefonie, który dostaje też ostrzeżenia o możliwym niedocukrzeniu, powiadomienie o niskiej albo spadającej
  glukozie czeka minutę po odczycie i nie przychodzi, gdy ostrzeżenie o niedocukrzeniu już poszło. Jeden spadek to
  jeden alarm.
- Każde powiadomienie o glikemii przychodzi osobno, także na zegarek, a telefon układa je w stos dla każdego pacjenta.
  Nie trafia do dzwonka w aplikacji.
- Żadne powiadomienie Mellis nie przebija się przez tryb skupienia: nie zastępują alarmów sensora ani pętli.

<div class="grid" markdown>

<figure class="screen" markdown>
![Powiadomienia o glikemii](../assets/screens/powiadomienia-glikemia.png){ loading=lazy }
<figcaption>Główny przełącznik i każdy rodzaj osobno. Rodzaje możesz ustawić także przy wyłączonym głównym przełączniku.</figcaption>
</figure>

<figure class="screen" markdown>
![Powtarzanie i prognoza](../assets/screens/powiadomienia-powtarzanie.png){ loading=lazy }
<figcaption>Powtarzaj: osobno dla niskiej glukozy i dla pozostałych, od co 5 minut do co godzinę. Niżej ostrzeżenia z prognozy.</figcaption>
</figure>

</div>

## Powiadomienia o sprzęcie

**Mellis → Ustawienia → podopieczny → Powiadomienia o sprzęcie.** Wszystkie trzy są domyślnie włączone.

- **Zbiornik insuliny**: raz, gdy insuliny wystarczy na mniej niż dobę, i drugi raz, gdy na mniej niż 8 godzin —
  wtedy, gdy dashboard pokazuje zbiornik na żółto („wymień dziś”), a potem na czerwono („wymień teraz”).
  Kolejne przyjdą dopiero po napełnieniu zbiornika (wpis „Insulin Change” w Nightscoucie albo wyraźnie więcej
  jednostek w odczycie pompy).
- **Bateria pompy**: raz poniżej 25 % („Słaba bateria pompy”) i raz poniżej 15 % („Bateria pompy prawie pusta”).
  Kolejne przyjdą dopiero po wymianie baterii (wzrost o co najmniej 10 punktów). Potrzebny jest
  procent baterii, który pętla wysyła do Nightscouta; bez niego to powiadomienie nie przyjdzie.

- **Wkłucie**: pory zależą od godziny, o której wkłucie będzie miało 3 dni. Liczy się je od ostatniego wpisu
  „Site Change” w Nightscoucie, który pętla dodaje przy zmianie wkłucia.

    | Wkłucie będzie miało 3 dni | Powiadomienia |
    |---|---|
    | od 9:00 do 22:00 | o 7:00 tego dnia i w chwili, gdy minęły 3 dni |
    | od 7:00 do 9:00 | tylko o 7:00 |
    | przed 7:00 | o 19:00 poprzedniego wieczoru i o 7:00 |
    | po 22:00 | o 19:00 tego wieczoru i o 7:00 następnego dnia |

    Godziny liczą się w strefie czasowej profilu terapii podopiecznego. Po zmianie wkłucia kolejne powiadomienia
    dotyczą już nowego. Od 22:00 do 7:00 Mellis nie wysyła żadnego z nich.
    Gdy ostatni wpis ma ponad 7 dni, Mellis zakłada, że zmiany nie zapisano, i nie wysyła powiadomienia.

Odczyt pompy starszy niż 6 godzin nie wywołuje powiadomienia. Stuknięcie otwiera listę sprzętu na dashboardzie.

<figure class="screen" markdown>
![Powiadomienia o sprzęcie](../assets/screens/powiadomienia-sprzet.png){ loading=lazy }
<figcaption>Zbiornik insuliny, bateria pompy i wkłucie, każde z własnym przełącznikiem.</figcaption>
</figure>

!!! info "Skąd Mellis wie, na ile wystarczy insuliny"
    Serwer liczy średnie dzienne zużycie insuliny (bolusy, w tym zdalne i ręczne, SMB i podana baza z bazami
    tymczasowymi) z ostatnich do 7 pełnych dni. Pomija dni z luką w danych (ponad 6 godzin bez żadnego wpisu
    insuliny) i potrzebuje co najmniej 2 takich dni. Bez tego kolor zbiornika zależy od procentu napełnienia
    (żółty poniżej 15 %, czerwony poniżej 7 %), a gdy i tego nie wiadomo, od 25 i 10 jednostek.

## Dawka mniejsza niż z przelicznika (opcja serwera) {#dawka-mniejsza-niz-z-przelicznika}

To powiadomienie jest jeszcze sprawdzane i domyślnie jest wyłączone. Włącza je osoba, która instalowała serwer,
ustawieniem `MEAL_UNDERDOSE_ENABLED=true` (zobacz [Aktualizacje](../utrzymanie/aktualizacje.md#wlaczanie-funkcji-na-serwerze)).

Przychodzi raz na posiłek z bolusem, gdy jednocześnie:

- od początku posiłku minęło od 30 minut do 2 godzin,
- dawka do posiłku (bolusy od 20 minut przed jego początkiem do 15 minut po nim) była mniejsza niż 80 % dawki z
  przelicznika i brakuje co najmniej 0,4 j; insulina, którą świadomie odjął kalkulator, nie liczy się jako brak,
- po tej dawce nie było już żadnego bolusa, a posiłek nie ma zaplanowanej kolejnej części ani przypomnienia o drugiej
  dawce,
- glukoza wynosi co najmniej 180 mg/dL, jest co najmniej o 40 mg/dL wyższa niż na początku posiłku i przez ostatnie
  15 minut rosła średnio o co najmniej 1,5 mg/dL na minutę.

Treść podaje posiłek, obie dawki i glukozę, np. Do posiłku „Obiad” podano 1,5 j z 3,2 j. Glukoza 214 i rośnie.
Dotknij, aby policzyć resztę. Brakująca insulina staje się kolejną częścią posiłku. Jej dawkę karta liczy od nowa po
otwarciu, na aktualnych danych. To Ty decydujesz, czy ją podać.

## Co możesz wyłączyć

W **Mellis → Ustawienia → podopieczny** jest sekcja **Powiadomienia**. Wszystko w niej działa tylko na tym telefonie
i tylko dla tego podopiecznego; każdy opiekun ustawia swój telefon sam.

- **Powiadomienia o glikemii** (ekran): domyślnie **wyłączone**; główny przełącznik, rodzaje, powtarzanie.
- **Ostrzeżenia o możliwym hipo** (na tym samym ekranie, w sekcji „Prognoza”): domyślnie **wyłączone**, działają
  niezależnie od głównego przełącznika. Włącz je na telefonach opiekunów, którzy mają reagować. Wyłączenie obejmuje
  cały telefon, także po ponownej instalacji aplikacji.
- **Powiadomienia o sprzęcie** (ekran): zbiornik, bateria pompy i wkłucie, domyślnie włączone.
- **Gotowa odpowiedź**: domyślnie włączone.
- **Przed posiłkami** (plan posiłków): przypomnienia przed zaplanowanymi posiłkami, posiłek bez bolusa i pytanie, czy posiłek został
  zjedzony; domyślnie włączone, ale przychodzą dopiero wtedy, gdy podopieczny ma plan. **Bez przypomnień do…**
  wstrzymuje je do wybranego dnia, a **Usuń plan** usuwa wszystko, co jeszcze przed Wami (u wszystkich opiekunów).

<figure class="screen" markdown>
![Powiadomienia w ustawieniach podopiecznego](../assets/screens/ustawienia-powiadomienia.png){ loading=lazy }
<figcaption>Mellis → Ustawienia → podopieczny: powiadomienia o glikemii i o sprzęcie, „Przed posiłkami” z wstrzymaniem i usunięciem planu, „Co Mellis pamięta” i „Gotowa odpowiedź”.</figcaption>
</figure>

Na telefonie bez internetu powiadomienia nie przyjdą, w tym „Brak odczytów z sensora”: wysyła je serwer.

Przypomnień nie wyłączasz osobno: przychodzą tylko wtedy, gdy sam je ustawiłeś. Opiekun z samym uprawnieniem
„Glukoza i alarmy” dostaje tylko powiadomienia o glukozie i o sprzęcie.

Gdy telefon dostaje powiadomienia o kilku podopiecznych, tytuł zaczyna się od imienia, np. „Zosia · Możliwe
niedocukrzenie”. Powiadomienia o glikemii mają imię w drugiej linijce, pod glukozą.

!!! warning "Mellis nie zastępuje alarmów CGM"
    Powiadomienia z aplikacji Mellis przechodzą przez serwer, internet i Nightscouta, więc mogą przyjść z opóźnieniem albo
    wcale, np. gdy telefon podopiecznego straci zasięg. Alarmy niskiej glukozy w aplikacji sensora albo w pętli
    zostaw włączone.
