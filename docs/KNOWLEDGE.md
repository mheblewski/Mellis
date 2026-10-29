# KNOWLEDGE.md

# Specyfikacja warstwy wiedzy GlucoMind

## 1. Cel

GlucoMind nie powinien opierać się wyłącznie na wiedzy zapisanej w parametrach modelu językowego.

System powinien posiadać własną, kontrolowaną warstwę wiedzy zewnętrznej, która umożliwia wyszukiwanie, porównywanie i cytowanie wiarygodnych źródeł.

Warstwa ta ma wspierać AI w:

- rozumieniu zjawisk medycznych,
- interpretacji obserwowanych wzorców,
- weryfikowaniu hipotez,
- wyjaśnianiu mechanizmów,
- analizie zależności opisanych w literaturze,
- rozumieniu działania urządzeń i systemów,
- dostarczaniu użytkownikowi źródeł.

Nie jest jej celem zastąpienie rozumowania AI.

---

# 2. Podstawowe rozróżnienie

GlucoMind powinien rozdzielać trzy podstawowe rodzaje wiedzy:

```text
PATIENT DATA
    ↓
Co wydarzyło się u konkretnego pacjenta?

PATIENT MEMORY
    ↓
Co wiemy o tym konkretnym pacjencie z jego historii?

EXTERNAL KNOWLEDGE
    ↓
Co wiadomo z literatury, wytycznych i innych źródeł?
```

Przykład:

```text
Patient data:
Po pływaniu glukoza spadła.

Patient memory:
W 8 z 11 podobnych przypadków wystąpił późny spadek.

External knowledge:
Publikacje opisują możliwość późniejszego wpływu wysiłku na glikemię.
```

Żadna z tych informacji nie powinna być automatycznie traktowana jako tożsama z pozostałymi.

---

# 3. RAG

RAG (Retrieval-Augmented Generation) jest mechanizmem dostarczania AI odpowiednich fragmentów wiedzy z zewnętrznej bazy.

Podstawowy przepływ:

```text
User Question / Analysis Task
        ↓
Query Construction
        ↓
Knowledge Retrieval
        ↓
Relevant Evidence
        ↓
Context Assembly
        ↓
LLM
        ↓
Answer
```

RAG powinien być traktowany jako **retrieval layer**, a nie jako samodzielny system rozumowania.

---

# 4. Kiedy używać RAG

RAG powinien być używany wtedy, gdy zewnętrzna wiedza może istotnie poprawić odpowiedź.

Przykłady:

### Mechanizm medyczny

> Dlaczego po aktywności fizycznej może wystąpić późniejszy spadek glukozy?

### Interpretacja zjawiska

> Czy opisany przez nas wzorzec jest zgodny z tym, co opisuje literatura?

### Porównanie hipotez

> Czy istnieją dowody wspierające wpływ tłuszczu na opóźniony wzrost glikemii?

### Dokumentacja technologii

> Jak działa dany mechanizm w Loop?

### Wyjaśnienie

> Dlaczego system bierze pod uwagę ten czynnik?

---

# 5. Kiedy nie używać RAG

RAG nie powinien być używany jako źródło danych, które są już dostępne w systemie.

Przykład:

> Jaka była glukoza o 14:00?

Źródło:

```text
Nightscout
```

Nie:

```text
RAG
```

Podobnie:

> Ile insuliny zostało podane?

Źródło:

```text
Pump / Nightscout
```

Nie:

```text
Medical Knowledge
```

RAG nie powinien być wykorzystywany tylko dlatego, że system potrafi go uruchomić.

---

# 6. Kategorie wiedzy

Knowledge Base powinna być logicznie podzielona.

## 6.1. Wytyczne kliniczne

Przykładowo:

- ISPAD,
- ADA,
- inne uznane organizacje medyczne,
- lokalne i międzynarodowe wytyczne.

Wytyczne powinny mieć wysoką wagę przy pytaniach dotyczących aktualnych standardów postępowania.

---

## 6.2. Publikacje naukowe

Przykładowo:

- badania kliniczne,
- badania obserwacyjne,
- badania dotyczące dzieci,
- badania dotyczące aktywności,
- badania dotyczące żywienia,
- badania dotyczące insulinoterapii,
- badania dotyczące closed-loop.

---

## 6.3. Przeglądy systematyczne i metaanalizy

