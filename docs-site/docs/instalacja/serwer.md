# 2. Serwer

<span class="time">ok. 15 minut</span>

Serwer to mały komputer w internecie, który działa całą dobę. Na nim Mellis pobiera dane z Nightscouta, wysyła
powiadomienia i rozmawia z AI.

## Wybierz serwer

Wystarczy najmniejszy plan z **co najmniej 1 GB RAM** dla samego Mellisa albo **2 GB**, jeśli na tym samym serwerze
działa już Twój Nightscout. Procesor nie ma znaczenia.

=== "Mikrus (polecany na start)"

    Polski, tani hosting, popularny wśród osób, które stawiają Nightscouta.

    - Wybierz plan z co najmniej 1 GB RAM, albo 2 GB, jeśli ma tam działać też Nightscout.
    - Po zakupie dostaniesz e-mail z adresem serwera, portem SSH i hasłem.
    - Mikrus nie daje własnego adresu IPv4. Instalator poprowadzi Cię przez ustawienie subdomeny w panelu Mikrusa:
      powie, jaki port wpisać, i poczeka, aż skończysz.

=== "Inny serwer VPS"

    Hetzner, OVH, netcup i podobne. Wybierz **Ubuntu 24.04** albo **Debian 12** i plan z co najmniej 1 GB RAM.

    - Potrzebujesz domeny albo subdomeny, która wskazuje na adres IP serwera (rekord A). Darmowa subdomena z DuckDNS
      też wystarczy.
    - Instalator sam zrobi certyfikat HTTPS. Porty 80 i 443 muszą być otwarte.
    - Niektórzy dostawcy logują nie jako `root`, tylko np. jako `ubuntu`. Wtedy w komendzie `ssh` wpisz tę nazwę,
      a instalator poprosi o hasło do `sudo`.

=== "Serwer w domu (dla zaawansowanych)"

    Raspberry Pi 4 lub 5 z 64-bitowym systemem, mini PC, NAS z Dockerem. Działa, ale:

    - komputer musi być włączony całą dobę, inaczej nie dostaniesz ostrzeżeń o niedocukrzeniu,
    - do połączenia z internetem bez otwierania portów instalator zaproponuje Cloudflare Tunnel.

## Uruchom instalator

Oba kroki robisz po kolei, w **tym samym oknie Terminala**: najpierw łączysz się z serwerem, a potem wklejasz
instalator.

<div class="steps" markdown>

1.  **Połącz się z serwerem** · na Macu

    Otwórz **Terminal** (Spotlight: ++cmd+space++, wpisz „Terminal”) i wpisz dane z maila od dostawcy:

    ```bash
    ssh -p PORT root@ADRES-SERWERA
    ```

    Za pierwszym razem zobaczysz pytanie o „fingerprint”: wpisz `yes` i naciśnij ++enter++. Potem wklej hasło
    (++cmd+v++) i naciśnij ++enter++. Podczas wpisywania hasła nic się nie wyświetla, to normalne. Jeśli zobaczysz
    `Permission denied`, hasło było złe: spróbuj jeszcze raz.

    Gdy się uda, początek linii zmieni się na nazwę serwera, np. `root@srv12:~#`. Od tej chwili wszystko, co
    wpiszesz w tym oknie, dzieje się **na serwerze**, a nie na Macu.

    Zapisz tę komendę `ssh` w notatce „Mellis”: będziesz jej używać zawsze, gdy trzeba coś zrobić na serwerze.

2.  **Wklej instalator** · na serwerze, w tym samym oknie

    ```bash
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/mheblewski/Mellis/main/scripts/install-server.sh)"
    ```

</div>

## Odpowiedz na pytania

