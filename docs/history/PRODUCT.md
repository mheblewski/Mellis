# PRODUCT.md

> **Historyczne notatki projektowe (GlucoMind), nie opisują obecnego modelu bezpieczeństwa — aktualny: [docs/device-auth-api.md](../device-auth-api.md).**

# Specyfikacja produktu

## 1. Wizja produktu

Produkt jest systemem AI wspierającym osobę odpowiedzialną za bieżące zarządzanie cukrzycą pacjenta.

System ma działać jak **drugi mózg opiekuna** - pomagać analizować dane, łączyć informacje z różnych źródeł, pamiętać istotny kontekst, zauważać wzorce, wykonywać obliczenia i przedstawiać konkretne propozycje wtedy, gdy użytkownik musi podjąć decyzję.

Celem nie jest stworzenie kolejnego chatbota odpowiadającego ogólnymi informacjami medycznymi.

Celem jest system, który potrafi spojrzeć na:

* aktualny stan,
* terapię,
* dane historyczne,
* wcześniejsze podobne zdarzenia,
* kontekst pacjenta,
* niepełne informacje,
* wzorce indywidualne,
* wiedzę medyczną i naukową,

a następnie przełożyć je na **konkretną, uzasadnioną propozycję działania**.

Pierwsza wersja produktu koncentruje się na cukrzycy typu 1 i scenariuszu opieki nad dzieckiem. Architektura produktu nie powinna jednak zakładać na stałe wieku pacjenta, relacji opiekuna ani konkretnego sposobu prowadzenia terapii.

---

## 2. Problem

Codzienne zarządzanie cukrzycą wymaga podejmowania wielu decyzji na podstawie informacji, które są:

* rozproszone,
* niekompletne,
* zmienne w czasie,
* częściowo automatycznie rejestrowane,
* częściowo zapamiętywane przez opiekuna,
* czasami sprzeczne,
* często obarczone niepewnością.

System może mieć bardzo dużo danych dotyczących glikemii i insuliny, ale nadal nie wiedzieć, dlaczego konkretny przebieg wystąpił.

Przykłady brakującego kontekstu:

* aktywność fizyczna,
* dodatkowa przekąska,
* niedokończony posiłek,
* większa ilość tłuszczu lub białka w posiłku,
* choroba,
* gorszy sen,
* stres,
* nietypowy dzień,
* różnica między ilością jedzenia zaplanowaną a faktycznie zjedzoną.

Człowiek również nie zawsze zna odpowiedź.

System nie może traktować braku odpowiedzi jako dowodu, że dane zdarzenie nie wystąpiło.

---

## 3. Główny problem produktu

Najważniejszym zadaniem systemu jest **wydobywanie wartości z niepełnego i niepewnego kontekstu oraz przekładanie jej na użyteczne decyzje wspierające użytkownika**.

System powinien:

1. wiedzieć, co faktycznie zostało zaobserwowane,
2. wiedzieć, co zostało zgłoszone przez użytkownika,
3. wiedzieć, czego nie wiemy,
4. rozpoznawać możliwe wyjaśnienia,
5. porównywać sytuację z wcześniejszymi podobnymi zdarzeniami,
6. korzystać z wiedzy medycznej i naukowej,
7. jasno oddzielać fakty od hipotez,
8. wykonywać deterministyczne obliczenia,
9. przedstawiać konkretne wyniki i propozycje, gdy dane na to pozwalają,
10. wskazywać, czego brakuje i jak bardzo brakujące dane wpływają na wynik,
11. zadawać pytania tylko wtedy, gdy odpowiedź może istotnie zmienić analizę.

**Brak pełnej informacji nie powinien automatycznie prowadzić do braku konkretnej odpowiedzi.**

---

## 4. Podstawowe zasady produktu

### 4.1. AI jest drugim mózgiem, a nie autonomicznym decydentem

