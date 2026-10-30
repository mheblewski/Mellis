# 3. Aplikacja na iPhonie

<span class="time">ok. 15 minut, z czego kilka do kilkunastu to budowanie</span>

Aplikację Mellis budujesz sam, na swoim Macu i swoim kontem Apple Developer, tak jak Trio albo Loopa. Różnica: nie
musisz nic klikać w Xcode. Skrypt zbuduje aplikację i sam zainstaluje ją na telefonie.

!!! info "Trio i Loop są bezpieczne"
    Mellis ma własny identyfikator aplikacji (`pl.mellis.<TwójTeamID>`). Budowanie go nie zmienia niczego
    w certyfikatach ani profilach Trio i Loopa na tym samym koncie.

## Zanim zaczniesz

- [ ] **Xcode** z App Store, uruchomiony przynajmniej raz. Zaakceptuj licencję i doinstaluj platformę iOS, jeśli
      Xcode o to poprosi.
- [ ] **Konto Apple Developer zalogowane w Xcode**: **Xcode → Settings… → Accounts → + → Apple ID**. To samo konto,
      z którego jest klucz `.p8` podany na serwerze.
- [ ] **Telefon pod ręką.** Najpierw instalujesz Mellis na **swoim** telefonie. Telefony pozostałych opiekunów
      dodasz później, po [zaproszeniu](parowanie.md).
- [ ] **Adres serwera** i **kod konfiguracji** z notatki „Mellis”.
- [ ] Mac podłączony do zasilania. Nie usypiaj go w trakcie budowania.

## Uruchom skrypt

Otwórz **nowe okno Terminala na Macu** (++cmd+n++ w Terminalu). Nie używaj okna, w którym byłeś połączony
z serwerem: jeśli początek linii pokazuje nazwę serwera, wpisz najpierw `exit`.