Instalator najpierw sprawdzi serwer (pamięć, dysk, Dockera), a potem zada pytania. Odpowiedzi wklejasz z notatki
„Mellis”. Na pierwsze pytanie, **Nowa instalacja** czy **Przywróć z kopii**, odpowiedz `1`, chyba że przenosisz
Mellisa z innego serwera ([Przeprowadzka](../utrzymanie/kopie.md#przywracanie)).

<div class="steps" markdown>

1.  **Nightscout**

    Adres i token. Instalator od razu sprawdzi połączenie i pokaże ostatni odczyt:

    ```text
    Adres Nightscouta: https://moj-nightscout.example.pl
    Token (tylko do odczytu): ••••••••
    ✓ Połączono. Ostatni odczyt: 142 mg/dL, 2 min temu. Pętla: Trio 0.5.
    ```

    Token z prawem zapisu zostanie odrzucony: Mellis tylko czyta z Nightscouta.

2.  **Podopieczny**

    Imię i rok urodzenia: AI dopasowuje odpowiedzi do wieku. Kolejną osobę, z jej własnym Nightscoutem i tokenem,
    możesz dodać od razu albo później w aplikacji.

3.  **AI**

    Najpierw wybierasz, kto ma odpowiadać: **OpenAI** (polecany na start) albo **Claude (Anthropic)**, a potem
    wklejasz klucz.

    - **OpenAI:** ten sam klucz obsłuży też wyszukiwanie w bazie wiedzy i rozpoznawanie mowy. Na tym koniec.
    - **Claude:** instalator zapyta jeszcze o **opcjonalny klucz OpenAI**. Daje lepsze wyszukiwanie w bazie wiedzy
      i rozpoznawanie mowy na serwerze, a kosztuje grosze miesięcznie. Naciśnij ++enter++, żeby pominąć: wtedy
      wyszukiwanie działa po słowach, a mowę rozpoznaje telefon.

    Na koniec instalator sam przygotuje **bazę wiedzy** (opracowania wytycznych z odnośnikami do oryginałów
    i dokumentację Trio/OpenAPS). Z kluczem OpenAI kosztuje to około 1 centa, jednorazowo i przy aktualizacjach,
    które zmieniają bazę. Bez niego wyszukiwanie działa po słowach, za darmo.

    Każdy klucz instalator od razu sprawdza. Na koniec ustawiasz **miesięczny limit wydatków na AI w USD**, np. 15.
    Po jego przekroczeniu AI przestaje odpowiadać do końca miesiąca, a reszta aplikacji działa dalej.

4.  **Powiadomienia (APNs)**

    Key ID, Team ID i zawartość pliku `.p8` z notatki. Wklej ją w Terminalu w całości, razem z liniami
    `-----BEGIN PRIVATE KEY-----` i `-----END PRIVATE KEY-----`. Instalator sam rozpozna koniec klucza.

    Klucz musi pochodzić z **tego samego konta Apple Developer**, którym zbudujesz aplikację na Macu.

5.  **Adres serwera**

    Domena, subdomena Mikrusa albo Cloudflare Tunnel, zależnie od serwera. Instalator podpowie, co wybrać.

</div>

Na koniec zobaczysz podsumowanie:

```text
✓ Mellis działa: https://mellis.moja-domena.pl
✓ Pierwsza kopia bazy zapisana.

Zapisz w notatce „Mellis”:
  Adres serwera:      https://mellis.moja-domena.pl
  Kod konfiguracji:   7KQ2M-9XH4T-3BWRZ-8QJ5N   (do instalacji aplikacji)

Aplikację zainstalujesz na Macu (nowe okno Terminala) komendą:
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/mheblewski/Mellis/main/scripts/install-app.sh)" -- --server https://mellis.moja-domena.pl --code 7KQ2M-9XH4T-3BWRZ-8QJ5N
Kod odzyskiwania pokaże skrypt na Macu, gdy połączy Twój telefon: zapisz go wtedy w notatce.

Zarządzanie serwerem: wpisz  mellis
```

!!! warning "Zapisz adres i kod konfiguracji"
    - **Adres serwera** i **kod konfiguracji** wpiszesz zaraz przy instalacji aplikacji (albo wkleisz na Macu całą
      pokazaną komendę). Kod konfiguracji łączy z serwerem **jeden, pierwszy telefon** i przestaje działać, gdy ten
      telefon się połączy. Do tego czasu działa bez limitu czasu.
    - **Kod odzyskiwania** dostaniesz w następnym kroku, na Macu, gdy połączy się Twój telefon. Jest pokazywany tylko
      raz i przyda się, jeśli zgubisz wszystkie swoje telefony.
    - Kod konfiguracji pokażesz ponownie na serwerze: `mellis setup-code`.

??? failure "Coś przerwało instalację"
    Połącz się z serwerem jeszcze raz (komenda `ssh` z notatki) i wklej instalator ponownie. Instalator sprawdzi, co
    już jest zrobione, i zapyta o resztę. Więcej w [Najczęstszych problemach](../pomoc/problemy.md#instalacja-serwera).

## Wróć na Maca

Wpisz `exit` i naciśnij ++enter++ (albo zamknij okno Terminala). Początek linii znów pokaże nazwę Twojego Maca.
Następny krok robisz już **na Macu**.

## Zarządzanie serwerem

Gdy kiedyś trzeba będzie coś zmienić, połącz się z serwerem komendą `ssh` z notatki i wpisz `mellis`:

```text
Mellis · działa · ostatnia kopia: dziś 03:00
  1. Status i logi
  2. Aktualizuj
  3. Kopia zapasowa / przywróć
  4. Zmień ustawienia (Nightscout, klucz AI, limit AI, domena, APNs, wersja)
  5. Połącz telefon właściciela (kod QR, gdy pierwszy telefon nie połączył się sam)
  6. Odzyskaj dostęp właściciela
  7. Odinstaluj
```

[Dalej: aplikacja :material-arrow-right:](aplikacja.md){ .md-button .md-button--primary }
