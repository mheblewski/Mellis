# Instalacja aplikacji Mellis na iPhonie

Mellis budujesz sam, tak jak Trio albo Loop: na swoim Macu, swoim kontem Apple Developer. Wystarczy jedno polecenie
w Terminalu, a skrypt przeprowadzi Cię krok po kroku, zainstaluje aplikację i połączy Twój telefon z serwerem.
Instrukcja dla użytkownika: `docs-site/docs/instalacja/aplikacja.md`.

## Czego potrzebujesz

- Maca z aktualnym Xcode (z App Store), uruchomionym przynajmniej raz.
- Płatnego konta Apple Developer (tego samego, którym budujesz Trio albo Loop), zalogowanego w Xcode:
  Xcode → Settings… → Accounts → + → Apple ID.
- iPhone'a, który był choć raz podłączony do tego Maca kablem (patrz niżej).
- **Adresu serwera** i **kodu konfiguracji** z końca instalacji serwera (notatka „Mellis”).

Nic więcej nie trzeba instalować: `jq` nie jest potrzebny (JSON czyta `python3`, który jest razem z Xcode). XcodeGen
jest potrzebny tylko wtedy, gdy w kodzie brakuje projektu Xcode (skrypt zaproponuje instalację przez Homebrew).

## Uruchomienie

Otwórz Terminal i wklej:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/mheblewski/Mellis/v1.0.6/scripts/install-app.sh)"
```

Skrypt:

0. Pokazuje zdanie „Mellis to projekt DIY, nie wyrób medyczny. Używasz go na własną odpowiedzialność; decyzje
   o leczeniu podejmujesz Ty.” i idzie dalej tylko po wpisaniu `tak` (wielkość liter i spacje nie mają znaczenia).
   Każda inna odpowiedź albo brak odpowiedzi kończy skrypt, zanim cokolwiek zbuduje. `MELLIS_ACCEPT_DIY=tak`
   akceptuje z góry (uruchomienie bez terminala).
1. Sprawdza Xcode (licencja, platforma iOS), git i python3. Jeśli czegoś brakuje, mówi, co zrobić.
2. Pobiera kod do katalogu `~/Mellis` (przy kolejnym uruchomieniu tylko go aktualizuje).
3. Odczytuje Twój Team ID z Xcode i pyta o potwierdzenie (przy kilku kontach pokazuje listę).
4. Pyta o **Adres serwera** i **Kod konfiguracji** (`7KQ2M-9XH4T-3BWRZ-8QJ5N`; wielkość liter, spacje i myślniki
   nie mają znaczenia). Zamiast obu można wkleić cały link `mellis://pair?server=…&code=…`. Skrypt sprawdza, czy
   serwer odpowiada (`GET /v1/setup`, `GET /v1/app-config`). Gdy telefon właściciela jest już połączony, o kod nie
   pyta: kolejne telefony łączy się zaproszeniem.
5. Wybiera wersję zgodną z serwerem: wydanie `v<wersja serwera>` (z `GET /v1/app-config` → `server.version`), gdy go
   nie ma: najnowsze wydanie, a gdy repozytorium nie ma wydań: gałąź domyślną. `--ref` to zmienia.
6. Ustawia własny identyfikator aplikacji `pl.mellis.<TeamID>` i tryb bez kont (`AUTH_MODE = device`, bez Cognito
   i bez adresu serwera w aplikacji: adres przychodzi z parowania).
7. Pokazuje listę telefonów:

   ```text
   1) iPhone Ani · iOS 26.1 · Wi-Fi · połączony
   2) iPhone Tomka · iOS 26.0 · kabel · połączony
   3) Wszystkie z listy
   0) Nie instaluj, tylko zbuduj
   r) Odśwież listę
   Na który telefon zainstalować? [1]:
   ```

8. Buduje aplikację i instaluje ją bez klikania w Xcode.
9. **Łączy pierwszy telefon z serwerem**: otwiera na nim aplikację Mellis z linkiem łączenia (`xcrun devicectl device process
   launch --payload-url "mellis://pair?…"`). Aplikacja za pierwszym razem prosi o **Rozumiem i akceptuję** (to samo
   zdanie co skrypt, zapamiętywane na telefonie), potem pokazuje adres serwera, stukasz **Połącz**, a skrypt czeka,
   aż serwer potwierdzi telefon właściciela. Kod konfiguracji łączy tylko jeden telefon: przy **Wszystkie z listy**
   łączy się pierwszy z listy, pozostałe dołączają zaproszeniem (Mellis → Ustawienia → Udostępnianie → Zaproś osobę).

Odpowiedzi są zapamiętywane w `~/.mellis/install-app.env` (tylko dla Twojego użytkownika, bez kluczy), więc następnym
razem wystarczy kilka razy nacisnąć Enter. Kod konfiguracji jest tam tylko do chwili połączenia telefonu, potem
skrypt go usuwa. Ostatnio wybrany telefon jest domyślny.

