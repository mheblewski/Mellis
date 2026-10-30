# Koszty AI

AI w aplikacji Mellis działa na **Twoim kluczu**, więc płacisz dostawcy (Anthropic albo OpenAI) za to, czego używasz.
Mellis nie pobiera żadnych opłat.

## Ile to kosztuje

Koszt zależy od tego, jak często pytasz i jak długie są odpowiedzi.

| Co | Orientacyjnie |
|---|---|
| Krótkie pytanie w czacie | kilka centów |
| Pytanie o dawkę z analizą danych | kilka do kilkunastu centów |
| Szacunek posiłku ze zdjęcia | kilka centów |
| Typowy miesiąc, codzienne używanie | kilka do kilkunastu USD |

Dashboard, wykres, ostrzeżenia i karta Bolus **nie kosztują nic**. AI uruchamia się, gdy o coś pytasz, gdy opisujesz
posiłek i gdy Mellis liczy propozycję dawki na tłuszcz i białko.

## Limit

Podczas instalacji ustawiasz **miesięczny limit**. Gdy się wyczerpie:

- AI przestaje odpowiadać do końca miesiąca, a w aplikacji zobaczysz informację o limicie,
- wszystko inne działa dalej: dane, wykres, powiadomienia, bolus.

Limit zmienisz na serwerze: połącz się komendą `ssh` z notatki, wpisz `mellis` → **Zmień ustawienia → Limit AI**.
Ile już wydałeś, zobaczysz najdokładniej w konsoli dostawcy (OpenAI albo Anthropic).

!!! tip "Drugi bezpiecznik"
    Ustaw też limit wydatków na koncie u dostawcy (Anthropic: **Limits**, OpenAI: **Limits**). Wtedy nawet błąd
    w aplikacji Mellis nie przekroczy kwoty, którą akceptujesz.