Powinny być możliwe do odróżnienia od pojedynczych badań.

System powinien znać typ evidence.

Przykład:

```text
META_ANALYSIS
SYSTEMATIC_REVIEW
RCT
OBSERVATIONAL_STUDY
CASE_REPORT
OTHER
```

---

## 6.4. Dokumentacja technologiczna

Może obejmować:

- Loop,
- Nightscout,
- pompy,
- CGM,
- urządzenia,
- integracje,
- algorytmy automatycznej regulacji,
- oficjalną dokumentację producentów.

Dokumentacja techniczna nie powinna być traktowana jako literatura kliniczna.

---

## 6.5. Materiały edukacyjne

Mogą być przydatne do wyjaśniania pojęć, ale należy je odróżniać od źródeł naukowych.

---

# 7. Source Metadata

Każde źródło powinno posiadać metadane.

Minimalnie:

```text
id
title
authors
organization
publication_date
source_type
url / identifier
version
language
topics
population
created_at
updated_at
```

Dodatkowo, jeśli dostępne:

```text
journal
doi
pmid
publisher
evidence_level
```

---

# 8. Population

To bardzo ważna właściwość źródła.

System powinien wiedzieć, dla jakiej populacji przeprowadzono badanie.

Przykładowo:

```text
PEDIATRIC
ADOLESCENT
ADULT
MIXED
UNKNOWN
```

Może być również potrzebne dokładniejsze oznaczenie:

```text
AGE_RANGE
```

System nie powinien bezrefleksyjnie przenosić wyników badań dorosłych na dzieci.

---

# 9. Contextual applicability

Relevance źródła nie powinna zależeć wyłącznie od podobieństwa tekstowego.

Powinna uwzględniać:

- populację,
- typ cukrzycy,
- rodzaj terapii,
- rodzaj aktywności,
- typ posiłku,
- kontekst kliniczny,
- datę,
- jakość źródła.

Przykład:

Badanie dotyczące dorosłych z T2D nie powinno otrzymywać takiej samej wartości dla pytania dotyczącego dziecka z T1D jak badanie pediatryczne dotyczące T1D.

---

# 10. Document

`Document` reprezentuje cały dokument źródłowy.

Może być:

- publikacją,
- wytyczną,
- dokumentacją,
- instrukcją,
- innym zatwierdzonym źródłem.

Dokument powinien mieć stabilny identyfikator.

---

# 11. Document Chunk

Dokument może być dzielony na fragmenty przeznaczone do retrieval.

Każdy chunk powinien zachowywać:

```text
document_id
chunk_id
content
position
metadata
embedding
```

Chunk nie powinien być całkowicie oderwany od dokumentu.

System musi móc przejść:

```text
Chunk
  ↓
Document
  ↓
Source
```

---

# 12. Embeddings

Embeddings mogą być wykorzystywane do wyszukiwania semantycznego.

Nie powinny jednak być jedynym mechanizmem retrieval.

Preferowany jest hybrid retrieval:

```text
Semantic Search
+
Keyword Search
+
Metadata Filtering
+
Source Quality
+
Context Relevance
```

W pierwszej wersji PostgreSQL + pgvector może być wystarczającą technologią.

Nie należy wprowadzać osobnej bazy wektorowej bez rzeczywistej potrzeby.

---

# 13. Query Construction

Zapytanie do Knowledge Base nie powinno być prostą kopią wiadomości użytkownika.

System powinien tworzyć query na podstawie zadania.

Przykład:

Użytkownik:

> Czy to może być przez wczorajsze pływanie?

System powinien rozumieć, że interesuje go m.in.:

```text
topic:
exercise

activity:
swimming

outcome:
late glucose decline

population:
patient age group

diabetes:
T1D

context:
post-exercise
```

Dzięki temu retrieval może być znacznie bardziej precyzyjny.

---

# 14. Retrieval Pipeline

Proponowany przepływ:

```text
Analysis Task
      ↓
Query Builder
      ↓
Metadata Filters
      ↓
Keyword Retrieval
      ↓
Semantic Retrieval
      ↓
Candidate Merge
      ↓
Re-ranking
      ↓
Evidence Selection
      ↓
Context Package
```

---

# 15. Re-ranking

Pierwszy etap retrieval może zwrócić wiele potencjalnie odpowiednich fragmentów.

