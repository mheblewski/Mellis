# Aktualizacje

Każda wersja Mellis ma numer, np. `1.2.0`. Serwer i aplikacja z tym samym numerem zawsze do siebie pasują.

!!! tip "Kolejność"
    Najpierw zaktualizuj **serwer**, potem **aplikację**. Nowszy serwer obsługuje starsze aplikacje, a jeśli kiedyś
    przestanie, aplikacja pokaże baner z prośbą o aktualizację.

## Serwer

Połącz się z serwerem komendą `ssh` z notatki „Mellis” i wpisz:

```bash
mellis update
```

albo otwórz menu `mellis` i wybierz **Aktualizuj**. Instalator:

1. zrobi kopię bazy danych,
2. pobierze nową wersję,
3. zaktualizuje bazę i uruchomi serwer Mellis,
4. sprawdzi, czy wszystko odpowiada.

Jeśli coś pójdzie nie tak, **sam wróci do poprzedniej wersji** i przywróci bazę z kopii sprzed aktualizacji.

## Aplikacja

W Terminalu **na Macu** uruchom tę samą komendę co przy instalacji. Skrypt sam wybierze wersję zgodną z Twoim
serwerem:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/mheblewski/Mellis/v1.0.7/scripts/install-app.sh)"
```

Skrypt pamięta Twoje odpowiedzi, więc wystarczy kilka razy nacisnąć ++enter++. Żeby zaktualizować wszystkie
telefony w rodzinie naraz, wybierz **Wszystkie z listy**. Dane i ustawienia w aplikacji zostają.

## Raz w roku

Aplikacja zbudowana kontem Apple Developer działa **rok** od zbudowania. Potem iOS przestaje ją uruchamiać, tak
samo jak Trio i Loopa.

- Przebuduj ją tą samą komendą co przy aktualizacji, wybierając **Wszystkie z listy**.
- Ustaw sobie przypomnienie w kalendarzu na 11 miesięcy od instalacji.

## Konkretna wersja

Jeśli chcesz zostać przy starszej wersji albo wrócić do niej, zrób oba kroki, w tej kolejności:

<div class="steps" markdown>

1.  **Serwer**

    Na serwerze: `mellis` → **Zmień ustawienia → Wersja** i wybierz numer. Powrót do starszej wersji przywraca bazę
    z kopii sprzed aktualizacji, więc dane zapisane od tamtej pory przepadną.

2.  **Aplikacja** · na Macu

    Zbuduj aplikację w tej samej wersji:

    ```bash
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/mheblewski/Mellis/v1.0.7/scripts/install-app.sh)" -- --ref v1.1.0
    ```

</div>
