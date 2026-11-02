# Powiadomienia

Mellis wysyła powiadomienia z serwera, więc przychodzą także wtedy, gdy aplikacja jest zamknięta.

!!! tip "Przy pierwszym uruchomieniu"
    Gdy iOS zapyta, czy Mellis może wysyłać powiadomienia, wybierz **Zezwól**. Jeśli wybrałeś **Nie zezwalaj**,
    zmienisz to w **Ustawieniach iOS → Powiadomienia → Mellis**.

| Powiadomienie | Kiedy przychodzi | Co zrobić |
|---|---|---|
| **Możliwe niedocukrzenie** (albo **Niedocukrzenie**, **Pilne: niedocukrzenie**) | prognoza pokazuje spadek poniżej 70 mg/dL; tylko jeśli włączyłeś ostrzeżenia na tym telefonie. Treść zaczyna się od obecnej glukozy i jej zmiany w 5 minut, np. „Teraz 95 mg/dL, −4 w 5 min · ok. 14:30 może spaść poniżej 70 · proponuję 3 g” | podaj węglowodany w pętli albo zapisz je kartą w rozmowie; stuknij, żeby zobaczyć wykres, prognozę i wyliczenie dawki |
| **Druga część bolusa**, **Druga dawka · …** | o ustawionej godzinie albo gdy glukoza zacznie rosnąć, jeśli tak wybrałeś przy dawce | stuknij, sprawdź dawkę i wyślij |
| **Bolus na posiłek** | odłożony bolus: glukoza przestała spadać | stuknij, sprawdź dawkę i wyślij |
| **Przypomnienie o WBT** | ok. 2,5 godziny po tłustym albo białkowym posiłku, jeśli wybrałeś przypomnienie | stuknij i zdecyduj o dawce na tłuszcz i białko |
| **Przypomnienie** | przypomnienie ustawione w czacie | stuknij, żeby wrócić do rozmowy |
| **Mellis potrzebuje odpowiedzi** | AI potrzebuje od Ciebie doprecyzowania, żeby odpowiedzieć | stuknij i odpowiedz |
| **Odpowiedź gotowa** | AI odpowiedziało na Twoje pytanie, a aplikacja jest zamknięta albo w tle | stuknij, żeby przeczytać |
| **Kończy się insulina w zbiorniku**, potem **Wymień zbiornik insuliny** | insuliny zostało na mniej niż dobę, a potem na mniej niż 8 godzin średniego zużycia, np. „Insuliny w zbiorniku zostało na ok. 8 godz. (6 j).”; każde raz na napełnienie zbiornika | stuknij, żeby zobaczyć sprzęt; wymień zbiornik albo wkład |
| **❗ 65 ↘ −4** (glukoza nisko), **⚠️ 185 ↑ +11** (spada / rośnie / wysoko) | powiadomienia o glikemii, jeśli je włączyłeś: tytuł to glukoza, strzałka i zmiana w 5 minut, opis mówi, co się dzieje, a pod spodem IOB i COB | sprawdź glukozę i zdecyduj, czy reagować |
| **Glukoza szybko rośnie**, **Glukoza szybko spada** | dwie strzałki w górę albo w dół; w opisie glukoza, strzałka, zmiana, IOB i COB | sprawdź, co się dzieje |
| **Brak danych** | przez 10 minut nie przyszedł żaden pomiar, np. „Brak pomiarów od 12 min.”; potem co 5 minut, dopóki nie wróci | sprawdź sensor, telefon z pętlą i Nightscouta |
| **Słaba bateria pompy**, potem **Bateria pompy prawie pusta** | bateria pompy poniżej 25 %, a potem poniżej 15 %; każde raz na naładowanie albo wymianę | naładuj albo wymień baterię |
| **Druga dawka podana**, **WBT podane** | inny opiekun podał dawkę, o której było przypomnienie | nic: przypomnienie znika też u Ciebie |

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

    ISF / ICR mówi, o ile mg/dL podnosi glukozę 1 g węglowodanów. Wynik jest w granicach od 3 g do 20 g naraz, a
    poniżej 54 mg/dL to co najmniej tyle, ile podnosi glukozę o ok. 70 mg/dL. Węglowodany, które jeszcze się
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

