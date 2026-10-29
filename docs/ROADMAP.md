# ROADMAP.md

# Roadmap GlucoMind

## 1. Cel roadmapy

Roadmapa ma prowadzić do zbudowania produkcyjnego GlucoMind bez próby implementowania całego systemu jednocześnie.

Główna zasada:

> **Budujemy pionowe, działające fragmenty produktu zamiast osobno budować ogromny backend, frontend i warstwę AI.**

Każdy etap powinien dostarczać działającą funkcję użytkową oraz wzmacniać fundamenty kolejnych etapów.

---

# 2. Docelowa kolejność

```text
Foundation
    ↓
Data + Events
    ↓
First Vertical Slice
    ↓
Memory
    ↓
Patterns
    ↓
Calculations
    ↓
Meal
    ↓
Therapy
    ↓
Knowledge / RAG
    ↓
Advanced AI
    ↓
Production Hardening
```

---

# 3. Priorytety

Priorytet:

```text
P0 - konieczne do działania produktu
P1 - bardzo ważne dla jakości
P2 - rozwój produktu
P3 - przyszłość
```

Nie należy rozpoczynać P2/P3 kosztem niedokończonych P0.

---

# 4. Phase 0 - Product Foundation

## Cel

Przygotować repozytorium i zasady, zanim zaczniemy właściwe programowanie.

### Zadania

- [ ] utworzyć repozytorium GlucoMind,
- [ ] dodać dokumentację projektową,
- [ ] dodać `PRODUCT.md`,
- [ ] dodać `MEMORY.md`,
- [ ] dodać `DOMAIN.md`,
- [ ] dodać `KNOWLEDGE.md`,
- [ ] dodać `AI_CONTRACT.md`,
- [ ] dodać `ARCHITECTURE.md`,
- [ ] dodać `SECURITY.md`,
- [ ] dodać `ROADMAP.md`,
- [ ] utworzyć katalog `decisions/`,
- [ ] ustalić conventions dla kodu,
- [ ] skonfigurować CI.

### Definition of Done

Agent kodujący może przeczytać dokumentację i zrozumieć:

- czym jest GlucoMind,
- czego nie wolno mu implementować,
- jak działa architektura,
- jak wygląda model domeny,
- jakie są granice AI.

Na tym etapie nie budujemy jeszcze dużej funkcjonalności.

---

# 5. Phase 1 - Technical Foundation

## Cel

Zbudować minimalny fundament aplikacji.

### Backend

- [ ] aplikacja backendowa,
- [ ] konfiguracja środowisk,
- [ ] PostgreSQL,
- [ ] migracje,
- [ ] podstawowy error handling,
- [ ] logging,
- [ ] health checks.

### Frontend

- [ ] aplikacja Angular,
- [ ] routing,
- [ ] podstawowy layout,
- [ ] API client,
- [ ] obsługa authentication.

### Infrastructure

- [ ] Docker,
- [ ] development environment,
- [ ] test environment,
- [ ] CI,
- [ ] secret management.

### Definition of Done

System uruchamia się lokalnie jednym przewidywalnym procesem.

---

# 6. Phase 2 - Identity + Patient

## Cel

Wprowadzić podstawowy model użytkownika i pacjenta.

### Implementacja

- [ ] User,
- [ ] Patient,
- [ ] CaregiverRelationship,
- [ ] UserPreferences,
- [ ] CustomInstructions,
- [ ] authorization,
- [ ] patient isolation.

### Ważna zasada

Nie implementować:

```text
User = Patient
```

Model powinien od początku wspierać:

```text
User
 ├── Patient A
 └── Patient B
```

---

# 7. Phase 3 - Nightscout Integration

## Cel

Uzyskać wiarygodny dostęp do danych pacjenta.

### Implementacja

- [ ] Nightscout adapter,
- [ ] authentication do Nightscout,
- [ ] sync state,
- [ ] incremental synchronization,
- [ ] idempotency,
- [ ] normalization,
- [ ] source provenance.

### Dane

Minimum:

