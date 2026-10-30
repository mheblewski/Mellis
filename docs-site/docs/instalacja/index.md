# Instalacja

Całość zajmuje zwykle **około godziny**, z czego sporo to czekanie, aż coś się pobierze albo zbuduje. Nie
musisz znać się na serwerach: serwer i aplikację instalujesz jedną komendą każde, a skrypty pytają o resztę.

Komendy wpisujesz w **Terminalu** na Macu. Przy każdej komendzie piszemy, gdzie ją wkleić: **na Macu** czy **na
serwerze**.

<div class="steps" markdown>

1.  **[Zbierz, czego potrzebujesz](przygotowanie.md)** <span class="time">20-30 min</span>

    Serwer, klucze i token, z instrukcją krok po kroku dla każdego. Jeśli masz Trio, część już masz.

2.  **[Zainstaluj serwer](serwer.md)** <span class="time">15 min</span>

    Jedna komenda na serwerze. Instalator zapyta o Nightscout, klucz AI i klucz powiadomień.

3.  **[Zainstaluj aplikację](aplikacja.md)** <span class="time">15 min</span>

    Jedna komenda na Macu. Aplikacja zbuduje się i zainstaluje na Twoim iPhonie, kablem albo przez Wi-Fi.

4.  **[Połącz telefon z serwerem](parowanie.md)** <span class="time">1 min</span>

    Twój telefon łączy się sam. Kolejnych opiekunów zapraszasz kodem QR.

5.  **[Włącz zdalny bolus](zdalny-bolus.md)** <span class="time">5 min, opcjonalnie</span>

    Jeśli chcesz wysyłać bolus do Trio albo Loopa z aplikacji Mellis.

</div>

!!! tip "Zrób to na spokojnie"
    Nie instaluj w trakcie posiłku ani wieczorem, gdy trzeba pilnować glukozy. Mellis nie zmienia niczego w Trio
    ani w Loopie, dopóki sam nie wyślesz polecenia, ale lepiej mieć głowę wolną.

## Jak to działa

```mermaid
flowchart LR
    pump["Pompa + sensor"] --> loop["Trio / Loop<br/>(telefon podopiecznego)"]
    loop --> ns["Nightscout"]
    ns --> server["Serwer Mellis<br/>(Twój)"]
    server <--> ai["Claude / OpenAI<br/>(Twój klucz)"]
    server --> app["Aplikacja Mellis<br/>(telefony opiekunów)"]
    app -. "bolus z Face ID" .-> loop
```

- **Serwer Mellis** co kilkanaście sekund pobiera dane z Nightscouta, liczy prognozy, wysyła powiadomienia
  i rozmawia z AI. Działa całą dobę, dlatego jest na serwerze, a nie na telefonie.
- **Aplikacja** pokazuje dane i wysyła bolus **bezpośrednio do Trio albo Loopa**, przez powiadomienia Apple, tak
  samo jak Loop Follow. Serwer nie może sam podać bolusa.
