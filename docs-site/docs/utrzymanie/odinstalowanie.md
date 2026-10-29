# Odinstalowanie

## Serwer

Na serwerze: `mellis` → **Odinstaluj**. Wybierasz jedną z dwóch opcji:

=== "Zachowaj dane"

    Usuwa Mellisa, a zostawia kopię bazy i ustawienia w `/opt/mellis-kopia`. Możesz wrócić, instalując Mellisa
    ponownie i wybierając **Przywróć z kopii**.

=== "Usuń wszystko"

    Najpierw proponuje pobranie ostatniej kopii na Maca. Potem usuwa Mellisa, bazę danych, zdjęcia, ustawienia,
    klucze i zadania nocnych kopii.

    **Tego nie da się cofnąć.**

W obu przypadkach Mellis nie rusza niczego poza swoim katalogiem. Nightscout i inne usługi na tym samym serwerze
działają dalej.

## Aplikacja

1. Jeśli ustawiałeś zdalny bolus: **Mellis → Ustawienia → Zdalne sterowanie Trio** (albo **Loop**) → **Usuń
   ustawienia z tego telefonu**. Klucze w pęku kluczy iOS mogą przetrwać usunięcie aplikacji, więc usuń je tutaj.
2. Odłącz telefon: **Mellis → Ustawienia → Udostępnianie → Ten telefon → Odłącz**.
3. Przytrzymaj ikonę Mellisa na ekranie początkowym → **Usuń aplikację**.

Jeśli pominiesz krok 2, serwer i tak sam przestanie wysyłać powiadomienia na telefon, który ich nie odbiera.

## Na koncie Apple Developer

Nic nie musisz robić. Jeśli chcesz posprzątać, w **Certificates, IDs & Profiles → Identifiers** usuń
`pl.mellis.<TwójTeamID>`. Klucza APNs nie usuwaj, jeśli używa go Trio albo Loop.

## U dostawcy AI

Usuń klucz `mellis` w konsoli Anthropic albo OpenAI.