```text
Glucose
Insulin
Bolus
Basal
Temporary Basal
Treatment
Device Status
Profile / Therapy
```

### Definition of Done

GlucoMind potrafi pobrać dane Nightscout i zapisać je w swoim modelu bez utraty informacji o źródle.

---

# 8. Phase 4 - Domain Events

## Cel

Zbudować wspólny model zdarzeń.

### Implementacja

- [ ] Event,
- [ ] EventContext,
- [ ] Meal,
- [ ] Activity,
- [ ] Sleep,
- [ ] Illness,
- [ ] Insulin Event,
- [ ] Glucose Event.

### Temporal Model

Każde istotne zdarzenie powinno rozróżniać:

```text
occurred_at
recorded_at
ingested_at
```

Nie należy mieszać czasu wydarzenia z czasem zapisu.

---

# 9. Phase 5 - Current State

## Cel

Zbudować wiarygodny snapshot aktualnego stanu.

### Current State

Minimum:

```text
glucose
trend
IOB
recent insulin
active basal
recent meals
recent activity
therapy
data freshness
```

### Definition of Done

System może odpowiedzieć deterministycznie:

> Co wiemy o stanie pacjenta teraz?

bez pytania LLM.

---

# 10. Phase 6 - First Vertical Slice: Hypo

To jest najważniejszy pierwszy etap produktowy.

## Cel

Przejść pełną ścieżkę:

```text
Nightscout
 ↓
Detection
 ↓
Event
 ↓
Trigger
 ↓
Context
 ↓
Question
 ↓
Answer
 ↓
Analysis
 ↓
Recommendation
 ↓
Conversation History
```

---

# 11. Hypo Detection

System wykrywa zdarzenie hipoglikemii według jawnie zdefiniowanej reguły.

Detection powinien być:

- deterministyczny,
- testowalny,
- wersjonowany.

Przykład:

```text
HYPO_DETECTED
```

nie powinien być wynikiem swobodnej interpretacji LLM.

---

# 12. Trigger Engine MVP

Po wykryciu istotnego zdarzenia:

```text
Hypo
 ↓
Trigger
```

Trigger powinien posiadać:

```text
id
type
patient_id
event_id
created_at
status
cooldown
```

---

# 13. Context Question MVP

AI powinno zadać krótkie pytanie, jeżeli brakująca informacja może istotnie zmienić analizę.

Przykłady:

```text
Czy przed spadkiem była aktywność fizyczna?
```

```text
Czy były dodatkowe węglowodany?
```

```text
Czy posiłek został zjedzony w całości?
```

Jeżeli użytkownik odpowie:

```text
Nie wiem
```

system zapisuje:

```text
UNKNOWN
```

i kontynuuje analizę.

---

# 14. Hypo Analysis MVP

Analysis powinno połączyć:

```text
Current State
+
Recent Events
+
Insulin
+
Meal
+
Activity
+
Therapy
+
User Answer
```

AI powinno rozdzielić:

```text
Facts
Unknowns
Calculations
Patterns
Hypotheses
```

---

# 15. First Recommendation

Wynik powinien być konkretny.

Przykładowa struktura:

```text
Co wiemy
Co mogło się wydarzyć
Co przemawia za każdą hipotezą
Czego nie wiemy
Co warto zrobić / sprawdzić
```

Jeżeli zadanie dotyczy dawki i dane są wystarczające, system może przedstawić konkretną propozycję.

Propozycja nie jest automatycznym wykonaniem.

---

# 16. Definition of Done - First Vertical Slice

Slice jest ukończony, gdy:

- [ ] Nightscout dostarcza dane,
- [ ] hypo jest wykrywane,
- [ ] powstaje Event,
- [ ] powstaje Trigger,
- [ ] Context Engine pobiera właściwe dane,
- [ ] AI może zadać pytanie,
- [ ] `UNKNOWN` działa,
- [ ] powstaje Analysis,
- [ ] powstaje Recommendation,
- [ ] rozmowa jest zapisana,
- [ ] wszystkie istotne dane mają provenance,
- [ ] flow można przetestować end-to-end.

