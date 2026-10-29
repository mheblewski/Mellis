# MEMORY.md

# Specyfikacja pamięci i wiedzy indywidualnej GlucoMind

## 1. Cel

Pamięć GlucoMind ma sprawić, że system z czasem coraz lepiej rozumie konkretnego pacjenta i jego kontekst.

GlucoMind nie powinien za każdym razem analizować sytuacji tak, jakby widział ją pierwszy raz.

System powinien pamiętać istotne informacje, ale nie powinien zamieniać całej historii rozmów w jeden niekontrolowany blok tekstu.

Pamięć jest **ustrukturyzowaną warstwą wiedzy o pacjencie**, która współpracuje z danymi źródłowymi, analizą wzorców, obliczeniami oraz wiedzą zewnętrzną.

---

## 2. Podstawowe rozróżnienie

W GlucoMind należy rozdzielić:

1. **Working memory** - kontekst aktualnej rozmowy i zadania.
2. **Episodic memory** - konkretne zdarzenia z historii pacjenta.
3. **Context memory** - informacje o zachowaniach i okolicznościach istotnych dla przyszłych analiz.
4. **Pattern memory** - powtarzalne zależności wykryte w historii.
5. **Hypothesis memory** - aktywne hipotezy dotyczące możliwych przyczyn i zależności.
6. **Stable profile** - względnie trwałe informacje o pacjencie i użytkowniku.
7. **Analysis memory** - istotne wyniki wcześniejszych analiz i obliczeń.

Żadna z tych warstw nie powinna być zastępowana przez jedną tabelę tekstowych „wspomnień”.

---

## 3. Working memory

Working memory zawiera informacje potrzebne AI **tu i teraz**.

Może obejmować:

- ostatnie wiadomości rozmowy,
- aktualne pytanie,
- bieżące zdarzenie,
- ostatni stan glukozy,
- aktywną terapię,
- aktualne IOB,
- ostatnie posiłki,
- ostatnią aktywność,
- ostatnie odpowiedzi użytkownika,
- istotne niewiadome.

Working memory jest tymczasowa.

Nie każda informacja z working memory powinna zostać zapisana jako pamięć długoterminowa.

### Zasada

> To, że AI widzi informację, nie oznacza, że powinno ją zapamiętać.

---

## 4. Episodic memory

Episodic memory reprezentuje konkretne zdarzenia.

Przykłady:

- hipoglikemia,
- hiperglikemia,
- posiłek,
- bolus,
- aktywność fizyczna,
- choroba,
- nietypowy sen,
- niedokończony posiłek,
- dodatkowa przekąska,
- nietypowa reakcja na posiłek.

Przykład:

> 2026-09-15, 21:40 - glukoza spadła do 62 mg/dL po wieczornym pływaniu.

To jest pamięć zdarzenia.

Nie musi oznaczać:

> Wieczorne pływanie powoduje hipoglikemię.

Drugie stwierdzenie wymaga wielu obserwacji i należy do Pattern Memory lub Hypothesis Memory.

### Każde zdarzenie powinno mieć

- typ,
- czas wystąpienia,
- czas zarejestrowania,
- źródło,
- powiązane dane źródłowe,
- istotny kontekst,
- znane informacje,
- nieznane informacje,
- ewentualne sprzeczności,
- powiązane analizy.

Należy rozróżniać **czas zdarzenia** od **czasu jego zapisania**.

---

## 5. Context memory

Context memory przechowuje informacje, które mogą być użyteczne w przyszłych sytuacjach, ale nie są pojedynczym zdarzeniem.

Przykład:

> Pacjent często nie kończy posiłków, kiedy jest zmęczony.

albo:

> Użytkownik preferuje krótkie, konkretne odpowiedzi i zna podstawy działania systemu Loop.

Informacje tego typu mogą mieć duże znaczenie dla przyszłych decyzji.

### Ważne

Context memory nie powinno być tworzone na podstawie każdej pojedynczej wypowiedzi.

Pojedyncze zdarzenie:

> Dzisiaj pacjent nie zjadł całej kolacji.

nie powinno automatycznie stworzyć:

> Pacjent często nie kończy posiłków.

