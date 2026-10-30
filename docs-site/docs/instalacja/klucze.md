# Klucze krok po kroku

Trzy rzeczy, o które pyta instalator serwera (plus jedna opcjonalna). Każda zajmuje kilka minut.

## Token Nightscouta

Mellis tylko **czyta** z Nightscouta, więc potrzebuje tokenu z prawem odczytu. Token z prawem zapisu instalator
odrzuci.

<div class="steps" markdown>

1.  Otwórz Nightscouta w przeglądarce i wejdź w **Admin Tools** (menu ☰ → Admin Tools). Nightscout poprosi o API
    Secret: to hasło ustawione przy zakładaniu Nightscouta (znajdziesz je w panelu swojego hostingu). Mellis go nie
    potrzebuje, służy tylko do wejścia w Admin Tools.

2.  W sekcji **Subjects** kliknij **Add new Subject**. Nazwa: `mellis`, rola: **readable**. Zapisz.

3.  Skopiuj **token** z kolumny Access Token, np. `mellis-1a2b3c4d5e6f7a8b`.

</div>

!!! tip "Możesz wkleić cały link"
    Jeśli skopiujesz link w postaci `https://moj-nightscout.example.pl?token=mellis-1a2b…`, instalator sam rozdzieli
    go na adres i token.

## Klucz AI

Wybierz jednego dostawcę. **Nie wiesz, którego? Wybierz OpenAI**: jeden klucz wystarczy do wszystkiego, łącznie
z rozpoznawaniem mowy i pełnym wyszukiwaniem w bazie wiedzy.

=== "OpenAI (polecany)"

    1. Załóż konto na [platform.openai.com](https://platform.openai.com).
    2. **Billing**: doładuj konto, np. 10 USD.
    3. **API keys → Create new secret key**, nazwa `mellis`. Skopiuj klucz: zaczyna się od `sk-` i zobaczysz go
       tylko raz.

    Ten jeden klucz wystarczy do wszystkiego: odpowiedzi, wyszukiwania w bazie wiedzy i rozpoznawania mowy.

=== "Anthropic"

    1. Załóż konto na [console.anthropic.com](https://console.anthropic.com).
    2. **Billing**: doładuj konto, np. 10 USD. Bez środków klucz nie działa.
    3. **API Keys → Create Key**, nazwa `mellis`. Skopiuj klucz: zaczyna się od `sk-ant-` i zobaczysz go tylko raz.
    4. Opcjonalnie w **Limits** ustaw miesięczny limit wydatków po stronie Anthropic. Mellis ma też własny limit.

    !!! info "Opcjonalny klucz OpenAI"
        Przy Claude instalator zapyta też o klucz OpenAI. Nie jest wymagany, ale poprawia wyszukiwanie w bazie wiedzy
        i rozpoznawanie mowy, a kosztuje grosze miesięcznie. Klucz zdobywasz tak jak w zakładce OpenAI. Możesz go też dodać później.

## Klucz APNs

Klucz APNs pozwala serwerowi wysyłać powiadomienia na Twoje telefony.

!!! success "Masz już klucz z Trio, Loop Follow albo zdalnych poleceń w Nightscoucie?"
    **Użyj tego samego pliku `.p8`**, jeśli Trio albo Loopa budujesz tym samym kontem Apple Developer co aplikację Mellis.
    Klucz APNs działa dla wszystkich aplikacji na koncie. Potrzebujesz jeszcze jego Key ID i Team ID.

!!! warning "Masz klucz, ale nie masz pliku?"
    Plik `.p8` da się pobrać tylko raz. Apple pozwala mieć **najwyżej dwa** takie klucze na konto. Jeśli masz już
    dwa, a pliku żadnego z nich, musisz jeden unieważnić (**Revoke**) i utworzyć nowy. Unieważnienie wyłączy
    zdalne polecenia w Trio, Loop Follow albo Nightscoucie, dopóki nie wgrasz tam nowego klucza.

Jeśli nie masz klucza:

<div class="steps" markdown>

1.  Wejdź na [developer.apple.com/account](https://developer.apple.com/account) → **Certificates, IDs & Profiles
    → Keys**.

2.  Kliknij **+**, nazwa: `Mellis`, zaznacz **Apple Push Notifications service (APNs)**.

    Jeśli Apple pokaże **Configure**, wybierz środowisko **Sandbox & Production** i zakres **Team Scoped (All
    Topics)**. Mellis zbudowany na Macu korzysta ze środowiska Sandbox, a klucz ograniczony do jednej aplikacji nie
    zadziała.

    Potem **Continue → Register**.

3.  **Download**: pobierz plik `AuthKey_XXXXXXXXXX.p8`. **Można go pobrać tylko raz.** Otwórz go w TextEdit
    (prawy przycisk → **Otwórz za pomocą → TextEdit**), skopiuj całość i wklej do notatki „Mellis”. Sam plik
    zachowaj w bezpiecznym miejscu: przyda się do zdalnego bolusa.

4.  **Key ID** to 10 znaków z nazwy pliku (te `XXXXXXXXXX`).

5.  **Team ID** znajdziesz w prawym górnym rogu strony konta albo w **Membership details**.

</div>