To jest pierwszy prawdziwy milestone produktu.

---

# 17. Phase 7 - Memory MVP

## Cel

Sprawić, aby system pamiętał ważne informacje między rozmowami.

### Implementacja

- [ ] Candidate Memory,
- [ ] Memory Extraction,
- [ ] Memory Policy,
- [ ] Episodic Memory,
- [ ] Context Memory,
- [ ] Stable Profile,
- [ ] provenance,
- [ ] confidence,
- [ ] temporal scope,
- [ ] conflict handling,
- [ ] retrieval.

### Najważniejsze

Nie implementować:

```text
one giant memory blob
```

---

# 18. Memory Evaluation

Przygotować scenariusze:

```text
informacja jednorazowa
informacja powtarzająca się
sprzeczna informacja
UNKNOWN
zmiana terapii
nieaktualna informacja
```

System powinien poprawnie rozróżniać:

```text
candidate
active
expired
contradicted
rejected
```

---

# 19. Phase 8 - Pattern Engine

## Cel

Przejść z:

```text
What happened?
```

do:

```text
What repeatedly happens?
```

### Implementacja

- [ ] Similar Event retrieval,
- [ ] comparable event definition,
- [ ] grouping,
- [ ] statistical summary,
- [ ] pattern detection,
- [ ] evidence,
- [ ] contradiction tracking,
- [ ] pattern versioning.

---

# 20. Pattern MVP

Pierwszy konkretny przypadek:

```text
similar activity
→ glucose response
```

Przykład wyniku:

```text
8 of 11 comparable events
showed a later glucose decline.
```

System powinien znać dokładne event IDs stojące za takim stwierdzeniem.

---

# 21. Phase 9 - Deterministic Calculation Engine

## Cel

Przenieść krytyczne obliczenia poza LLM.

### Implementacja

- [ ] IOB calculation,
- [ ] correction calculation,
- [ ] meal calculation,
- [ ] dose calculation,
- [ ] range calculation,
- [ ] therapy calculations,
- [ ] algorithm versioning,
- [ ] input snapshot,
- [ ] calculation audit.

---

# 22. Calculation MVP

Każdy wynik:

```text
Calculation
```

musi mieć:

```text
algorithm_version
inputs
result
timestamp
```

LLM nie powinien samodzielnie zastępować Calculation Engine.

---

# 23. Phase 10 - Meal

## Cel

Zbudować konkretny moduł analizy posiłku.

Input:

```text
text
+
photo
+
current state
```

System może oszacować:

```text
food
portion
carbs
fat
protein
```

oraz wykorzystać:

```text
IOB
glucose
trend
therapy
recent insulin
activity
sleep
illness
similar meals
```

---

# 24. Meal MVP

Flow:

```text
Meal Input
 ↓
Food / Carb Estimation
 ↓
Historical Context
 ↓
Calculation Engine
 ↓
Risk / Uncertainty
 ↓
Recommendation
```

Użytkownik powinien widzieć założenia.

Przykład:

```text
Estimated carbs: 65-75 g
Main uncertainty: portion size
```

---

# 25. Phase 11 - Therapy

## Cel

Umożliwić analizę ustawień terapii.

### Implementacja

- [ ] Therapy,
- [ ] TherapyProfile,
- [ ] TherapyParameter,
- [ ] historical profiles,
- [ ] effective dates,
- [ ] therapy analysis,
- [ ] evidence,
- [ ] proposal flow.

AI może powiedzieć:

```text
Warto rozważyć analizę ICR wieczorem.
```

i przedstawić:

```text
Evidence
+
Calculations
+
Historical events
+
Uncertainty
```

Nie zmienia ustawień automatycznie.

---

# 26. Phase 12 - Knowledge Base

## Cel

Dodać kontrolowaną zewnętrzną wiedzę.

### Sources

- [ ] ISPAD,
- [ ] ADA,
- [ ] systematic reviews,
- [ ] meta-analyses,
- [ ] scientific papers,
- [ ] device documentation,
- [ ] Loop documentation.

---

# 27. Knowledge Ingestion

Flow:

```text
Source
 ↓
Document
 ↓
Metadata
 ↓
Chunking
 ↓
Embedding
 ↓
Index
```

Każdy dokument powinien mieć:

```text
source
title
authors
date
population
topic
evidence_type
version
identifier
```

---

# 28. Phase 13 - RAG

## Cel

RAG ma odpowiadać na pytanie:

> Co mówi zewnętrzna wiedza?

Nie:

> Co wydarzyło się temu pacjentowi?

### Retrieval

```text
Query
 ↓
Metadata Filter
 ↓
Keyword Search
 ↓
Semantic Search
 ↓
Merge
 ↓
Re-rank
 ↓
Evidence
```

---

# 29. RAG + Patient Evidence

Dopiero po zbudowaniu obu warstw:

```text
Patient Pattern
+
Medical Evidence
```

AI może budować lepszą hipotezę.

Przykład:

```text
Patient data:
Repeated late decline after swimming.

Medical evidence:
Exercise can affect glucose for hours after activity.

AI:
This mechanism is consistent with the observed pattern,
but other explanations remain possible.
```

---

# 30. Phase 14 - Hypothesis Engine

## Cel

Formalnie zarządzać alternatywnymi wyjaśnieniami.

Przykład:

```text
H1: activity-related delayed effect
H2: excessive insulin before activity
H3: underestimated meal
H4: unrelated variability
```

Każda hipoteza:

```text
supporting evidence
contradicting evidence
missing evidence
status
confidence
```

---

# 31. Phase 15 - Advanced Context Engine

## Cel

Zbudować system, który dynamicznie dobiera kontekst.

Zamiast:

```text
send everything
```

system powinien:

```text
understand task
→ retrieve relevant context
→ rank
→ compress
→ package
```

---

# 32. Context Ranking

Ranking może uwzględniać:

```text
relevance
temporal proximity
patient match
event similarity
confidence
recurrence
decision impact
source reliability
```

---

# 33. Phase 16 - Adaptive Questioning

## Cel

AI ma zadawać pytania, które rzeczywiście zmieniają analizę.

Pytanie powinno być oceniane przez:

```text
expected information gain
```

Jeżeli odpowiedź nie zmieni decyzji ani hipotezy, pytanie nie powinno być zadawane.

---

# 34. UNKNOWN jako sygnał

Jeżeli użytkownik wielokrotnie odpowiada:

```text
UNKNOWN
```

system powinien nauczyć się:

- które pytania są mało użyteczne,
- które informacje są zwykle niedostępne,
- kiedy nie warto pytać,
- jakie alternatywne dane można wykorzystać.

Nie należy traktować `UNKNOWN` jako porażki.

---

# 35. Phase 17 - Proactive AI

Po uruchomieniu stabilnego Trigger Engine można rozszerzyć triggery.

Przykładowo:

```text
Repeated Hypo
Unexpected Hyper
Unexpected Meal Response
Activity Pattern
Overnight Pattern
Therapy Pattern
Pattern Change
```

Każdy trigger musi mieć:

```text
reason
evidence
cooldown
priority
```

---

# 36. Phase 18 - Chat as Second Brain

Chat przestaje być zwykłym chatbotem.

Powinien rozumieć:

```text
current state
+
patient history
+
memory
+
patterns
+
hypotheses
+
knowledge
+
calculations
```

Użytkownik może pytać:

```text
Dlaczego wczoraj po basenie znowu spadła glikemia?
```

System powinien móc przejść przez:

```text
events
→ similar events
→ pattern
→ hypothesis
→ medical evidence
→ explanation
```

---

# 37. Phase 19 - Explainability

Każda ważniejsza analiza powinna umożliwiać przejście do:

```text
Why?
```

Użytkownik może zobaczyć:

- jakie dane wykorzystano,
- jakie wydarzenia porównano,
- jaki pattern wykryto,
- jakie obliczenie wykonano,
- jakie źródła wiedzy wykorzystano,
- czego system nie wie.

---

# 38. Phase 20 - Production Hardening

Dopiero po działającym produkcie:

- [ ] security review,
- [ ] performance testing,
- [ ] load testing,
- [ ] backup verification,
- [ ] disaster recovery,
- [ ] observability,
- [ ] cost controls,
- [ ] AI evaluation,
- [ ] RAG evaluation,
- [ ] prompt injection testing,
- [ ] authorization testing,
- [ ] patient isolation testing.

---

# 39. Evaluation Dataset

Od początku należy tworzyć zestaw scenariuszy testowych.

Minimum:

```text
Hypo after swimming
Hypo after unknown extra carbs
Unexpected hyper after meal
Meal not fully eaten
Late high-fat meal
Poor sleep
Illness
Conflicting context
UNKNOWN answer
Insufficient data
Multiple plausible explanations
Therapy change
Stale Nightscout data
Missing CGM data
Conflicting source data
```

Każdy scenariusz powinien mieć:

```text
input
expected relevant context
expected calculations
expected constraints
acceptable answer characteristics
```

Nie trzeba definiować jednego "idealnego tekstu odpowiedzi".

---

# 40. AI Evaluation

Ocena AI powinna sprawdzać:

### Context

Czy model dostał właściwe dane?

### Reasoning quality

Czy poprawnie połączył dane?

### Uncertainty

Czy odróżnił UNKNOWN od NO?

### Evidence

Czy odróżnił patient evidence od medical evidence?

### Calculations

Czy użył Calculation Engine?

### Specificity

Czy odpowiedź jest wystarczająco konkretna?

### Safety

Czy nie przekroczył AI Contract?

### Hallucination

Czy nie wymyślił faktów lub źródeł?

---

# 41. Co celowo odłożyć

Na początku nie budować:

```text
Autonomous insulin delivery
Custom ML models for everything
Separate vector database
Complex microservices
Real-time distributed event bus
Full mobile apps
Complex multi-agent architecture
Automatic therapy changes
Enterprise-scale infrastructure
```

Najpierw należy potwierdzić wartość podstawowego produktu.

---

# 42. Architektura wdrożeniowa MVP

Pierwsza wersja może być stosunkowo prosta:

```text
Frontend
    ↓
Backend
    ↓
PostgreSQL + pgvector
    ↓
Nightscout
    ↓
LLM Provider
```

oraz worker/background jobs:

```text
Scheduler / Worker
    ↓
Sync
    ↓
Detection
    ↓
Pattern / Memory jobs
```

Nie ma potrzeby rozpoczynania od kilkunastu mikroserwisów.

---

# 43. Modularny monolit jako punkt startowy

Pierwsza wersja backendu powinna preferować modularny monolit.

Logiczne moduły:

```text
Identity
Patients
Sources
Events
Therapy
Memory
Patterns
Hypotheses
Calculations
Knowledge
AI
Conversations
Triggers
Audit
```

Moduły mogą mieć wyraźne granice wewnątrz jednego deploymentu.

Dopiero rzeczywista potrzeba powinna prowadzić do wydzielania osobnych usług.

---

# 44. Vertical Slice Strategy

Każda większa funkcja powinna przejść przez:

```text
Domain
→ Backend
→ Data
→ Analysis
→ AI
→ API
→ Frontend
→ Evaluation
```

Nie:

```text
3 miesiące backend
→ 2 miesiące frontend
→ AI na końcu
```

---

# 45. Definition of Done dla funkcji

Funkcja nie jest ukończona tylko dlatego, że działa API.

Powinna mieć:

- domain model,
- backend,
- persistence,
- validation,
- authorization,
- UI,
- AI integration jeżeli potrzebna,
- error handling,
- audit,
- tests,
- evaluation scenario.

Zakres może być mniejszy, ale cały flow powinien działać.

---

# 46. Development Workflow z Agentami

Agenci kodujący powinni pracować według kolejności:

```text
Read docs
 ↓
Understand current architecture
 ↓
Inspect repository
 ↓
Identify affected modules
 ↓
Propose implementation
 ↓
Implement
 ↓
Test
 ↓
Review against docs
```