Potrzebne jest rozróżnienie między obserwacją jednostkową a trwałą cechą.

---

## 6. Pattern memory

Pattern memory przechowuje zależności obserwowane wielokrotnie w historii.

Przykład:

> W 8 z 11 porównywalnych przypadków wieczornego pływania występował późniejszy spadek glukozy.

Pattern powinien zawierać:

- definicję wzorca,
- warunki jego wystąpienia,
- okres analizy,
- liczbę obserwacji,
- przypadki potwierdzające,
- przypadki przeczące,
- powiązane zdarzenia,
- siłę zależności,
- confidence,
- datę ostatniej aktualizacji,
- wersję algorytmu, który go wykrył.

Pattern jest obserwacją o historii pacjenta.

Nie jest automatycznie dowodem przyczynowości.

---

## 7. Hypothesis memory

Hypothesis memory przechowuje możliwe wyjaśnienia obserwowanych zdarzeń.

Przykład:

> Późny spadek glukozy może być związany z wieczorną aktywnością.

Hipoteza może być wspierana przez:

- podobne zdarzenia,
- wzorce historyczne,
- dane bieżące,
- wiedzę medyczną,
- wyniki wcześniejszych analiz.

Może być osłabiana przez:

- przypadki, w których wzorzec nie wystąpił,
- sprzeczne dane,
- alternatywne wyjaśnienia,
- nowe informacje.

### Hipoteza nie jest faktem

System może używać hipotezy podczas analizy, ale musi zachować jej status.

---

## 8. Stable profile

Stable profile zawiera informacje, które są względnie trwałe.

Może obejmować:

### Pacjenta

- podstawowe informacje profilowe,
- typ cukrzycy,
- grupę wiekową,
- istotne cechy terapii,
- długoterminowe preferencje i zachowania.

### Użytkownika

- relację do pacjenta,
- poziom wiedzy,
- preferowany styl komunikacji,
- preferencje dotyczące sposobu prezentowania wyników,
- custom instructions.

Stable profile nie powinien być tworzony wyłącznie przez swobodne wnioskowanie LLM.

Informacje o wysokim znaczeniu powinny mieć odpowiednie źródło i możliwość aktualizacji.

---

## 9. Analysis memory

Niektóre analizy powinny być przechowywane jako osobne artefakty.

Przykłady:

- analiza konkretnej hipoglikemii,
- analiza posiłku,
- analiza ustawienia ICR,
- analiza wzorca nocnego,
- porównanie podobnych zdarzeń,
- wynik eksperymentu.

Analiza powinna zachowywać:

- pytanie lub cel analizy,
- dane wejściowe,
- wykorzystane zdarzenia,
- wykorzystane wzorce,
- wykorzystane hipotezy,
- wykorzystane źródła medyczne,
- wyniki obliczeń,
- wnioski,
- wersję algorytmu,
- czas wykonania.

Dzięki temu system może później odpowiedzieć:

> Dlaczego wtedy zaproponowałeś taki wynik?

i odtworzyć podstawę wcześniejszej analizy.

---

## 10. UNKNOWN jako pełnoprawny stan pamięci

`UNKNOWN` jest częścią modelu wiedzy.

Nie oznacza:

- `NO`,
- `FALSE`,
- braku znaczenia.

Przykład:

> Czy pacjent jadł coś dodatkowo?

Odpowiedź:

> Nie wiem.

powinna zostać zapisana jako:

```text
value = UNKNOWN
```

z odpowiednim:

- źródłem,
- czasem,
- zakresem,
- kontekstem.

### UNKNOWN może być lokalne

> Nie wiem, czy dzisiaj była przekąska.

Nie oznacza:

> Pacjent zwykle nie ma dodatkowych przekąsek.

### UNKNOWN może być również informacją o jakości danych

Jeżeli użytkownik wielokrotnie nie zna odpowiedzi na określone pytanie, system może nauczyć się, że:

- informacja jest trudna do uzyskania,
- pytanie ma ograniczoną użyteczność,
- potrzebne jest inne źródło danych,
- należy zmienić sposób zadawania pytania.

---