Wklej **na Macu** komendę, którą na końcu pokazał instalator serwera (jest w notatce „Mellis”). Ma już adres
serwera i kod konfiguracji:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/mheblewski/Mellis/v1.0.6/scripts/install-app.sh)" -- --server https://mellis.moja-domena.pl --code 7KQ2M-9XH4T-3BWRZ-8QJ5N
```

Bez `--server` i `--code` skrypt zapyta o nie sam.

Na początku skrypt pokaże jedno zdanie: „Mellis to projekt DIY, nie wyrób medyczny. Używasz go na własną
odpowiedzialność; decyzje o leczeniu podejmujesz Ty.” Wpisz `tak` i naciśnij ++enter++. Każda inna odpowiedź
kończy skrypt, zanim cokolwiek zbuduje.

<div class="steps" markdown>

1.  **Sprawdzenie Maca**

    Skrypt sprawdzi Xcode i potrzebne narzędzia. Jeśli czegoś brakuje, powie dokładnie, co zrobić.

2.  **Pobranie kodu**

    Kod trafia do katalogu `~/Mellis`. Przy kolejnych uruchomieniach skrypt tylko go aktualizuje.

3.  **Twój Team ID**

    Skrypt odczyta go z Xcode i poprosi o potwierdzenie. Jeśli masz kilka kont, pokaże listę: wybierz to, z którego
    jest klucz `.p8`.

4.  **Serwer**

    Adres serwera i kod konfiguracji przychodzą z komendy (albo wklejasz je, gdy skrypt zapyta). Kod konfiguracji to
    ten sam kod, który pokazał instalator serwera (`mellis setup-code` na serwerze). Dzięki niemu Twój telefon
    połączy się z serwerem sam, bez skanowania. Skrypt sprawdzi, czy serwer odpowiada, i wybierze wersję aplikacji
    zgodną z serwerem.

5.  **Wybór telefonu**

    ```text
    1) iPhone Ani · iOS 26.1 · Wi-Fi · połączony
    2) iPhone Tomka · iOS 26.0 · kabel · połączony
    3) Wszystkie z listy
    0) Nie instaluj, tylko zbuduj
    r) Odśwież listę
    Na który telefon zainstalować? [1]:
    ```

    - **Za pierwszym razem wybierz tylko swój telefon.** Kod konfiguracji łączy z serwerem jeden telefon:
      właściciela.
    - Telefon, który był kiedyś podłączony do Maca, widać **także przez Wi-Fi**, bez kabla.
    - **Wszystkie z listy** przyda się przy [aktualizacjach](../utrzymanie/aktualizacje.md): aplikacja zbuduje się
      raz i zainstaluje po kolei na każdym telefonie. Jeśli wybierzesz ją za pierwszym razem, z serwerem połączy się
      tylko pierwszy telefon z listy; pozostałe dołączą [zaproszeniem](parowanie.md#kolejny-opiekun).
    - Ostatni wybór jest domyślny przy następnym uruchomieniu: wystarczy ++enter++.

6.  **Budowanie i instalacja**

    Za pierwszym razem trwa to kilka do kilkunastu minut.

7.  **Połączenie z serwerem**

    Skrypt zapyta o Twoje imię (widzą je inni opiekunowie) i pokaże **kod odzyskiwania**. Zapisz go od razu
    w notatce „Mellis”: jest pokazywany tylko raz i przyda się, jeśli zgubisz wszystkie swoje telefony. Jeśli
    uruchomisz skrypt ponownie przed połączeniem telefonu, dostaniesz nowy kod, a poprzedni przestanie działać.

    Potem Mellis otworzy się sam na Twoim telefonie. Za pierwszym razem pokaże to samo zdanie co skrypt: stuknij
    **Rozumiem i akceptuję** (telefon zapamięta to i nie zapyta ponownie). Potem pokaże adres Twojego serwera.
    Sprawdź go i stuknij **Połącz**.
    Telefon musi być odblokowany: jeśli był zablokowany, skrypt poprosi, żebyś go odblokował i nacisnął ++enter++.
    Na końcu zobaczysz wynik dla każdego telefonu.

</div>

!!! success "Gotowe"
    Po stuknięciu **Połącz** zobaczysz dashboard podopiecznego. Gdy iOS zapyta o **powiadomienia**, wybierz
    **Zezwól**, inaczej nie dostaniesz ostrzeżeń.

    Zamiast dashboardu widzisz ekran łączenia z serwerem? Zobacz [Twój telefon](parowanie.md#twoj-telefon).

    Jeśli Mellis Ci się przyda, możesz [wesprzeć jego rozwój](https://suppi.pl/mellis). To dobrowolne.

Za pierwszym razem iPhone może pokazać komunikat **„Niezaufany deweloper”**. Wejdź w **Ustawienia iOS → Ogólne →
VPN i urządzenia zarządzane**, wybierz swoje konto i stuknij **Zaufaj**.

## Pierwszy raz z nowym telefonem

Każdy telefon trzeba **raz** podłączyć kablem do Twojego Maca. Dotyczy to też telefonów innych opiekunów: muszą być
przy Twoim Macu przy pierwszej instalacji.

1. Podłącz iPhone'a do Maca kablem, odblokuj go i stuknij **Zaufaj**.
2. Otwórz Xcode i poczekaj, aż skończy przygotowywać telefon (za pierwszym razem może to potrwać kilka minut).
3. Włącz tryb dewelopera: **Ustawienia iOS → Prywatność i ochrona → Tryb dewelopera**. Telefon uruchomi się ponownie.
4. W skrypcie wybierz **r**, żeby odświeżyć listę.

Od tej pory ten telefon jest widoczny także przez Wi-Fi. Jeśli ma dopisek **„teraz niedostępny”**, odblokuj go
i sprawdź, czy jest w tej samej sieci Wi-Fi co Mac.

Jeśli budowałeś na tym telefonie Trio albo Loopa, kroki 1-3 są już zrobione.

## Przydatne opcje

Opcje dopisujesz na końcu komendy po `--`, na przykład:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/mheblewski/Mellis/v1.0.6/scripts/install-app.sh)" -- --ref v1.0.0
```

| Opcja | Co robi |
|---|---|
| `--server https://…` | adres serwera (skrypt go zapamięta) |
| `--code KOD` | kod konfiguracji z instalacji serwera |
| `--ref v1.0.0` | konkretna wersja: tag wydania, gałąź albo commit (zamiast zgodnej z serwerem) |
| `--dir ~/Kod/Mellis` | inny katalog na kod |
| `--no-update` | bez pobierania nowego kodu |
| `--no-install` | tylko zbuduj, nie instaluj |
| `--dry-run` | sprawdź wszystko i pokaż telefony, bez budowania |

[Dalej: połącz kolejne telefony :material-arrow-right:](parowanie.md){ .md-button .md-button--primary }
