# Najczęstsze problemy

## Połączenie z serwerem (SSH)

??? failure "`Permission denied`"
    Złe hasło albo zła nazwa użytkownika. Wklej hasło z maila jeszcze raz (++cmd+v++, potem ++enter++). Niektórzy
    dostawcy logują jako `ubuntu` albo `debian` zamiast `root`.

??? failure "`Connection refused` albo `Connection timed out`"
    Sprawdź adres i port w mailu od dostawcy. Port wpisujesz po `-p`, np. `ssh -p 10123 root@srv00.mikr.us`.

??? failure "`REMOTE HOST IDENTIFICATION HAS CHANGED`"
    Pojawia się po przeinstalowaniu serwera. Wklej **na Macu** komendę, którą Terminal podał w komunikacie
    (zaczyna się od `ssh-keygen -R`), i połącz się ponownie.

??? failure "`command not found: mellis`"
    Wpisałeś ją na Macu. Najpierw połącz się z serwerem komendą `ssh` z notatki: początek linii musi pokazywać nazwę
    serwera.

## Instalacja serwera

??? failure "„Za mało pamięci RAM”"
    Mellis potrzebuje planu z co najmniej 1 GB RAM, a razem z Nightscoutem 2 GB. Wybierz większy plan albo przenieś
    Nightscouta na osobny serwer.

??? failure "Instalacja się przerwała"
    Połącz się z serwerem ponownie i wklej instalator jeszcze raz. Sprawdzi, co już jest zrobione, i zapyta o resztę.

??? failure "„Nie udało się połączyć z Nightscoutem”"
    - Sprawdź, czy adres otwiera się w przeglądarce.
    - Sprawdź token: musi mieć rolę **readable**. Token z prawem zapisu zostanie odrzucony.
    - Adres musi być publiczny. Nightscout dostępny tylko w sieci domowej nie zadziała.
    - W Nightscoucie musi być odczyt glukozy z ostatnich 24 godzin.

??? failure "„Klucz AI nie działa”"
    - Sprawdź, czy na koncie dostawcy są środki (Billing).
    - Skopiuj klucz jeszcze raz, bez spacji na początku i na końcu.

??? failure "Certyfikat HTTPS się nie tworzy"
    - Domena musi wskazywać na adres IP serwera. Sprawdź to w panelu domeny. Zmiana może się rozchodzić do godziny.
    - Porty 80 i 443 muszą być otwarte w zaporze dostawcy serwera.
    - Na Mikrusie wybierz w instalatorze subdomenę Mikrusa zamiast własnej domeny.

## Instalacja aplikacji

??? failure "Wkleiłem komendę aplikacji na serwerze"
    Nic się nie stało: na serwerze nie ma Xcode, więc skrypt się zatrzyma. Wpisz `exit`, otwórz nowe okno Terminala
    i wklej komendę jeszcze raz, na Macu.

??? failure "„No Accounts” albo „Brak konta Apple w Xcode”"
    **Xcode → Settings… → Accounts → +** i zaloguj się kontem Apple Developer. Uruchom skrypt ponownie.

??? failure "Błąd podpisywania (Signing)"
    Skrypt sam otworzy projekt w Xcode. Wybierz cel **GlucoMindApp** (to aplikacja Mellis; cele mają jeszcze starą
    nazwę) → **Signing & Capabilities**, zaznacz **Automatically manage signing** i wybierz swój Team. To samo zrób
    dla celu **GlucoMindWidgets**. Potem uruchom skrypt ponownie.

??? failure "Telefonu nie ma na liście"
    - Podłącz go raz kablem, odblokuj i stuknij **Zaufaj**.
    - Włącz tryb dewelopera: **Ustawienia iOS → Prywatność i ochrona → Tryb dewelopera**.
    - Wybierz **r**, żeby odświeżyć listę.

??? failure "Telefon jest na liście, ale „teraz niedostępny”"
    Odblokuj go i sprawdź, czy jest w tej samej sieci Wi-Fi co Mac. Jeśli to nie pomoże, podłącz go kablem.

??? failure "„Niezaufany deweloper” przy pierwszym uruchomieniu"
    **Ustawienia iOS → Ogólne → VPN i urządzenia zarządzane** → Twoje konto → **Zaufaj**.

Pełny dziennik budowania otworzysz komendą na Macu:

```bash
open ~/.mellis/xcodebuild.log
```

## Łączenie telefonu

??? failure "Pierwszy telefon nie połączył się sam"
    Na serwerze: `mellis` → **Połącz telefon właściciela** i zeskanuj kod QR w aplikacji. Kod działa 10 minut.

??? failure "„Kod nieprawidłowy albo wygasł”"
    Zaproszenie działa 7 dni i tylko raz, kod na kolejny telefon tej samej osoby 10 minut. Poproś o nowy kod.

??? failure "Face ID nie działa przy bolusie"
    Klucz do bolusa jest związany z Face ID z chwili połączenia telefonu. Gdy zmienisz albo dodasz twarz w Face ID,
    klucz przestaje działać: tak działa to zabezpieczenie. Aplikacja poprowadzi Cię przez ponowne połączenie
    telefonu.

## Na co dzień

??? failure "Nie przychodzą powiadomienia"
    1. **Ustawienia iOS → Powiadomienia → Mellis**: czy są włączone?
    2. **Mellis → Ustawienia → Powiadomienia**: ostrzeżenia o hipo są domyślnie wyłączone, włącz je na tym telefonie.
    3. Na serwerze: `mellis` → **Status i logi**. Szukaj błędów APNs. Najczęstsza przyczyna to klucz `.p8`
       z innego konta niż to, którym zbudowano aplikację.

??? failure "Dane się nie odświeżają"
    - Czy telefon podopiecznego ma internet i czy Trio albo Loop wysyła dane do Nightscouta? Sprawdź w samym
      Nightscoucie.
    - Na serwerze: `mellis` → **Status i logi** pokaże czas ostatniego pobrania z Nightscouta.

??? failure "AI nie odpowiada"
    - Mógł się wyczerpać miesięczny limit: aplikacja to pokaże. Zmień go na serwerze: `mellis` → **Zmień ustawienia →
      Limit AI**.
    - Mogły się skończyć środki na koncie dostawcy AI.

??? failure "Bolus nie dociera do Trio albo Loopa"
    - Sprawdź, czy zdalne polecenia działają z Nightscouta albo Loop Follow. Jeśli nie, problem jest w ustawieniach
      pętli.
    - Shared Secret (Trio) albo kod QR (Loop) mógł się zmienić po przebudowaniu pętli. **Mellis → Ustawienia →
      Zdalne sterowanie Trio** (albo **Loop**) → wpisz go ponownie.
    - Klucz `.p8` musi pochodzić z konta, które zbudowało pętlę.

??? failure "Aplikacja przestała się uruchamiać"
    Minął rok od zbudowania. [Przebuduj ją](../utrzymanie/aktualizacje.md#raz-w-roku). Dane są na serwerze, nic
    nie przepadło.