## 11. Pamięć nie jest transkrypcją rozmowy

Historia rozmowy i pamięć długoterminowa mają różne cele.

### Chat

Przechowuje:

- co zostało powiedziane,
- kiedy zostało powiedziane,
- przebieg rozmowy.

### Memory

Przechowuje:

- informacje przydatne w przyszłości,
- zdarzenia,
- kontekst,
- wzorce,
- hipotezy,
- stabilne informacje.

Nie należy przekazywać całej historii czatu do każdego prompta tylko po to, aby AI „pamiętało”.

Zamiast tego system powinien wyciągać istotne informacje i przechowywać je strukturalnie.

---

## 12. Memory extraction

Po rozmowie lub w jej trakcie AI może wskazać informacje, które potencjalnie powinny zostać zapamiętane.

Przykład:

```text
Conversation
    ↓
Memory Extraction
    ↓
Candidate Memories
    ↓
Memory Policy
    ↓
Store / Reject / Update
```

LLM może proponować kandydatów, ale **LLM nie powinien samodzielnie decydować o całej pamięci systemu**.

Powinna istnieć kontrolowana warstwa Memory Policy.

---

## 13. Candidate memory

Każdy kandydat pamięci powinien mieć co najmniej:

- `content`,
- `memory_type`,
- `source_type`,
- `source_id`,
- `observed_at`,
- `created_at`,
- `confidence`,
- `specificity`,
- `temporal_scope`,
- `scope`,
- `expected_relevance`,
- `recurrence`,
- `status`.

Przykładowe `source_type`:

- `CAREGIVER`
- `NIGHTSCOUT`
- `CGM`
- `PUMP`
- `DEVICE`
- `SYSTEM_ANALYSIS`
- `AI_INFERENCE`
- `MEDICAL_SOURCE`

---

## 14. Memory Policy

Memory Policy odpowiada za decyzję:

> Czy tę informację warto zachować i na jak długo?

Przy ocenie pamięci należy brać pod uwagę m.in.:

### Powtarzalność

Czy informacja pojawiła się wielokrotnie?

### Istotność

Czy może wpłynąć na przyszłą analizę?

### Stabilność

Czy prawdopodobnie pozostanie prawdziwa przez dłuższy czas?

### Jawność

Czy użytkownik powiedział to bezpośrednio, czy system tylko to wywnioskował?

### Wiarygodność źródła

Skąd pochodzi informacja?

### Zakres

Czy dotyczy:

- konkretnego zdarzenia,
- posiłku,
- rodzaju aktywności,
- określonej pory dnia,
- szerszego okresu,
- całego profilu pacjenta?

### Sprzeczności

Czy istnieją inne informacje przeczące tej informacji?

### Potencjalny wpływ

Czy wykorzystanie tej informacji w przyszłości może istotnie zmienić analizę?

---

## 15. Nie każda informacja zasługuje na pamięć długoterminową

### Przykład - zdarzenie

> Dzisiaj pacjent zjadł połowę banana.

Powinno zostać zapisane jako zdarzenie.

Nie musi stać się trwałą cechą profilu.

### Przykład - informacja trwała

> Pacjent często nie kończy posiłków, kiedy jest zmęczony.

Może zostać promowana do Context Memory.

### Przykład - wzorzec

> Po określonym typie aktywności często występuje późniejszy spadek.

Powinien być reprezentowany jako Pattern lub Hypothesis.

### Przykład - niska wartość

> Użytkownik wspomniał przypadkową informację niezwiązaną z cukrzycą.

Nie powinna trafić do pamięci pacjenta.

---

## 16. Cykl życia pamięci

Pamięć nie powinna być statyczna.

Proponowany cykl:

```text
CANDIDATE
    ↓
OBSERVED
    ↓
REPEATED
    ↓
EMERGING
    ↓
SUPPORTED
    ↓
ACTIVE
```

Możliwe ścieżki alternatywne:

```text
ACTIVE
   ↓
WEAKENED
   ↓
EXPIRED
```

lub:

```text
ACTIVE
   ↓
CONTRADICTED
```

lub:

```text
CANDIDATE
   ↓
REJECTED
```