Pierwszy krok zadania powinien być analizą, a nie natychmiastowym pisaniem kodu.

---

# 47. Agent Guardrails

Agent powinien traktować:

```text
PRODUCT.md
MEMORY.md
DOMAIN.md
KNOWLEDGE.md
AI_CONTRACT.md
ARCHITECTURE.md
SECURITY.md
ROADMAP.md
```

jako źródło wymagań projektu.

Jeżeli nowa implementacja jest sprzeczna z dokumentacją:

```text
stop
→ identify conflict
→ propose ADR / documentation change
→ then implement
```

Nie należy cicho obchodzić wymagań.

---

# 48. ADR

Decyzje architektoniczne powinny trafiać do:

```text
docs/decisions/
```

Przykładowo:

```text
ADR-001-modular-monolith.md
ADR-002-postgres-pgvector.md
ADR-003-deterministic-calculations.md
ADR-004-memory-provenance.md
ADR-005-ai-tool-boundaries.md
```

ADR powinien opisywać:

```text
Context
Decision
Alternatives
Consequences
```

---

# 49. Milestones

## M1 - Data Foundation

```text
User
Patient
Nightscout
Events
Current State
```

## M2 - First AI Flow

```text
Hypo
→ Trigger
→ Context
→ Analysis
→ Recommendation
```

## M3 - Memory

```text
Conversation
→ Memory
→ Retrieval
```

## M4 - Patterns

```text
Events
→ Similar Events
→ Pattern
```

## M5 - Calculations

```text
Data
→ Deterministic Calculation
```

## M6 - Meal

```text
Meal
→ Estimate
→ Calculation
→ Recommendation
```

## M7 - Therapy

```text
Therapy
→ Analysis
→ Proposal
```

## M8 - Knowledge

```text
Sources
→ RAG
→ Evidence
```

## M9 - Advanced AI

```text
Patterns
+
Memory
+
Knowledge
+
Calculations
→ Second Brain
```

---

# 50. Najważniejszy milestone

Najważniejszym momentem nie będzie uruchomienie RAG.

Będzie nim sytuacja, w której GlucoMind potrafi powiedzieć:

> **"To zdarzyło się już wcześniej. Znalazłem podobne przypadki, pamiętam istotny kontekst, widzę wzorzec, sprawdziłem możliwe wyjaśnienia i mogę pokazać, na czym opieram tę propozycję."**

To jest moment, w którym system zaczyna zachowywać się jak drugi mózg zamiast jak zwykły chatbot.

---

# 51. Roadmapa skrócona

```text
NOW
 │
 ├─ Documentation
 │
 ├─ Foundation
 │
 ├─ User / Patient
 │
 ├─ Nightscout
 │
 ├─ Events
 │
 ├─ Current State
 │
 ├─ Hypo Vertical Slice
 │
 ├─ Memory
 │
 ├─ Patterns
 │
 ├─ Calculations
 │
 ├─ Meal
 │
 ├─ Therapy
 │
 ├─ Knowledge / RAG
 │
 ├─ Hypotheses
 │
 ├─ Adaptive Questions
 │
 ├─ Proactive AI
 │
 └─ Production Hardening
```

---

# 52. Zasada końcowa

Roadmapa nie jest listą funkcji do odhaczenia.

Każdy kolejny etap powinien odpowiadać na pytanie:

```text
Czy GlucoMind dzięki temu
lepiej rozumie pacjenta,
lepiej rozumie historię,
lepiej rozumie kontekst,
lepiej analizuje dane,
czy lepiej pomaga użytkownikowi podejmować decyzje?
```

Jeżeli odpowiedź brzmi "nie", funkcja nie powinna automatycznie trafiać do roadmapy.

Docelowy kierunek:

```text
Data
 ↓
Memory
 ↓
Patterns
 ↓
Knowledge
 ↓
Calculations
 ↓
Reasoning
 ↓
Useful Recommendation
 ↓
Human Decision
```

**GlucoMind ma być systemem, który buduje kontekst i pamięć wokół danych, a AI ma ten kontekst rozumieć i wykorzystywać.**
