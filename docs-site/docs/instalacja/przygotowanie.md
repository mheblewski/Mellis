# 1. Zbierz, czego potrzebujesz

<span class="time">20-30 minut, zależnie od tego, co już masz</span>

Przygotuj poniższe rzeczy, zanim zaczniesz. Instalator o nie zapyta, a łatwiej wkleić je z jednego miejsca.

!!! tip "Notatka „Mellis”"
    Utwórz w menedżerze haseł (Hasła w iOS, 1Password, Bitwarden) notatkę **„Mellis”** i wklejaj do niej wszystko
    z tej strony. Klucze to hasła: nie wysyłaj ich mailem ani komunikatorem. Plik `.p8` też wklejasz jako tekst
    (jak, opisujemy w [Kluczach](klucze.md#klucz-apns)).

## Lista

<div class="steps" markdown>

1.  **Serwer**

    Mały serwer z planem **co najmniej 1 GB RAM**, także jeśli działa na nim Twój Nightscout. Jak
    wybrać: [Wybierz serwer](serwer.md#wybierz-serwer). Kup go teraz i wróć tutaj.

    Po zakupie dostaniesz e-mail z **danymi logowania**: adresem serwera, portem i hasłem. Wklej je do notatki.
    Na Macu połączysz się nimi z serwerem (to się nazywa SSH).

    Jeśli to serwer z własnym adresem IP (nie Mikrus), przygotuj też **domenę albo subdomenę**, która na niego
    wskazuje. Zmiana w domenie potrzebuje do godziny, więc zrób to teraz.

2.  **Adres Nightscouta i token tylko do odczytu**

    [Jak zrobić token](klucze.md#token-nightscouta).

3.  **Klucz AI**: OpenAI (polecany) albo Claude

    [Jak zdobyć klucz](klucze.md#klucz-ai).

4.  **Klucz powiadomień Apple (APNs)**: plik `.p8`, jego **Key ID** i Twój **Team ID**

    Jeśli używasz zdalnych poleceń w Trio albo Loop Follow, możesz już mieć klucz. Ale plik `.p8` da się pobrać
    tylko raz: jeśli go nie masz, trzeba zrobić nowy. [Jak to zrobić](klucze.md#klucz-apns).

5.  **Mac z Xcode**, zalogowany kontem Apple Developer

    Tym samym kontem, z którego jest klucz `.p8`. [Szczegóły](aplikacja.md#zanim-zaczniesz).

6.  **iPhone każdego opiekuna** z iOS 17 albo nowszym

    Aplikację Mellis instalujesz na telefonach **opiekunów**, a nie na telefonie, na którym działa Trio albo Loop (chyba że
    podopieczny też ma używać aplikacji Mellis). Każdy telefon trzeba raz podłączyć kablem do Twojego Maca, więc umów się
    z pozostałymi opiekunami.

</div>

??? info "Ile to kosztuje"

    | | Koszt |
    |---|---|
    | Apple Developer | 99 USD rocznie (to samo konto co do Trio i Loopa) |
    | Serwer | od kilkudziesięciu złotych rocznie (np. Mikrus), sprawdź aktualny cennik |
    | AI | zwykle kilka do kilkunastu USD miesięcznie przy codziennym używaniu; limit ustawiasz sam |
    | Mellis | za darmo |

    Więcej o kosztach AI: [Koszty AI](../codzienne/koszty.md).

## Gotowe?

- [ ] Serwer jest kupiony, a dane logowania z maila są w notatce.
- [ ] Adres i token Nightscouta są w notatce.
- [ ] Klucz AI jest w notatce, a na koncie dostawcy są środki.
- [ ] Zawartość pliku `.p8`, Key ID i Team ID są w notatce.
- [ ] Xcode na Macu jest zalogowany kontem Apple Developer.

[Dalej: serwer :material-arrow-right:](serwer.md){ .md-button .md-button--primary }