Nie należy traktować jednego zdarzenia jako automatycznego potwierdzenia długoterminowego wzorca.

---

## 17. Promocja pamięci

Informacja może być promowana do bardziej trwałej warstwy wraz z pojawianiem się kolejnych dowodów.

Przykład:

### Obserwacja 1

> Po wieczornym pływaniu wystąpił późny spadek.

Status:

```text
OBSERVED
```

### Obserwacje 2-3

Podobne przypadki.

Status:

```text
REPEATED
```

### Kolejne obserwacje

System wykrywa zależność.

Status:

```text
EMERGING PATTERN
```

### Kolejne potwierdzenia

Wzorzec staje się stabilniejszy.

Status:

```text
SUPPORTED
```

Jeżeli kolejne dane zaczną mu przeczyć, confidence powinno się zmniejszać.

---

## 18. Aktualizacja i wygaszanie pamięci

Pamięć powinna być aktualizowana przez nowe dane.

Niektóre informacje mogą wygasać.

Przykłady:

- chwilowa choroba,
- nietypowy dzień,
- krótkotrwała zmiana zachowania,
- tymczasowe ustawienie,
- pojedynczy stan.

Inne informacje powinny być długotrwałe:

- stabilne preferencje,
- względnie trwałe cechy,
- długoterminowe wzorce.

### Ważne

Wygaszenie pamięci nie musi oznaczać fizycznego usunięcia danych.

Dla celów audytu należy móc zachować historię zmian:

```text
ACTIVE
→ WEAKENED
→ EXPIRED
```

---

## 19. Konflikty pamięci

System nigdy nie powinien bez informacji o źródle cicho nadpisywać jednej informacji drugą.

Przykład:

```text
Nightscout:
meal = 50 g CHO

Caregiver:
probably ate only half
```

System powinien zachować obie informacje i reprezentować konflikt.

Przykładowy stan:

```text
CONFLICTING_INFORMATION
```

AI powinno móc wykorzystać oba źródła i poinformować użytkownika o konflikcie.

---

## 20. Provenance

Każda istotna pamięć powinna mieć możliwość prześledzenia źródła.

Minimalnie:

```text
memory
    ↓
source_type
source_id
observed_at
created_at
```

Jeżeli pamięć wynika z analizy:

```text
memory
    ↓
analysis
    ↓
source events
```

Jeżeli wzorzec wynika z wielu zdarzeń:

```text
pattern
    ↓
event 1
event 2
event 3
...
event N
```

System powinien móc odpowiedzieć:

> Z jakich zdarzeń powstał ten wzorzec?

---

## 21. Confidence

Confidence powinno być traktowane jako właściwość pamięci, a nie ozdobny tekst wygenerowany przez LLM.

Na confidence mogą wpływać:

- źródło,
- bezpośredniość informacji,
- liczba obserwacji,
- powtarzalność,
- zgodność danych,
- sprzeczności,
- czas,
- stabilność informacji.

Nie należy pozwalać LLM dowolnie wymyślać wartości confidence.

Jeżeli confidence jest obliczane, sposób jego obliczania powinien być określony przez system.

---

## 22. Zakres czasowy pamięci

Pamięć powinna mieć określony zakres czasowy.

Przykładowo:

```text
ONE_TIME
TEMPORARY
RECURRING
LONG_TERM
STABLE
```

Przykład:

> Choroba w tym tygodniu.

`TEMPORARY`

> Pacjent często nie kończy posiłków przy zmęczeniu.

`RECURRING`

> Preferowany styl komunikacji użytkownika.

`STABLE`

Zakres czasowy powinien wpływać na retrieval i wygaszanie.

---

## 23. Zakres kontekstowy pamięci

Pamięć powinna określać, kiedy jest istotna.

Przykłady:

```text
GLOBAL
MEAL
ACTIVITY
SLEEP
ILLNESS
NIGHT
MORNING
EVENING
THERAPY
SPECIFIC_EVENT
```

Informacja:

> Po pływaniu występuje późniejszy spadek.

powinna być powiązana z:

```text
ACTIVITY = SWIMMING
TIME = EVENING
```

a nie traktowana jako globalna właściwość całej terapii.