AI ma aktywnie wspierać proces podejmowania decyzji.

Może:

* analizować,
* obliczać,
* porównywać,
* wykrywać wzorce,
* formułować hipotezy,
* wskazywać ryzyka,
* proponować ilość węglowodanów,
* proponować dawkę insuliny,
* proponować zakres lub warianty dawki,
* wskazywać możliwe działania,
* wyjaśniać swoje rozumowanie,
* wskazywać poziom niepewności.

AI nie powinno:

* samodzielnie wykonywać decyzji terapeutycznych,
* samodzielnie podawać insuliny,
* samodzielnie zmieniać ustawień terapii,
* przedstawiać hipotezy jako potwierdzonego faktu,
* ukrywać istotnych ograniczeń danych.

**Ostateczna decyzja i wykonanie działania należą do człowieka.**

Nie oznacza to jednak, że AI powinno unikać konkretnej odpowiedzi.

Jeżeli system posiada wystarczające dane do wykonania sensownej analizy, powinien przedstawić konkretny wynik.

Przykład:

> Obliczenie bazowe daje 3,75 U. Uwzględniając aktualny trend, IOB oraz wcześniejsze podobne posiłki, system proponuje 3,5-4,0 U. Największą niepewnością jest faktyczna ilość zjedzonych węglowodanów.

To jest właściwy sposób działania systemu.

---

### 4.2. Konkretność jest ważniejsza niż ogólne zastrzeżenia

System nie powinien zasłaniać się ogólnym stwierdzeniem:

> „Skonsultuj się z lekarzem.”

jeżeli użytkownik oczekuje analizy sytuacji, a system posiada dane umożliwiające jej wykonanie.

Ograniczenia i niepewność powinny być komunikowane **w kontekście konkretnego wyniku**.

Zamiast:

> „Nie mogę doradzić w kwestii dawki insuliny.”

preferowane jest:

> „Na podstawie dostępnych danych obliczenie daje X. Głównym źródłem niepewności jest Y. Historycznie w podobnych przypadkach występował Z. Dlatego system proponuje zakres X-Y do oceny przez użytkownika.”

System powinien unikać zarówno:

* fałszywej pewności,
* jak i nadmiernej asekuracji.

---

### 4.3. UNKNOWN nie oznacza NO

System musi posiadać co najmniej trzy stany dla informacji, dla których odpowiedź może być nieznana:

* `YES`
* `NO`
* `UNKNOWN`

Przykład:

> Czy pacjent zjadł dodatkową przekąskę?

Odpowiedź:

> Nie wiem.

nie może zostać przekształcona w:

> Nie, nie zjadł.

`UNKNOWN` jest prawidłowym stanem wiedzy.

System powinien umieć kontynuować analizę mimo `UNKNOWN`.

---

### 4.4. Niepewność jest informacją, a nie blokadą

Niepewność nie powinna powodować automatycznego zakończenia analizy.

Jeżeli brakuje informacji, system powinien:

1. określić, czego nie wiemy,
2. ocenić wpływ tej niewiadomej na wynik,
3. rozważyć kilka scenariuszy,
4. wykorzystać historię pacjenta,
5. wykorzystać dostępne wzorce,
6. przedstawić najlepszą dostępną propozycję,
7. wskazać, jak zmieniłby się wynik przy innych założeniach.

Przykład:

> Nie możemy potwierdzić dodatkowych 10-20 g CHO. Jeśli ich nie było, wynik obliczenia wynosi X. Jeśli były, bardziej prawdopodobny jest zakres Y-Z. Historia podobnych zdarzeń wskazuje...

System nie powinien wymagać pełnej pewności, aby być użyteczny.

---

### 4.5. Fakty, raporty, obliczenia i hipotezy muszą być rozdzielone

System powinien rozróżniać:

* dane źródłowe,
* informacje podane przez użytkownika,
* informacje wywnioskowane,
* wyniki obliczeń,
* wzorce historyczne,
* hipotezy,
* wiedzę medyczną.

