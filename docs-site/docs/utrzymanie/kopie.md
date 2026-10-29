# Kopie zapasowe

Serwer co noc robi kopię bazy danych: rozmów, posiłków, ustawień i historii. Dane glukozy i tak są w Nightscoucie,
ale opisów posiłków i rozmów nie ma nigdzie indziej.

## Co jest w kopii

- baza danych: podopieczni, opiekunowie, urządzenia, posiłki, rozmowy, przypomnienia,
- zdjęcia posiłków,
- ustawienia serwera, ale **bez kluczy**: kopię możesz przechowywać poza serwerem bez ryzyka wycieku kluczy.

Serwer trzyma kopie z **ostatnich 14 dni**.

## Kopia poza serwerem

Kopia na tym samym serwerze nie pomoże, jeśli serwer zniknie. Raz na jakiś czas pobierz ją na Maca:

1. **Na serwerze** (połącz się komendą `ssh` z notatki): `mellis` → **Kopia zapasowa / przywróć → Pobierz
   najnowszą**. Zobaczysz komendę do skopiowania.
2. Otwórz **nowe okno Terminala** (++cmd+n++): to okno działa na Macu. Wklej tam komendę. Terminal zapyta o hasło
   do serwera. Kopia trafi do katalogu `~/Mellis-kopie`.

## Przywracanie

Na serwerze: `mellis` → **Kopia zapasowa / przywróć → Przywróć** i wybierz datę. Mellis zatrzyma się na kilka
minut, przywróci bazę i uruchomi się ponownie. W tym czasie nie przyjdą powiadomienia.

!!! tip "Przeprowadzka na nowy serwer"
    1. Pobierz najnowszą kopię na Maca (wyżej).
    2. Skopiuj plik kopii na nowy serwer. Instalator pokaże komendę do wklejenia na Macu, np.
       `scp -P PORT ~/Mellis-kopie/mellis-….tar.gz root@ADRES-SERWERA:/root/`.
    3. Zainstaluj Mellisa na nowym serwerze. W pierwszym pytaniu instalatora wybierz **Przywróć z kopii** i wskaż
       plik. Klucze (Nightscout, AI, APNs) instalator zapyta ponownie: kopia ich nie zawiera. Kod odzyskiwania
       z notatki działa dalej.
    4. Na nowym serwerze: `mellis` → **Połącz telefon właściciela** i zeskanuj kod QR swoim telefonem.
    5. Pozostali opiekunowie dostają od Ciebie nowe zaproszenia.