## Co możesz wyłączyć

W **Mellis → Ustawienia → podopieczny → Powiadomienia** są dwa ekrany i jeden przełącznik. Działają tylko na tym
telefonie i tylko dla tego podopiecznego:

- **Powiadomienia o glikemii**: domyślnie **wyłączone**. Na tym ekranie:
    - główny przełącznik;
    - **Kiedy**: każdy rodzaj osobno — glukoza nisko (poniżej 70), glukoza spada (poniżej 80, gdy spada), glukoza
      rośnie (powyżej 160), wysoko (powyżej 180), bardzo wysoko (powyżej 250; trzy ostatnie tylko gdy rośnie),
      szybka zmiana (dwie strzałki) i brak danych. Możesz je ustawić także przy wyłączonym głównym przełączniku;
    - **Powtarzaj**: jak często to samo powiadomienie wraca, dopóki stan trwa — osobno dla niskiej glukozy
      (domyślnie co 15 min) i dla pozostałych (domyślnie co 30 min), od co 5 min do co godzinę. „Co 5 min” to
      powiadomienie przy każdym pomiarze;
    - **Ostrzeżenia o możliwym hipo** (prognoza): domyślnie **wyłączone**, działają niezależnie od głównego
      przełącznika. Włącz je na telefonach opiekunów, którzy mają reagować. Wyłączenie obejmuje cały telefon, także
      po ponownej instalacji aplikacji.
- **Powiadomienia o sprzęcie**:
    - **Zbiornik insuliny**: domyślnie włączone. Przychodzi raz, gdy insuliny wystarczy na mniej niż dobę, i drugi
      raz, gdy na mniej niż 8 godzin. Kolejne przyjdą dopiero po napełnieniu zbiornika (wpis „Insulin Change”
      w Nightscoucie albo wyraźnie więcej jednostek w odczycie pompy).
    - **Bateria pompy**: domyślnie włączone. Raz poniżej 25 % i raz poniżej 15 %. Kolejne przyjdą dopiero po
      naładowaniu albo wymianie baterii (wzrost o co najmniej 10 punktów). Potrzebny jest procent baterii w danych
      pompy w Nightscoucie.
- **Gotowa odpowiedź**: domyślnie włączone.

Na telefonie bez internetu powiadomienia nie przyjdą, w tym „Brak danych”: wysyła je serwer.

!!! info "Skąd Mellis wie, na ile wystarczy insuliny"
    Serwer liczy średnie dzienne zużycie insuliny (bolusy, w tym zdalne i ręczne, SMB i podana baza z bazami
    tymczasowymi) z ostatnich do 7 pełnych dni. Pomija dni z luką w danych (ponad 6 godzin bez żadnego wpisu
    insuliny) i potrzebuje co najmniej 2 takich dni. Bez tego kolor zbiornika zależy od procentu napełnienia
    (żółty poniżej 15 %, czerwony poniżej 7 %), a gdy i tego nie wiadomo, od 25 i 10 jednostek.

<figure class="screen" markdown>
![Przełączniki powiadomień](../assets/screens/ustawienia-powiadomienia.png){ loading=lazy }
<figcaption>Mellis → Ustawienia: przełączniki dla wybranego podopiecznego, tylko na tym telefonie.</figcaption>
</figure>

Przypomnień nie wyłączasz osobno: przychodzą tylko wtedy, gdy sam je ustawiłeś. Opiekun z samym uprawnieniem
„Glukoza i alarmy” dostaje tylko powiadomienia o glukozie i o sprzęcie.

Gdy telefon dostaje powiadomienia o kilku podopiecznych, tytuł zaczyna się od imienia, np. „Zosia · Możliwe
niedocukrzenie”.

!!! warning "Mellis nie zastępuje alarmów CGM"
    Powiadomienia z aplikacji Mellis przechodzą przez serwer, internet i Nightscouta, więc mogą przyjść z opóźnieniem albo
    wcale, np. gdy telefon podopiecznego straci zasięg. Alarmy niskiej glukozy w aplikacji sensora albo w pętli
    zostaw włączone.