Nie wolno bezpośrednio zamieniać hipotezy w fakt.

Jednocześnie hipoteza może być użyteczna w podejmowaniu decyzji, jeżeli jej niepewność jest jawnie przedstawiona.

---

### 4.6. Każda istotna informacja powinna mieć źródło

System powinien móc odpowiedzieć:

> Skąd to wiemy?

Przykładowe źródła:

* Nightscout,
* pompa,
* CGM,
* użytkownik,
* analiza systemowa,
* wyliczenie,
* publikacja naukowa,
* wytyczne,
* dokumentacja urządzenia.

---

## 5. Moduły produktu

### 5.1. Chat

Chat jest głównym interfejsem rozmowy z AI.

Powinien:

* przechowywać historię rozmów,
* mieć dostęp do odpowiedniego kontekstu,
* wykorzystywać pamięć długoterminową,
* korzystać z danych bieżących,
* korzystać z wiedzy zewnętrznej, gdy jest potrzebna,
* umożliwiać rozpoczęcie rozmowy z innych modułów,
* przedstawiać konkretne propozycje, jeżeli kontekst na to pozwala.

Rozmowy rozpoczęte automatycznie przez system, np. po wykryciu hipoglikemii, również powinny być dostępne w historii.

Treść rozmowy nie jest jednak tym samym co pamięć długoterminowa.

---

### 5.2. Therapy

Moduł terapii prezentuje aktualne ustawienia terapii oraz analizy ich działania.

Może obejmować:

* profile,
* bazę,
* ICR,
* ISF,
* target,
* DIA,
* inne parametry istotne dla używanej terapii.

AI może:

* analizować aktualne ustawienia,
* wykrywać wzorce sugerujące problem,
* wskazywać parametry warte ponownej oceny,
* przedstawiać konkretne propozycje zmian,
* wyjaśniać podstawę tych propozycji.

Każda propozycja powinna wskazywać:

* jakie dane zostały wykorzystane,
* jaki okres obejmowała analiza,
* jakie zdarzenia zostały uwzględnione,
* jakie wzorce wykryto,
* jakie są alternatywne wyjaśnienia,
* jak silne jest dostępne evidence,
* jakie dane są niepewne.

AI nie zmienia ustawień automatycznie.

---

### 5.3. Meal

Moduł posiłku umożliwia wprowadzenie posiłku za pomocą:

* tekstu,
* zdjęcia,
* kombinacji tekstu i zdjęcia.

System powinien uwzględniać m.in.:

* szacowane węglowodany,
* tłuszcz,
* białko,
* aktualną glikemię,
* trend,
* IOB,
* niedawno podaną insulinę,
* ustawienia terapii,
* wcześniejsze posiłki,
* aktywność,
* sen,
* chorobę,
* wcześniejsze podobne posiłki.

System powinien móc przedstawić:

* szacowaną ilość CHO,
* zakres, jeśli oszacowanie jest niepewne,
* wynik obliczenia dawki,
* korektę wynikającą z aktualnego stanu,
* wpływ IOB,
* wpływ trendu,
* dodatkowe scenariusze wynikające z niepewności,
* proponowaną dawkę lub zakres do oceny przez użytkownika.

Przykładowy wynik:

> Szacuję posiłek na 45-50 g CHO. Przy aktualnym ICR obliczenie bazowe daje 3,75-4,17 U. Po uwzględnieniu aktualnego trendu i IOB system proponuje 3,5-4,0 U. Największą niepewnością jest faktyczna ilość zjedzonych CHO.

Dokładna metoda obliczeń musi być wykonywana przez deterministyczny silnik.

LLM odpowiada za interpretację kontekstu, wybór istotnych informacji, porównanie scenariuszy i komunikację wyniku.

---

### 5.4. Context & Trigger Engine