---

## 24. Retrieval

System nie powinien przekazywać LLM całej pamięci.

Powinien najpierw określić:

> Jakiego rodzaju wiedzy potrzebuję do tego zadania?

Następnie pobrać:

- relevant current events,
- relevant recent history,
- similar historical events,
- relevant context memories,
- relevant patterns,
- active hypotheses,
- stable profile information,
- previous relevant analyses.

Retrieval powinien być zależny od aktualnego zadania.

---

## 25. Przykład retrieval

Aktualne pytanie:

> Dlaczego glukoza spadła po kolacji?

System może pobrać:

```text
CURRENT
- glucose trajectory
- insulin
- IOB
- dinner

RECENT EVENTS
- activity
- previous insulin
- previous meals

SIMILAR EVENTS
- previous dinners with similar composition

CONTEXT MEMORY
- incomplete meals when tired

PATTERNS
- late decline after evening swimming

HYPOTHESES
- exercise-related delayed effect

STABLE PROFILE
- current therapy settings
```

Nie ma potrzeby pobierania:

- przypadkowych rozmów,
- niezwiązanych posiłków,
- odległych zdarzeń bez podobieństwa,
- informacji o stylu komunikacji, jeśli nie wpływa na zadanie.

---

## 26. Ranking pamięci

Retrieval powinien uwzględniać więcej niż podobieństwo semantyczne.

Potencjalne czynniki:

```text
relevance
+
temporal proximity
+
context match
+
event similarity
+
memory confidence
+
source reliability
+
recurrence
+
decision impact
```

W przyszłości można wykorzystać:

- klasyczne filtrowanie SQL,
- scoring,
- full-text search,
- embeddingi,
- pgvector,
- hybrid retrieval.

Vector search nie powinien być jedynym mechanizmem pamięci.

---

## 27. Memory i RAG

Memory oraz RAG są od siebie niezależne.

### Memory odpowiada:

> Co wiemy o tym konkretnym pacjencie?

### RAG odpowiada:

> Co wiemy z zewnętrznych źródeł?

Przykład:

```text
PATIENT MEMORY
8/11 podobnych zdarzeń po wieczornym pływaniu
```

oraz:

```text
MEDICAL RAG
Literatura opisuje możliwość późniejszego wpływu wysiłku na glikemię.
```

To są dwa różne rodzaje evidence.

System nie powinien ich mieszać.

---

## 28. Memory i Nightscout

Nightscout pozostaje źródłem danych dotyczących danych, które faktycznie rejestruje.

Przykładowo:

- glukoza,
- insulina,
- bolusy,
- temporary basal,
- posiłki,
- dane urządzeń.

Memory nie powinna bez potrzeby kopiować całego Nightscout.

Zamiast tego powinna przechowywać:

- referencję do zdarzenia,
- istotny kontekst,
- wynik analizy,
- wykryty wzorzec,
- informację potrzebną do przyszłego retrieval.

---

## 29. Memory i LLM

LLM może:

- ekstraktować kandydatów,
- interpretować pamięć,
- proponować hipotezy,
- wyjaśniać wzorce,
- określać, jaka pamięć jest potrzebna do odpowiedzi.

LLM nie powinien być jedynym źródłem prawdy o pamięci.

Pamięć powinna być przechowywana strukturalnie i możliwa do audytu.

---

## 30. Context Assembly

Przed wywołaniem LLM system powinien zbudować pakiet kontekstu.

Przykład:

```text
CURRENT STATE
↓
CURRENT EVENT
↓
RELEVANT RECENT EVENTS
↓
SIMILAR HISTORICAL EVENTS
↓
CONTEXT MEMORY
↓
PATTERNS
↓
HYPOTHESES
↓
STABLE PROFILE
↓
CALCULATIONS
↓
MEDICAL KNOWLEDGE
↓
USER PREFERENCES
```

Dopiero taki pakiet trafia do AI.

---

## 31. Zasada minimalnego wystarczającego kontekstu

AI powinno otrzymać:

> **najmniejszy zestaw informacji wystarczający do dobrej odpowiedzi.**

Zbyt mały kontekst powoduje utratę istotnych informacji.

