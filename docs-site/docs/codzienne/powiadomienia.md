# Powiadomienia

Mellis wysyła powiadomienia z serwera, więc przychodzą także wtedy, gdy aplikacja jest zamknięta.

!!! tip "Przy pierwszym uruchomieniu"
    Gdy iOS zapyta, czy Mellis może wysyłać powiadomienia, wybierz **Zezwól**. Jeśli wybrałeś **Nie zezwalaj**,
    zmienisz to w **Ustawieniach iOS → Powiadomienia → Mellis**.

| Powiadomienie | Kiedy przychodzi | Co zrobić |
|---|---|---|
| **Możliwe niedocukrzenie** (albo **Niedocukrzenie**, **Pilne: niedocukrzenie**) | prognoza pokazuje spadek poniżej 70 mg/dL; tylko jeśli włączyłeś ostrzeżenia na tym telefonie | stuknij: zobaczysz propozycję węglowodanów, którą możesz wysłać albo odrzucić („Nie podaję”) |
| **Druga część bolusa**, **Druga dawka · …** | o ustawionej godzinie albo gdy glukoza zacznie rosnąć, jeśli tak wybrałeś przy dawce | stuknij, sprawdź dawkę i wyślij |
| **Bolus na posiłek** | odłożony bolus: glukoza przestała spadać | stuknij, sprawdź dawkę i wyślij |
| **Przypomnienie o WBT** | ok. 2,5 godziny po tłustym albo białkowym posiłku, jeśli wybrałeś przypomnienie | stuknij i zdecyduj o dawce na tłuszcz i białko |
| **Przypomnienie** | przypomnienie ustawione w czacie | stuknij, żeby wrócić do rozmowy |
| **Mellis potrzebuje odpowiedzi** | AI potrzebuje od Ciebie doprecyzowania, żeby odpowiedzieć | stuknij i odpowiedz |
| **Odpowiedź gotowa** | AI odpowiedziało na Twoje pytanie, a aplikacja jest zamknięta albo w tle | stuknij, żeby przeczytać |
| **Kończy się insulina w zbiorniku**, potem **Wymień zbiornik insuliny** | insuliny zostało na mniej niż dobę, a potem na mniej niż 8 godzin średniego zużycia, np. „Insuliny w zbiorniku zostało na ok. 8 godz. (6 j).”; każde raz na napełnienie zbiornika | stuknij, żeby zobaczyć sprzęt; wymień zbiornik albo wkład |
| **Druga dawka podana**, **WBT podane** | inny opiekun podał dawkę, o której było przypomnienie | nic: przypomnienie znika też u Ciebie |

<figure class="screen" markdown>
![Propozycja dosłodzenia w rozmowie](../assets/screens/karta-doslodzenia.png){ loading=lazy }
<figcaption>Propozycja dosłodzenia w rozmowie. Stuknij „Podano 6 g”, żeby zapisać dosłodzenie albo wysłać je do pętli.</figcaption>
</figure>

!!! info "Alarm sprzed ponad 30 minut"
    Starszy alarm (albo propozycja dosłodzenia w czacie) ma znaczek **„Nieaktualne · … temu”**, a glukoza przy nim
    jest podpisana **„wtedy:”**, bo to odczyt z chwili alarmu, nie obecny. Z takiego alarmu Mellis nic nie wyśle do
    pętli: prognoza i dawka są sprzed zmiany glukozy. Nadal możesz zapisać, co podano („Podano dosłodzenie”,
    „Podano 6 g”), albo wybrać „Nie podaję”. Gdy trzeba dosłodzić teraz, sprawdź aktualną glukozę i wyślij
    dosłodzenie z karty Posiłki („+” → „Dosłodzenie”).

!!! info "Nowa rozmowa po godzinie"
    Gdy otwierasz kartę Rozmowy, a ostatnia rozmowa była cicha od ponad godziny, Mellis pokazuje pustą, nową rozmowę.
    Poprzednia zostaje w liście ☰. Rozmowa otwarta z powiadomienia albo z listy, wiadomość w trakcie pisania i pytanie,
    na które Mellis czeka, zostają na ekranie.

!!! info "„Gdy glukoza zacznie rosnąć”"
    Przy rozłożonym albo odłożonym bolusie możesz wybrać przypomnienie o drugiej części „gdy glukoza zacznie rosnąć”.
    Przychodzi, gdy trzy kolejne odczyty z około 10 minut rosną. Serwer pilnuje go przez godzinę: jeśli glukoza w tym
    czasie nie zacznie rosnąć, przypomnienie wygasa bez powiadomienia.

## Co możesz wyłączyć

W **Mellis → Ustawienia → Powiadomienia** są trzy przełączniki. Działają tylko na tym telefonie i tylko dla
wybranego podopiecznego:

- **Ostrzeżenia o możliwym hipo**: domyślnie **wyłączone**. Włącz je na telefonach opiekunów, którzy mają
  reagować, np. tylko u tego, kto jest z podopiecznym.
- **Gotowa odpowiedź**: domyślnie włączone.
- **Zbiornik insuliny**: domyślnie włączone. Przychodzi raz, gdy insuliny wystarczy na mniej niż dobę, i drugi raz,
  gdy na mniej niż 8 godzin. Kolejne przyjdą dopiero po napełnieniu zbiornika (wpis „Insulin Change” w Nightscoucie
  albo wyraźnie więcej jednostek w odczycie pompy).

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
„Glukoza i alarmy” dostaje tylko ostrzeżenia o glukozie i o zbiorniku insuliny.

Gdy telefon dostaje powiadomienia o kilku podopiecznych, tytuł zaczyna się od imienia, np. „Zosia · Możliwe
niedocukrzenie”.

!!! warning "Mellis nie zastępuje alarmów CGM"
    Powiadomienia z aplikacji Mellis przechodzą przez serwer, internet i Nightscouta, więc mogą przyjść z opóźnieniem albo
    wcale, np. gdy telefon podopiecznego straci zasięg. Alarmy niskiej glukozy w aplikacji sensora albo w pętli
    zostaw włączone.