System powinien reagować na zdarzenia wymagające dodatkowego kontekstu.

Przykładowe triggery:

* znacząca hipoglikemia,
* powtarzające się hipoglikemie,
* nietypowa hiperglikemia,
* nieoczekiwany przebieg po posiłku,
* nietypowa reakcja po aktywności,
* powtarzający się wzorzec nocny,
* zdarzenie odbiegające od historii.

Po wykryciu zdarzenia system może rozpocząć krótką rozmowę.

Przykład:

> W poprzednich godzinach widzę aktywność. Czy było to coś bardziej intensywnego niż zwykle?

Jeżeli użytkownik odpowie:

> Nie wiem.

system zapisuje `UNKNOWN` i kontynuuje analizę.

---

### 5.5. Pattern Engine

Pattern Engine odpowiada za wykrywanie powtarzalnych zależności w historii.

Przykład:

> W 8 z 11 porównywalnych przypadków wieczorne pływanie było związane z późniejszym spadkiem glukozy.

Każdy wzorzec powinien mieć:

* definicję,
* zakres czasowy,
* zbiór zdarzeń będących podstawą,
* liczbę obserwacji,
* liczbę przypadków potwierdzających,
* przypadki przeczące,
* poziom pewności,
* wersję algorytmu,
* datę ostatniej oceny.

Pattern Engine nie powinien sam z siebie tworzyć medycznej prawdy.

Wzorzec obserwowany u konkretnego pacjenta jest informacją o historii tego pacjenta.

---

### 5.6. Medical Knowledge

System powinien korzystać nie tylko z wiedzy wbudowanej w model.

Warstwa wiedzy powinna umożliwiać korzystanie m.in. z:

* wytycznych klinicznych,
* publikacji naukowych,
* przeglądów systematycznych,
* metaanaliz,
* dokumentacji urządzeń,
* dokumentacji systemów takich jak Loop,
* innych zweryfikowanych źródeł.

Wiedza zewnętrzna powinna być przechowywana i wyszukiwana przez kontrolowaną warstwę Knowledge Retrieval / RAG.

RAG odpowiada za wiedzę zewnętrzną, a nie za pamięć konkretnego pacjenta.

System powinien móc odróżnić:

> Literatura opisuje takie zjawisko.

od:

> U tego pacjenta wystąpiło takie zjawisko.

Dopiero połączenie obu informacji może stanowić podstawę bardziej użytecznej analizy.

---

## 6. Model kontekstu

Kontekst pacjenta powinien obejmować co najmniej:

### Aktywność

* rodzaj aktywności,
* intensywność,
* czas rozpoczęcia,
* czas zakończenia,
* czas od aktywności do zdarzenia,
* powtarzalność aktywności.

### Jedzenie

* posiłek,
* szacowane węglowodany,
* tłuszcz,
* białko,
* wielkość posiłku,
* faktycznie zjedzona ilość,
* możliwość niedokończenia posiłku,
* dodatkowe przekąski.

### Sen

* długość snu,
* jakość snu,
* nietypowa noc,
* późne zasypianie,
* częste pobudki.

### Choroba

* infekcja,
* gorączka,
* złe samopoczucie,
* inne istotne objawy.

### Kontekst terapii

* podana insulina,
* timing insuliny,
* zmiany bazowe,
* temporary basal,
* ustawienia profilu,
* działanie systemu automatycznej regulacji.

Nie wszystkie te informacje muszą być znane.

Brak informacji powinien być reprezentowany jawnie.

---

## 7. Wiedza indywidualna

System powinien budować wiedzę o konkretnym pacjencie w czasie.

Nie należy ograniczać się do historii rozmów.

Wiedza indywidualna powinna obejmować m.in.:

* powtarzające się zachowania,
* typowe reakcje,
* charakterystyczne wzorce,
* preferencje,
* powtarzające się sytuacje,
* wcześniejsze podobne zdarzenia,
* informacje przekazywane przez opiekuna,
* aktywne hipotezy.