### Kod konfiguracji

Skrypt przyjmuje dwa rodzaje kodu, które drukuje serwer:

- **kod łączenia** właściciela (z `POST /v1/setup/owner` albo `mellis` → Połącz telefon właściciela): trafia wprost
  do linku `mellis://pair?server=…&code=…`. Działa 10 minut od wydania.
- **kod instalacji serwera** (`SETUP_CODE`): skrypt rozpoznaje go (`GET /v1/setup` z nagłówkiem
  `X-Mellis-Setup-Code` zwraca podopiecznych) i tuż przed otwarciem linku wymienia na świeży kod łączenia
  (`POST /v1/setup/owner`). Pyta wtedy o Twoje imię i pokazuje **kod odzyskiwania** do zapisania w notatce.

Serwer można podać od razu w poleceniu (np. gdy wypisze je instalator serwera):

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/mheblewski/Mellis/v1.0.6/scripts/install-app.sh)" -- --server https://mellis.example.pl --code 7KQ2M-9XH4T-3BWRZ-8QJ5N
```

## Pierwszy raz z nowym telefonem

1. Podłącz iPhone'a do Maca kablem, odblokuj go i stuknij **Zaufaj**.
2. Włącz Tryb dewelopera: **Ustawienia → Prywatność i ochrona → Tryb dewelopera** (telefon się zrestartuje).
3. Uruchom skrypt i w liście telefonów wybierz **r** (odśwież).

Od tej pory telefon jest widoczny także przez Wi-Fi, bez kabla. Jeśli na liście ma dopisek „teraz niedostępny”:
odblokuj go i upewnij się, że jest w tej samej sieci Wi-Fi co Mac.

Po pierwszej instalacji iPhone może pokazać „Niezaufany deweloper”: wejdź w **Ustawienia → Ogólne → VPN
i urządzenia**, wybierz swoje konto i stuknij **Zaufaj**. Skrypt wtedy czeka i po Enter otwiera aplikację Mellis jeszcze raz.

## Aktualizacja i coroczne przebudowanie

Aplikacja zbudowana kontem deweloperskim działa rok. Żeby ją odświeżyć albo zaktualizować, uruchom to samo
polecenie jeszcze raz. Konfiguracja zostaje, a telefon pozostaje połączony z serwerem.

Przydatne opcje (dopisz na końcu polecenia po `-- `, np. `/bin/bash -c "$(curl …)" -- --ref v1.0.0`):

| Opcja | Co robi |
|---|---|
| `--server ADRES` | adres serwera bez pytania |
| `--code KOD` | kod konfiguracji (albo cały link `mellis://pair?…`) bez pytania |
| `--ref v1.0.0` | konkretna wersja (tag wydania, gałąź albo commit) zamiast zgodnej z serwerem |
| `--dir ~/Kod/Mellis` | inny katalog na kod |
| `--no-update` | bez pobierania nowego kodu |
| `--no-install` | tylko zbuduj, nie instaluj |
| `--dry-run` | sprawdź wszystko i pokaż telefony, bez budowania |
| `--debug` | konfiguracja Debug (dopuszcza serwer `http://` do testów lokalnych) |

## Gdy coś nie działa

- **Błąd podpisywania**: skrypt otworzy projekt w Xcode. Wybierz cel **GlucoMindApp** → **Signing & Capabilities**,
  zaznacz „Automatically manage signing” i wybierz swój Team; to samo dla celu **GlucoMindWidgets**. Potem uruchom
  skrypt ponownie albo wybierz telefon u góry okna Xcode i naciśnij ▶.
- **„Brak konta Apple w Xcode”**: Xcode → Settings… → Accounts → + → Apple ID.
- **Telefon się nie połączył** (kod wygasł albo telefon był zablokowany): na serwerze wpisz `mellis` → **Połącz
  telefon właściciela** i zeskanuj kod QR w aplikacji.
- Pełny dziennik budowania: `~/.mellis/xcodebuild.log`; instalacji i łączenia: `~/.mellis/install-<telefon>.log`.

## Dla deweloperów

- Testy skryptu bez Xcode, telefonów i serwera (devicectl i curl podstawione): `bash scripts/install-app.test.sh`.
- Skrypt generuje tylko wersję społecznościową (tryb bez kont). Produkcja z Cognito korzysta z własnego
  `apps/ios/Config.local.xcconfig` i nie używa tego skryptu.
- Identyfikator aplikacji to `pl.mellis.<TeamID>`; serwer potrzebuje go jako `APNS_BUNDLE_ID`, czyli `pl.mellis.`
  i Team ID podany przy instalacji serwera. Skrypt wypisuje go w podsumowaniu.
