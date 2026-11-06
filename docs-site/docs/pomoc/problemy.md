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
    Mellis potrzebuje planu z co najmniej 1 GB RAM, także razem z Nightscoutem. Wybierz większy plan albo przenieś
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

??? failure "„Xcode musi raz utworzyć profile podpisywania”"
    To normalne przy pierwszej instalacji i po aktualizacji, która dodaje nowy cel. Skrypt sam otworzy projekt w Xcode.

    1. Sprawdź, czy w **Xcode → Settings… → Accounts** jest Twoje konto Apple Developer. Jeśli nie ma, dodaj je przyciskiem **+**.
    2. U góry okna wybierz schemat **GlucoMindApp** i swojego iPhone'a. Gdy nie ma go na liście, wybierz **Any iOS Device**.
    3. Naciśnij ++cmd+b++ i poczekaj na komunikat **Build Succeeded**.
    4. Wróć do Terminala i odpowiedz **t**: skrypt zbuduje aplikację ponownie i ją zainstaluje.

??? failure "Błąd podpisywania (Signing)"
    Skrypt sam otworzy projekt w Xcode. Wybierz cel **GlucoMindApp** (to aplikacja Mellis; cele mają jeszcze starą
    nazwę) → **Signing & Capabilities**, zaznacz **Automatically manage signing** i wybierz swój Team. To samo zrób
    dla celów **GlucoMindWidgets**, **GlucoMindWatch** i **GlucoMindWatchWidgets**. Potem uruchom skrypt ponownie.

??? failure "Telefonu nie ma na liście"
    - Podłącz go raz kablem, odblokuj i stuknij **Zaufaj**.
    - Włącz tryb dewelopera: **Ustawienia iOS → Prywatność i ochrona → Tryb dewelopera**.
    - Wybierz **r**, żeby odświeżyć listę.

??? failure "Telefon jest na liście, ale „teraz niedostępny”"
    Odblokuj go i sprawdź, czy jest w tej samej sieci Wi-Fi co Mac. Jeśli to nie pomoże, podłącz go kablem.

??? failure "„Niezaufany deweloper” przy pierwszym uruchomieniu"
    **Ustawienia iOS → Ogólne → VPN i urządzenia zarządzane** → Twoje konto → **Zaufaj**.