Przykład:

> Pacjent często nie kończy posiłku, gdy jest zmęczony.

Jest to inny rodzaj informacji niż:

> Dzisiaj pacjent zjadł połowę posiłku.

Pierwsza informacja może stać się wiedzą długoterminową.

Druga jest przede wszystkim zdarzeniem.

---

## 8. Hipotezy

System powinien umożliwiać przechowywanie hipotez dotyczących przyczyn obserwowanych zdarzeń.

Przykład:

> Późne spadki po wieczornej aktywności mogą być związane z wysiłkiem.

Hipoteza powinna mieć:

* opis,
* zakres,
* podstawę,
* zdarzenia wspierające,
* zdarzenia przeczące,
* poziom pewności,
* czas utworzenia,
* czas ostatniej aktualizacji,
* status.

Hipoteza może być:

* nowa,
* aktywna,
* wspierana,
* osłabiona,
* sprzeczna z nowymi danymi,
* wygaszona.

Hipoteza może wpływać na analizę i proponowane scenariusze, ale nie może być automatycznie traktowana jako fakt.

---

## 9. Brakujące i sprzeczne informacje

System powinien jawnie reprezentować:

* brak danych,
* `UNKNOWN`,
* niepełne dane,
* sprzeczne źródła,
* dane o różnym poziomie wiarygodności.

Przykład:

Nightscout:

> posiłek 50 g CHO

Później użytkownik:

> prawdopodobnie zjadł tylko połowę.

System nie powinien po prostu nadpisać pierwszej informacji.

Powinien zachować:

* informację z Nightscout,
* późniejszą informację użytkownika,
* źródło każdej informacji,
* czas ich zgłoszenia,
* status konfliktu.

AI może wtedy powiedzieć:

> W systemie zapisano 50 g CHO, ale później zgłoszono, że prawdopodobnie zjedzono mniej. Faktyczna ilość jest więc niepewna. Dla celów analizy rozważam oba scenariusze.

---

## 10. Adaptacyjne zadawanie pytań

AI nie powinno przeprowadzać pełnego formularza po każdym zdarzeniu.

Każde pytanie powinno mieć uzasadnienie informacyjne:

> Czy odpowiedź na to pytanie może istotnie zmienić analizę?

Jeżeli nie, pytanie nie powinno być zadawane.

System powinien preferować pytania o najwyższej wartości informacyjnej.

Jeżeli użytkownik nie zna odpowiedzi, system nie powinien zatrzymywać analizy.

Powinien zapisać `UNKNOWN`, ocenić wpływ tej niewiadomej i kontynuować.

---

## 11. Uczenie się z odpowiedzi „nie wiem”

`UNKNOWN` nie jest bezużyteczną odpowiedzią.

Jeżeli użytkownik regularnie nie zna odpowiedzi na określone pytanie, system powinien to zapamiętać jako informację o jakości dostępnego kontekstu.

Przykład:

Jeżeli pytanie:

> Czy była aktywność w poprzednich 3 godzinach?

regularnie otrzymuje:

> Nie wiem.

system może z czasem uznać, że:

* pytanie ma ograniczoną użyteczność,
* informacja jest trudna do uzyskania,
* trzeba znaleźć inne źródło danych,
* należy zmienić sposób zadawania pytania,
* nie należy wielokrotnie obciążać użytkownika tym samym pytaniem.

System nie powinien karać użytkownika za brak wiedzy.

---

## 12. Deterministyczne obliczenia i AI

LLM nie powinien być odpowiedzialny za krytyczne obliczenia.

Obliczenia powinny być wykonywane przez deterministyczny, testowalny i wersjonowany silnik.

Dotyczy to w szczególności:

* obliczeń dawek,
* korekt,
* ICR,
* ISF,
* IOB,
* przeliczeń węglowodanów,
* innych obliczeń terapeutycznych.