Następnie system powinien je ocenić pod kątem:

- relevance,
- population match,
- topic match,
- source quality,
- evidence type,
- recency,
- context match.

Dopiero po tym wybrane fragmenty trafiają do AI.

---

# 16. Source Quality

Źródła powinny mieć określony poziom jakości.

Przykładowa klasyfikacja:

```text
TIER_1
- official clinical guidelines
- high-quality systematic reviews
- high-quality meta-analyses

TIER_2
- peer-reviewed clinical studies
- established scientific publications

TIER_3
- official technical documentation
- recognized educational resources

TIER_4
- secondary educational material
```

Klasyfikacja nie oznacza, że źródła niższej kategorii są zawsze niewłaściwe.

Oznacza jedynie, że ich zastosowanie powinno być odpowiednio interpretowane.

---

# 17. Recency

Wiedza medyczna i techniczna może się zmieniać.

System powinien przechowywać:

```text
publication_date
effective_date
version
retrieved_at
```

Przy pytaniach dotyczących aktualnych zaleceń preferowane powinny być aktualne źródła.

Przy pytaniach historycznych należy uwzględniać źródła obowiązujące w odpowiednim okresie.

---

# 18. Versioning

Knowledge Base powinna obsługiwać wersje dokumentów.

Przykład:

```text
Guideline 2025
Guideline 2026
```

Nie należy traktować ich jako jednego dokumentu.

System powinien wiedzieć, która wersja została wykorzystana w analizie.

---

# 19. Citation

Jeżeli odpowiedź AI opiera się na zewnętrznej wiedzy, użytkownik powinien móc zobaczyć źródło.

Citation powinno umożliwiać przejście do:

```text
source
→ document
→ relevant section
→ relevant fragment
```

AI nie powinno generować fikcyjnych źródeł.

Każde cytowanie musi pochodzić z faktycznie pobranego źródła.

---

# 20. Evidence vs Conclusion

RAG dostarcza evidence.

LLM może na jego podstawie wyciągać wnioski, ale należy rozdzielić:

```text
SOURCE:
Literatura opisuje X.

PATIENT DATA:
U pacjenta wystąpiło Y.

SYSTEM INTERPRETATION:
Y jest zgodne z mechanizmem X.
```

Nie należy pisać:

> Badanie dowodzi, że u tego pacjenta przyczyną było X.

jeżeli badanie tego nie wykazuje.

---

# 21. RAG nie powinien potwierdzać hipotezy na siłę

Jeżeli system ma hipotezę:

> Późny spadek wynikał z aktywności.

retrieval powinien szukać zarówno:

- evidence wspierającego,
- jak i informacji o alternatywnych wyjaśnieniach.

System powinien być odporny na confirmation bias.

Przykład:

```text
Hypothesis
   ↓
Search supporting evidence
+
Search contradicting / alternative evidence
   ↓
Evidence set
   ↓
LLM analysis
```

---

# 22. Sprzeczna literatura

Literatura może przedstawiać różne wyniki.

System nie powinien wybierać jednej publikacji tylko dlatego, że pasuje do wcześniejszej hipotezy.

Powinien:

1. wykryć istotną rozbieżność,
2. uwzględnić jakość źródeł,
3. uwzględnić populację,
4. uwzględnić warunki badania,
5. przedstawić użytkownikowi istotną niepewność.

Przykład:

> Badania nie są w pełni zgodne. Część wykazuje X, podczas gdy inne nie wykazały istotnego efektu w podobnych warunkach.

---

# 23. Medical Knowledge vs Patient Pattern

To jedno z najważniejszych rozróżnień.

Jeżeli:

```text
Patient history:
8 / 11 similar events
```

nie oznacza to:

> Medycznie udowodniono, że pływanie powoduje ten efekt.

Analogicznie:

```text
Literature:
mechanism is biologically plausible
```

nie oznacza:

> U tego pacjenta na pewno był to mechanizm.

Dopiero połączenie:

```text
Patient-specific evidence
+
External evidence
+
Current data
```

może stworzyć silniejszą podstawę do analizy.

---

# 24. RAG w analizie posiłku

RAG może być używany również w module Meal.

Przykładowo system może wykryć:

```text
meal:
high fat
moderate carbohydrate

patient history:
late glucose rise after similar meals
```

Knowledge Retrieval może wyszukać odpowiednią literaturę dotyczącą:

- wpływu tłuszczu,
- wpływu białka,
- opóźnionej absorpcji,
- rozłożonej odpowiedzi glikemicznej.

AI otrzymuje:

```text
Meal data
+
Patient history
+
Relevant medical evidence
+
Deterministic calculation
```

i dopiero wtedy przygotowuje odpowiedź.

---

# 25. RAG w analizie aktywności

Analogicznie:

```text
Activity
+
Current glucose
+
Insulin
+
Patient history
+
Exercise literature
```

RAG może dostarczyć wiedzę dotyczącą:

- wpływu wysiłku,
- czasu wystąpienia efektów,
- różnych typów aktywności,
- potencjalnych późniejszych zmian glikemii.

---

# 26. RAG w analizie terapii

RAG może pomóc wyjaśnić:

- mechanizm działania danego parametru,
- znane zależności,
- sposób działania technologii,
- informacje dotyczące określonych systemów,
- wyniki badań dotyczących terapii.

Jednocześnie propozycja zmiany ustawienia powinna opierać się przede wszystkim na:

```text
Patient Data
+
Patient History
+
Pattern Analysis
+
Deterministic Calculations
```

RAG dostarcza kontekstu medycznego, a nie samodzielnie wyznacza ustawienie.

---

# 27. RAG i urządzenia

Knowledge Base powinna obejmować oficjalną dokumentację urządzeń i oprogramowania.

Przykładowo:

```text
Pump
CGM
Loop
Nightscout
Integration
```

Jest to szczególnie istotne, ponieważ AI może potrzebować informacji technicznych, których nie powinno rekonstruować wyłącznie z pamięci modelu.

---

# 28. RAG i rozmowa

Nie każda rozmowa powinna uruchamiać RAG.

Można wyróżnić:

```text
DIRECT DATA QUESTION
→ no RAG

PATIENT HISTORY QUESTION
→ Memory / Events

MEDICAL EXPLANATION
→ RAG

TECHNICAL DOCUMENTATION
→ RAG

THERAPEUTIC ANALYSIS
→ Patient data + calculations + relevant RAG

GENERAL CHAT
→ potentially no RAG
```

Decyzja o użyciu RAG powinna należeć do warstwy orkiestracji AI.

---

# 29. Knowledge Retrieval nie jest pamięcią

Knowledge Base nie powinna być wykorzystywana do przechowywania indywidualnych obserwacji pacjenta.

Nie należy robić:

```text
RAG document:
"Patient often does not finish meals."
```

To należy do:

```text
Patient Memory
```

Knowledge Base przechowuje wiedzę zewnętrzną.

---

# 30. Aktualizacja Knowledge Base

Knowledge Base powinna być możliwa do aktualizacji bez przebudowy aplikacji.

Proces może wyglądać tak:

```text
Source Discovery
      ↓
Document Acquisition
      ↓
Validation
      ↓
Metadata Extraction
      ↓
Chunking
      ↓
Embedding
      ↓
Indexing
      ↓
Quality Check
      ↓
Available for Retrieval
```

---

# 31. Curated Knowledge vs Open Web

W pierwszej wersji podstawowa wiedza powinna pochodzić z kontrolowanego zbioru źródeł.

Nie należy traktować przypadkowych wyników wyszukiwarki internetowej jako równoważnych z:

- wytycznymi,
- publikacjami,
- oficjalną dokumentacją.

W przyszłości system może korzystać z dynamicznego wyszukiwania internetu, ale wyniki powinny być odpowiednio oznaczone.

---

# 32. Dynamic Web Retrieval

Jeżeli system nie posiada odpowiedniej informacji w Knowledge Base, możliwe jest wyszukanie aktualnych źródeł.

W takim przypadku system powinien rozróżnić:

```text
CURATED_KNOWLEDGE
```

od:

```text
LIVE_WEB_EVIDENCE
```

Live Web Evidence powinno być oceniane przed użyciem.

---

# 33. Knowledge Confidence

Confidence dotyczące źródła nie jest tym samym co confidence dotyczące wniosku.

Przykład:

```text
Source quality:
HIGH

Evidence relevance:
HIGH

Patient-specific applicability:
MODERATE

System conclusion:
MODERATE
```

Nie wolno przenosić jakości publikacji automatycznie na pewność wniosku dotyczącego konkretnego pacjenta.