Zbyt duży kontekst powoduje:

- szum,
- większy koszt,
- gorsze skupienie modelu,
- większe ryzyko wykorzystania nieaktualnej informacji.

Context Retrieval powinien więc być aktywną częścią systemu, a nie prostym kopiowaniem historii.

---

## 32. Audytowalność pamięci

Każda istotna pamięć powinna być możliwa do prześledzenia.

Powinniśmy móc odpowiedzieć:

- kiedy została utworzona,
- na podstawie czego,
- przez jakie źródło,
- dlaczego została zapisana,
- dlaczego została awansowana,
- jakie dane ją wspierają,
- jakie dane jej przeczą,
- kiedy confidence się zmieniło,
- dlaczego została wygaszona.

To jest szczególnie ważne dla pamięci wpływającej na propozycje terapeutyczne.

---

## 33. Prywatność i minimalizacja

Pamięć powinna przechowywać informacje potrzebne do działania produktu.

Nie należy zapisywać informacji tylko dlatego, że technicznie można je zapisać.

Dla każdej kategorii informacji należy rozważyć:

- czy jest potrzebna,
- jak długo powinna być przechowywana,
- kto może mieć do niej dostęp,
- czy może wpływać na decyzje,
- czy jej źródło jest znane.

---

## 34. Testowanie pamięci

Pamięć musi być testowana tak samo jak logika biznesowa.

Testy powinny obejmować co najmniej:

### Ekstrakcję

Czy system poprawnie rozpoznaje informacje warte zapamiętania?

### UNKNOWN

Czy:

```text
"I don't know"
```

nie staje się:

```text
NO
```

### Promocję

Czy pojedyncze zdarzenie nie tworzy od razu trwałego wzorca?

### Powtarzalność

Czy kolejne podobne zdarzenia wzmacniają właściwy wzorzec?

### Sprzeczności

Czy system zachowuje sprzeczne źródła?

### Wygaszanie

Czy tymczasowe informacje przestają być aktywnym kontekstem?

### Retrieval

Czy dla konkretnego zadania pobierane są właściwe wspomnienia?

### Provenance

Czy można wskazać źródła pamięci?

### Odporność na halucynacje

Czy LLM nie może stworzyć pamięci, której źródło nie istnieje?

---

## 35. Przykładowy przepływ

```text
Caregiver:
"Po wczorajszym pływaniu znowu spadł mu cukier około północy."
        ↓
Memory Extraction
        ↓
Candidate Event
        ↓
Link to Nightscout data
        ↓
Memory Policy
        ↓
Episodic Memory
        ↓
Pattern Engine
        ↓
Find similar historical events
        ↓
Update Pattern Memory
        ↓
Update Hypothesis Memory
        ↓
Future Retrieval
        ↓
AI receives relevant history
```

Po wielu podobnych zdarzeniach system może dojść do:

```text
Pattern:
Late glucose decline after evening swimming

Evidence:
8 / 11 similar events

Status:
SUPPORTED

Confidence:
system-calculated

Sources:
11 linked events
```

---

## 36. Główna zasada pamięci

> **Pamiętaj to, co może pomóc w przyszłości, ale pamiętaj to w odpowiedniej formie.**

Pojedyncze zdarzenie powinno pozostać zdarzeniem.

Powtarzająca się obserwacja może stać się kontekstem.

Wielokrotnie potwierdzona zależność może stać się wzorcem.

Możliwe wyjaśnienie powinno pozostać hipotezą.

Stabilna informacja może wejść do profilu.

Informacja nieznana powinna pozostać `UNKNOWN`.

Każda istotna informacja powinna mieć źródło.

Każda pamięć powinna móc się zmienić pod wpływem nowych danych.

### Ostateczny cel

GlucoMind nie powinien po prostu **pamiętać więcej**.

Powinien **pamiętać lepiej**.

Pamięć ma umożliwić systemowi przejście od:

> „Mam dostęp do historii pacjenta”

do:

> „Rozumiem, które elementy tej historii są istotne dla obecnej sytuacji, dlaczego są istotne i jak silne jest ich poparcie w danych.”