Wynik obliczenia powinien zawierać:

* wejścia,
* źródła danych,
* założenia,
* zastosowaną metodę,
* wersję algorytmu,
* wynik,
* zakres lub niepewność, jeśli ma zastosowanie.

LLM może następnie:

* wyjaśnić wynik,
* zestawić go z kontekstem,
* uwzględnić historię,
* porównać scenariusze,
* wskazać ograniczenia,
* przedstawić użytkownikowi konkretną propozycję.

---

## 13. Model rozumowania AI

AI powinno otrzymywać przygotowany, strukturalny pakiet kontekstu.

Nie należy przekazywać całej historii danych do każdego prompta.

Przykładowy kontekst:

```text
CURRENT STATE
- glucose
- trend
- IOB
- recent insulin
- current therapy

CURRENT EVENT
- event type
- timestamp
- relevant recent events

KNOWN CONTEXT
- confirmed information
- caregiver reports

UNKNOWN
- missing information relevant to analysis

RELEVANT HISTORY
- similar events
- relevant episodes

PATTERNS
- active child-specific patterns

HYPOTHESES
- active hypotheses

CALCULATIONS
- deterministic results
- inputs
- assumptions
- algorithm version

MEDICAL KNOWLEDGE
- relevant retrieved evidence
- source metadata

USER PREFERENCES
- communication style
- custom instructions

AI CONTRACT
- system rules
- safety constraints
- behavior requirements
```

AI powinno otrzymywać tylko informacje istotne dla aktualnego zadania.

---

## 14. Personalizacja i konfiguracja użytkownika

Produkt powinien być od początku projektowany tak, aby nie zakładać konkretnej relacji między użytkownikiem a pacjentem.

Profil powinien móc zawierać m.in.:

* relację użytkownika do pacjenta,
* grupę wiekową pacjenta,
* typ cukrzycy,
* preferowany sposób komunikacji,
* poziom wiedzy użytkownika,
* dodatkowe instrukcje dla AI.

Przykład instrukcji użytkownika:

> Rozmawiaj ze mną jak z opiekunem osoby z T1D. Znam podstawy obsługi pompy i Loop, więc nie tłumacz mi podstaw. Jeżeli czegoś nie wiem, nie zakładaj, że odpowiedź brzmi „nie”. Kontynuuj analizę na podstawie dostępnych danych i pokaż możliwe wyjaśnienia.

Custom instructions są preferencją użytkownika, a nie substytutem reguł systemowych, modelu domeny ani AI Contract.

---

## 15. Doświadczenie użytkownika

System powinien minimalizować obciążenie użytkownika, jednocześnie maksymalizując konkretną wartość odpowiedzi.

Nie powinien:

* zadawać wielu pytań bez powodu,
* powtarzać informacji, które już zna,
* wymagać ręcznego wpisywania wszystkiego,
* udawać pewności,
* ukrywać niepewności,
* zasłaniać się ogólnymi komunikatami medycznymi zamiast wykonać dostępną analizę.

Powinien:

* wykorzystywać dane automatycznie dostępne,
* pamiętać istotny kontekst,
* pytać tylko o informacje o wysokiej wartości,
* pozwalać odpowiedzieć „nie wiem”,
* kontynuować analizę mimo braków,
* pokazywać podstawę swoich wniosków,
* wykonywać konkretne obliczenia,
* przedstawiać konkretne propozycje, gdy dane na to pozwalają,
* umożliwiać przejście z propozycji do rozmowy wyjaśniającej.

---

## 16. Kryteria sukcesu

### Użyteczność

AI dostarcza informacje i propozycje, których użytkownik sam prawdopodobnie nie uzyskałby bez ręcznej analizy wielu danych.

### Konkretność

Jeżeli system ma wystarczające dane, użytkownik powinien otrzymać konkretny wynik zamiast ogólnej porady.