---

# 34. Knowledge Context Package

Do AI powinny trafiać wyłącznie odpowiednie fragmenty wiedzy.

Przykład:

```text
KNOWLEDGE EVIDENCE

Source:
Systematic Review, 2025

Population:
Children with T1D

Topic:
Exercise and delayed glycemic effects

Relevant evidence:
[...]

Applicability:
High

Source quality:
High
```

---

# 35. Auditability

Każda analiza wykorzystująca Knowledge Base powinna móc wskazać:

- jakie źródła wykorzystano,
- jakie fragmenty wykorzystano,
- kiedy je pobrano,
- jaka była wersja dokumentu,
- dlaczego zostały wybrane.

Dzięki temu możliwe jest odtworzenie odpowiedzi.

---

# 36. Knowledge Retrieval i prompt

RAG nie powinien być implementowany jako:

```text
"Here are 20 documents. Answer the user."
```

System powinien najpierw określić:

```text
What is the task?
What knowledge is needed?
What population is relevant?
What evidence type is preferred?
What sources are acceptable?
```

Dopiero potem powinien przeprowadzić retrieval.

---

# 37. Priorytet źródeł

Przy konflikcie źródeł system powinien uwzględniać m.in.:

1. aktualność,
2. jakość metodologiczną,
3. odpowiednią populację,
4. zgodność z pytaniem,
5. typ evidence,
6. oficjalność źródła w przypadku dokumentacji technicznej.

Nie należy tworzyć jednego uniwersalnego rankingu ważności dla wszystkich typów pytań.

Przykład:

- dla aktualnego zalecenia klinicznego preferowane będą wytyczne,
- dla działania konkretnej pompy preferowana będzie oficjalna dokumentacja,
- dla pytania badawczego preferowane mogą być przeglądy systematyczne i odpowiednie badania.

---

# 38. Evaluation

Knowledge Retrieval musi być testowany niezależnie od LLM.

Testy powinny sprawdzać:

### Retrieval relevance

Czy system znajduje właściwe źródła?

### Population filtering

Czy nie wybiera przypadkowo badań dla innej populacji?

### Source quality

Czy preferuje odpowiednie źródła?

### Citation correctness

Czy cytowane źródło rzeczywiście wspiera twierdzenie?

### Contradiction handling

Czy system potrafi zauważyć sprzeczną literaturę?

### Recency

Czy przy pytaniach wymagających aktualnej wiedzy wybierane są aktualne źródła?

### Hallucinated citation prevention

Czy AI nie tworzy źródeł, których nie ma?

---

# 39. Zasada bezpieczeństwa wiedzy

RAG ma zwiększać jakość odpowiedzi, ale nie powinien tworzyć fałszywego wrażenia pewności.

Obecność publikacji w Knowledge Base nie oznacza, że:

- dotyczy konkretnego pacjenta,
- potwierdza konkretną przyczynę,
- pozwala przewidzieć indywidualną reakcję,
- uzasadnia automatyczne działanie.

AI powinno umieć powiedzieć:

> Literatura wspiera możliwość tego mechanizmu, ale dane tego konkretnego pacjenta nie pozwalają stwierdzić, że właśnie on był przyczyną dzisiejszego zdarzenia.

---

# 40. Główna zasada Knowledge Layer

> **RAG ma dostarczać AI właściwą wiedzę we właściwym momencie, a nie zastępować rozumowanie.**

GlucoMind powinien łączyć:

```text
WHAT HAPPENED?
        ↓
Patient Data

WHAT HAS HAPPENED BEFORE?
        ↓
Patient Memory

WHAT PATTERNS DO WE SEE?
        ↓
Pattern Engine

WHAT COULD EXPLAIN IT?
        ↓
Hypotheses

WHAT DOES MEDICAL KNOWLEDGE SAY?
        ↓
RAG / Knowledge Base

WHAT DO THE NUMBERS SAY?
        ↓
Deterministic Calculations

WHAT SHOULD THE USER CONSIDER?
        ↓
AI
```

Najważniejsza zasada:

> **Wiedza z literatury nie zastępuje wiedzy o pacjencie, a wiedza o pacjencie nie zastępuje wiedzy medycznej.**

Największa wartość GlucoMind powstaje wtedy, gdy system potrafi połączyć oba źródła bez mieszania ich ze sobą.