??? failure "Mellis nie instaluje się na zegarku, znowu widać „Instaluj”"
    Na iPhonie w aplikacji **Watch → Aplikacje** instalacja Mellis kręci się, po chwili przerywa i znowu widać
    **Instaluj**. Restart zegarka tu nie pomaga. Pomaga pobranie nowych profili podpisywania i ponowne zbudowanie
    aplikacji. Aplikacja zbudowana, zanim zegarek trafił na konto Apple Developer, może nie mieć go w swoim profilu.

    Wszystko robisz **na Macu, na którym budujesz aplikację**.

    1. Sprawdź, czy zegarek jest włączony na [liście urządzeń](https://developer.apple.com/account/resources/devices/list).
       Jeśli jest, przejdź do kroku 2. Jeśli go nie ma, otwórz w Xcode **Window → Devices and Simulators** i skopiuj pole
       **Identifier** zegarka. Potem dodaj zegarek na liście przyciskiem **+**.
    2. Zamknij Xcode i odsuń stare profile na Biurko:

        ```bash
        mv ~/Library/Developer/Xcode/UserData/"Provisioning Profiles" ~/Desktop/Provisioning-Profiles-kopia
        ```

    3. Uruchom komendę z [aktualizacji aplikacji](../utrzymanie/aktualizacje.md#aplikacja) i wybierz iPhone'a. Jeśli skrypt
       napisze, że Xcode musi utworzyć profile, zrób to, co opisuje punkt „Xcode musi raz utworzyć profile podpisywania”.
    4. Na iPhonie otwórz **Watch → Aplikacje** i kliknij **Instaluj** przy Mellis.

    Przeniesienie profili nie zmienia aplikacji zainstalowanych na telefonach, także Trio i Loopa. Kopię z Biurka usuń, gdy
    wszystko zadziała.

    **Gdy zegarka nie widać w Xcode:** włącz na iPhonie **Ustawienia → Prywatność i ochrona → Tryb dewelopera**, odblokuj
    zegarek i nie pozwól, żeby ekran zgasł. Jeśli pojawi się pytanie o zaufanie (**Trust**), zaakceptuj je. Czasem trzeba
    też podłączyć iPhone'a kablem.

    **Gdy Apple pokaże ekran „Update your device list”:** to przegląd listy urządzeń na początku nowego roku członkostwa.
    Bez niego nie dodasz nowego urządzenia. Najpierw zrób zrzut ekranu z identyfikatorami i zostaw zaznaczone urządzenia,
    których używasz. Po zatwierdzeniu sprawdź listę, a jeśli czegoś brakuje, dodaj to ponownie, zanim zaczniesz budować
    aplikację.

Pełny dziennik budowania otworzysz komendą na Macu:

```bash
open ~/.mellis/xcodebuild.log
```

## Łączenie telefonu

??? failure "Pierwszy telefon nie połączył się sam"
    Na serwerze: `mellis` → **Połącz telefon właściciela** i zeskanuj kod QR w aplikacji. Kod działa 10 minut.
    Jeśli instalacja aplikacji przerwała się, zanim podałeś swoje imię, serwer nie ma jeszcze właściciela: Mellis
    zapyta wtedy o imię, pokaże kod QR i od razu kod odzyskiwania (zapisz go w notatce „Mellis”).

??? failure "Telefon połączył się jako ktoś inny (po przywróceniu kopii)"
    Kopia starej instalacji może mieć kilku właścicieli, np. testową osobę. `mellis` → **Połącz telefon
    właściciela** pyta wtedy **Kogo połączyć?** i przy każdej osobie pokazuje ostatnią aktywność i liczbę telefonów.
    Połącz telefon jeszcze raz i wybierz siebie. Telefon połączony z niewłaściwą osobą odłączysz potem w
    **Ustawienia → Udostępnianie**.

??? failure "„Kod nieprawidłowy albo wygasł”"
    Zaproszenie działa 7 dni i tylko raz, kod na kolejny telefon tej samej osoby 10 minut. Poproś o nowy kod.

??? failure "Face ID nie działa przy bolusie"
    Klucz do bolusa jest związany z Face ID z chwili połączenia telefonu. Gdy zmienisz albo dodasz twarz w Face ID,
    klucz przestaje działać: tak działa to zabezpieczenie. Aplikacja poprowadzi Cię przez ponowne połączenie
    telefonu.

## Na co dzień

??? failure "Komplikacja pisze „Otwórz Mellis na iPhonie”"
    Zegarek nie ma jeszcze dostępu od telefonu. Otwórz Mellis jednocześnie na iPhonie i na zegarku.

??? failure "Komplikacja spóźnia się za odczytami"
    Nowe odczyty zwykle przychodzą co kilka minut, więc krótka przerwa jest normalna. Na watchOS starszym niż 26
    o odświeżaniu decyduje watchOS. Na watchOS 26 lub nowszym sprawdź, czy klucz APNs obejmuje cały zespół
    ([Apple Watch](../instalacja/aplikacja.md#apple-watch)). Apple ogranicza też liczbę takich powiadomień.

??? failure "Nie przychodzą powiadomienia"
    1. **Ustawienia iOS → Powiadomienia → Mellis**: czy są włączone?
    2. **Mellis → Ustawienia → podopieczny → Powiadomienia o glikemii**: powiadomienia o glikemii i ostrzeżenia
       o możliwym hipo są domyślnie wyłączone, włącz je na tym telefonie. Sprawdź też, czy dany rodzaj jest włączony.
    3. Powiadomienie o baterii pompy przychodzi tylko wtedy, gdy pętla wysyła do Nightscouta procent baterii.
    4. Na serwerze: `mellis` → **Status i logi**. Szukaj błędów APNs. Najczęstsza przyczyna to klucz `.p8`
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
