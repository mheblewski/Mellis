# Słowniczek

APNs
:   Apple Push Notification service, czyli usługa Apple, przez którą serwer wysyła powiadomienia na iPhone'a,
    a Mellis wysyła polecenia do Trio i Loopa. Klucz APNs to plik `.p8` z konta Apple Developer.

COB
:   Carbs on Board, czyli węglowodany, które jeszcze się wchłaniają.

DIY
:   Do It Yourself, czyli „zrób to sam”: oprogramowanie, które użytkownik buduje i uruchamia sam, bez certyfikatu
    medycznego.

IOB
:   Insulin on Board, czyli insulina, która jeszcze działa.

Key ID, Team ID
:   Identyfikatory z konta Apple Developer. Key ID (10 znaków) należy do klucza APNs. Team ID (10 znaków)
    należy do Twojego konta.

Kod konfiguracji
:   Kod z końca instalacji serwera. Łączy z serwerem pierwszy telefon, właściciela, i potem przestaje działać.

Kod odzyskiwania
:   Kod pokazany raz, gdy skrypt na Macu łączy pierwszy telefon właściciela. Pozwala odzyskać dostęp, gdy zgubisz
    wszystkie telefony właściciela. Nowy zrobisz na serwerze: `mellis` → **Odzyskaj dostęp właściciela**.

Live Activity
:   Kafelek na ekranie blokady i w Dynamic Island z aktualną glukozą.

Nightscout
:   Serwer, do którego Trio, Loop albo AndroidAPS wysyła dane. Mellis je stamtąd czyta.

Opiekun
:   Osoba z aplikacją Mellis połączoną z serwerem.

Podopieczny
:   Osoba z cukrzycą, której dane pochodzą z Nightscouta.

Pętla
:   Trio, Loop albo AndroidAPS: aplikacja, która sama dopasowuje dawki insuliny na podstawie sensora.

RAG
:   Wyszukiwanie w bazie wiedzy (wytyczne ISPAD, dokumentacja Trio i inne), z której AI korzysta przy odpowiedziach
    „dlaczego”.

Secure Enclave
:   Osobny chip w iPhonie, który przechowuje klucze tak, że nie da się ich skopiować.

Serwer
:   Komputer w internecie, który działa całą dobę. Na nim działa część Mellisa pobierająca dane i wysyłająca
    powiadomienia.

Shared Secret
:   Hasło zdalnych poleceń z Trio (koło zębate → Funkcje → Kontrola zdalna). Mellis potrzebuje go, żeby wysłać
    polecenie do Trio.

SSH
:   Sposób łączenia się z serwerem z Terminala na Macu: komenda `ssh -p PORT root@ADRES`.

Terminal
:   Aplikacja na Macu do wpisywania komend (Spotlight: ++cmd+space++, „Terminal”).

TIR
:   Time in Range, czyli procent czasu z glukozą w zakresie docelowym.

Token Nightscouta
:   Klucz dostępu do Nightscouta. Mellis potrzebuje tokenu tylko do odczytu (rola readable).

Tryb dewelopera
:   Ustawienie iPhone'a, które pozwala instalować aplikacje zbudowane na Macu.

WBT
:   Wymienniki białkowo-tłuszczowe. Tłuszcz i białko podnoszą glukozę później niż węglowodany, dlatego przy
    tłustym posiłku bolus rozkłada się na części.

Właściciel
:   Opiekun z uprawnieniem „Zarządza udostępnianiem”: zaprasza innych i włącza zdalny bolus.

Zdalny bolus
:   Bolus wysłany z telefonu opiekuna do pętli na telefonie podopiecznego.