Przykłady:

* konkretna ilość CHO lub zakres,
* konkretne obliczenie dawki,
* konkretny zakres propozycji,
* konkretne wyjaśnienie najbardziej prawdopodobnych scenariuszy,
* konkretne wskazanie wzorca historycznego.

### Kontekst

System uwzględnia dane wykraczające poza samą glikemię i insulinę.

### Pamięć

System pamięta istotne informacje o pacjencie, ale nie zaśmieca pamięci przypadkowymi szczegółami.

### Niepewność

System poprawnie rozróżnia:

* wiem,
* nie wiem,
* prawdopodobne,
* możliwe,
* sprzeczne.

Niepewność wpływa na sposób przedstawienia propozycji, ale sama w sobie nie blokuje odpowiedzi.

### Personalizacja

System rozumie indywidualne wzorce pacjenta zamiast udzielać wyłącznie ogólnych porad.

### Wiedza

System może korzystać ze zweryfikowanej wiedzy zewnętrznej i wskazywać źródła.

### Wyjaśnialność

Użytkownik może zrozumieć:

* co system wie,
* czego nie wie,
* co policzył,
* co zaobserwował w historii,
* jakie ma hipotezy,
* jakie źródła wiedzy wykorzystał,
* dlaczego przedstawił konkretną propozycję.

### Bezpieczeństwo

System nie wykonuje autonomicznie działań terapeutycznych.

---

## 17. Czym produkt nie jest

Produkt nie jest:

* autonomicznym systemem podającym insulinę,
* zamiennikiem lekarza,
* prostym chatbotem odpowiadającym na pytania,
* wyszukiwarką publikacji naukowych,
* bazą danych Nightscout z interfejsem czatu,
* systemem opartym wyłącznie na promptach,
* systemem, który traktuje każdą odpowiedź LLM jako fakt.

Nie jest również konieczne, aby użytkownik prowadził idealny dziennik.

System ma być użyteczny również wtedy, gdy dane są niepełne.

**Niepełne dane powinny powodować większą jawność niepewności, a nie automatyczną rezygnację z konkretnej analizy.**

---

## 18. Główna zasada produktu

System powinien konsekwentnie dążyć do odpowiedzi w strukturze:

> **Oto co wiemy.**
>
> **Oto czego nie wiemy.**
>
> **Oto co sugerują dane z historii.**
>
> **Oto jakie są możliwe wyjaśnienia.**
>
> **Oto co mówi dostępna wiedza zewnętrzna.**
>
> **Oto wynik obliczenia, jeśli ma zastosowanie.**
>
> **Oto najbardziej uzasadniona propozycja na podstawie dostępnych danych.**
>
> **Oto co najbardziej wpływa na niepewność tej propozycji.**

Celem nie jest udawanie pewności.

Celem jest dostarczenie człowiekowi **możliwie konkretnej i użytecznej propozycji na podstawie dostępnych danych, historii pacjenta, wiedzy zewnętrznej, deterministycznych obliczeń i jawnie przedstawionej niepewności.**

### Zasada nadrzędna

**AI nie ma być ani bezrefleksyjnie pewne, ani bezrefleksyjnie ostrożne. Ma być konkretnie użyteczne.**

Jeżeli dane pozwalają na wyliczenie - policz.

Jeżeli dane pozwalają na propozycję - zaproponuj.

Jeżeli istnieje kilka sensownych scenariuszy - pokaż je i wskaż, który ma więcej wsparcia w danych.

Jeżeli czegoś nie wiemy - nazwij to.

Jeżeli brakująca informacja może zmienić wynik - zapytaj o nią.

Jeżeli użytkownik nie zna odpowiedzi - kontynuuj analizę mimo `UNKNOWN`.

Jeżeli propozycja wymaga decyzji człowieka - przedstaw ją jako propozycję, a nie jako automatyczne działanie.
