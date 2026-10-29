# ARCHITECTURE.md

> **Historyczne notatki projektowe (GlucoMind), nie opisują obecnego modelu bezpieczeństwa — aktualny: [docs/device-auth-api.md](../device-auth-api.md).**

# Architektura GlucoMind

## 1. Cel

Architektura GlucoMind ma umożliwić zbudowanie systemu, który łączy:

- dane bieżące pacjenta,
- historię,
- pamięć długoterminową,
- wykrywanie wzorców,
- hipotezy,
- deterministyczne obliczenia,
- wiedzę medyczną,
- RAG,
- rozmowę z użytkownikiem,
- proaktywne triggery.

Najważniejsza zasada:

> **LLM nie jest systemem. LLM jest jednym z komponentów systemu.**

GlucoMind powinien być zaprojektowany tak, aby jakość produktu nie zależała wyłącznie od możliwości pojedynczego modelu językowego.

---

# 2. Architektura wysokiego poziomu

Docelowy model:

```text
                    ┌──────────────────────┐
                    │      Frontend        │
                    │       GlucoMind      │
                    └──────────┬───────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │     API / Backend    │
                    └──────────┬───────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
              ▼                ▼                ▼
       Conversation      Context Engine    Trigger Engine
          Service             │
              │               │
              └───────┬───────┘
                      ▼
              ┌───────────────────┐
              │    AI Gateway     │
              └─────────┬─────────┘
                        │
                        ▼
                      LLM
                        │
              ┌─────────┴──────────┐
              │                    │
              ▼                    ▼
       Tool / Function         Response
         Execution
```

Warstwa danych:

```text
Nightscout / CGM / Pump
          │
          ▼
   Source Data Layer
          │
          ├───────────────┐
          ▼               ▼
    Current State       Events
          │               │
          └───────┬───────┘
                  ▼
           Analysis Layer
                  │
        ┌─────────┼─────────┐
        ▼         ▼         ▼
     Memory    Patterns  Calculations
        │         │         │
        └─────────┼─────────┘
                  ▼
            Context Engine
                  │
                  ▼
            Context Package
                  │
                  ▼
               AI Gateway
                  │
                  ▼
                 LLM
```

Warstwa wiedzy:

```text
Scientific Papers
Clinical Guidelines
Device Documentation
Software Documentation
        │
        ▼
   Knowledge Ingestion
        │
        ▼
     Knowledge Base
        │
        ▼
       RAG
        │
        ▼
Relevant Evidence
```

---

# 3. Główne zasady architektoniczne

## 3.1. Separation of concerns

Każda warstwa powinna mieć jasno określoną odpowiedzialność.

LLM nie powinien:

- być bazą danych,
- wykonywać krytycznych obliczeń,
- samodzielnie decydować o pamięci,
- być jedynym źródłem historii,
- być jedynym źródłem wiedzy medycznej,
- bezpośrednio wykonywać działań terapeutycznych.

---

## 3.2. Source of Truth

### Nightscout

Źródło prawdy dla danych, które dostarcza:

- glikemia,
- insulin,
- bolusy,
- basal,
- temporary basal,
- posiłki,
- device status,
- inne dane źródłowe.

### GlucoMind Database

Źródło prawdy dla:

- pamięci,
- kontekstu,
- analiz,
- wzorców,
- hipotez,
- rozmów,
- rekomendacji,
- obliczeń,
- użytkowników,
- konfiguracji.

### Knowledge Base

Źródło prawdy dla:

- przechowywanych dokumentów,
- metadata,
- wersji,
- fragmentów wiedzy,
- źródeł RAG.

---

# 4. Warstwa danych

## 4.1. Nightscout

Nightscout pozostaje zewnętrznym systemem źródłowym.

GlucoMind powinien pobierać dane przez kontrolowany adapter.

```text
Nightscout
    ↓
Nightscout Adapter
    ↓
Normalized Domain Data
```

Logika domenowa nie powinna być bezpośrednio uzależniona od formatu API Nightscout.

---

## 4.2. Source Adapter

Każde źródło zewnętrzne powinno mieć adapter.

Przykładowo:

```text
NightscoutAdapter
CGMAdapter
PumpAdapter
ActivityAdapter
SleepAdapter
```

Adapter odpowiada za:

- komunikację ze źródłem,
- autoryzację,
- mapowanie danych,
- normalizację,
- obsługę błędów,
- synchronizację.

---

# 5. Synchronizacja danych

Synchronizacja powinna być:

- przyrostowa,
- idempotentna,
- odporna na ponowienie,
- możliwa do wznowienia.

System powinien pamiętać:

```text
last_successful_sync
source_cursor
source_version
```

Nie należy pobierać całej historii przy każdym zapytaniu.

---

# 6. Normalizacja

Dane z różnych źródeł powinny być normalizowane do wspólnego modelu domenowego.

Przykład:

```text
External source
      ↓
Adapter
      ↓
Normalizer
      ↓
Domain Event
```

Dzięki temu Pattern Engine i Context Engine nie muszą znać szczegółów każdego źródła.

---

# 7. Event Store

Event Store przechowuje istotne zdarzenia domenowe.

Przykładowo:

```text
Meal
Bolus
Glucose Event
Activity
Sleep
Illness
Hypo
Hyper
Device Event
```

Event powinien mieć:

```text
id
patient_id
type
occurred_at
recorded_at
source
source_id
payload
```

---

# 8. Current State Engine

Current State Engine tworzy aktualny snapshot potrzebny do analizy.

Przykładowo:

```text
CurrentState
- glucose
- trend
- IOB
- recent insulin
- active therapy
- active temp basal
- recent meal
- recent activity
```

Current State może być cache'owany.

Nie jest jednak niezależnym źródłem prawdy.

---

# 9. Analysis Layer

Analysis Layer odpowiada za przetwarzanie danych pacjenta.

Główne komponenty:

```text
Event Analyzer
Pattern Engine
Hypothesis Engine
Calculation Engine
Memory Engine
```

Komponenty powinny być możliwie niezależne od LLM.

---

# 10. Pattern Engine

Pattern Engine wyszukuje powtarzalne zależności.

Input:

```text
Historical Events
```

Output:

```text
Patterns
```

Pattern Engine powinien:

- definiować porównywalne zdarzenia,
- grupować zdarzenia,
- obliczać statystyki,
- aktualizować istniejące wzorce,
- wykrywać nowe wzorce,
- rejestrować evidence.

LLM może pomagać w opisie wzorca, ale nie powinien być jedynym mechanizmem jego wykrywania.

---

# 11. Hypothesis Engine

Hypothesis Engine zarządza hipotezami.

Może:

- tworzyć kandydatów,
- łączyć hipotezy z evidence,
- dodawać evidence wspierające,
- dodawać evidence przeczące,
- aktualizować confidence,
- wygaszać hipotezy.

LLM może generować kandydatów, ale stan hipotezy powinien być kontrolowany przez system.

---

# 12. Calculation Engine

Calculation Engine wykonuje deterministyczne obliczenia.

Powinien być:

- testowalny,
- deterministyczny,
- wersjonowany,
- niezależny od LLM.

Przykładowe moduły:

```text
IOBCalculator
DoseCalculator
CorrectionCalculator
CarbCalculator
TherapyCalculator
```

Każde obliczenie powinno być możliwe do odtworzenia.

---

# 13. Memory Engine

Memory Engine odpowiada za:

- ekstrakcję kandydatów,
- Memory Policy,
- zapis,
- aktualizację,
- wygaszanie,
- conflict handling,
- provenance,
- retrieval.

Przepływ:

```text
Conversation / Events
        ↓
Memory Extraction
        ↓
Candidate Memories
        ↓
Memory Policy
        ↓
Memory Store
```

---

# 14. Context Engine

Context Engine jest jednym z najważniejszych komponentów systemu.

Jego zadaniem jest odpowiedzieć:

> **Jakie informacje AI musi teraz zobaczyć, żeby dobrze wykonać to konkretne zadanie?**

Nie powinien przekazywać całej historii.

---

# 15. Context Retrieval

Context Engine może pobierać:

```text
Current State
Relevant Events
Similar Events
Memory
Patterns
Hypotheses
Calculations
User Profile
Therapy
Knowledge Evidence
Conversation Context
```

Następnie powinien:

- filtrować,
- rankingować,
- ograniczać,
- porządkować.

---

# 16. Context Package

Wynikiem Context Engine jest:

```text
ContextPackage
```

Przykładowa struktura:

```text
ContextPackage
├── task
├── current_state
├── current_event
├── recent_events
├── similar_events
├── memories
├── patterns
├── hypotheses
├── calculations
├── knowledge_evidence
├── user_profile
├── therapy
└── conversation_context
```

Context Package powinien być możliwie deterministyczny.

---

# 17. AI Gateway

AI Gateway jest jedynym komponentem odpowiedzialnym za komunikację z modelami AI.

Odpowiada za:

- wybór modelu,
- budowanie promptu,
- przekazanie Context Package,
- tool calling,
- obsługę odpowiedzi,
- retry,
- timeout,
- logging,
- versioning promptów,
- koszt,
- telemetry.

Pozostałe komponenty nie powinny bezpośrednio wywoływać LLM.

---

# 18. AI Gateway nie jest Context Engine

To rozróżnienie jest ważne.

### Context Engine

Decyduje:

> Co AI powinno wiedzieć?

### AI Gateway

Decyduje:

> Jak przekazać to AI?

### LLM

Decyduje:

> Jak wykorzystać przekazany kontekst do wykonania zadania?

---

# 19. AI Tasks

AI Gateway powinien obsługiwać różne typy zadań.

Przykłady:

```text
CHAT
EVENT_ANALYSIS
MEAL_ANALYSIS
THERAPY_ANALYSIS
CONTEXT_QUESTION
MEMORY_EXTRACTION
HYPOTHESIS_GENERATION
PATTERN_EXPLANATION
KNOWLEDGE_SUMMARY
```

Każdy task może mieć własny:

- prompt,
- wymagany context,
- output schema,
- model,
- tool permissions.

---

# 20. Structured Outputs

Tam, gdzie wynik jest używany przez system, AI powinno zwracać structured output.

Przykład:

```text
{
  type: "memory_candidate",
  memory_type: "CONTEXT",
  content: "...",
  evidence: [...],
  confidence: ...
}
```

Nie należy parsować krytycznej logiki biznesowej z dowolnego tekstu LLM.

---

# 21. Tool Calling

LLM powinien korzystać z narzędzi zamiast otrzymywać wszystkie dane z góry.

Przykładowe narzędzia:

```text
get_current_state
get_recent_events
find_similar_events
get_patterns
get_memories
get_therapy
calculate_dose
calculate_carbs
search_knowledge
get_source
```

Tool access powinien być ograniczony zależnie od tasku.

---

# 22. Nie pozwalać LLM na niekontrolowany dostęp do danych

LLM nie powinien mieć:

```text
SELECT *
FROM database
```

ani dostępu do całej bazy.

Powinien korzystać z kontrolowanych narzędzi.

Każde narzędzie powinno:

- mieć określone wejście,
- mieć określone wyjście,
- ograniczać zakres danych,
- być audytowalne.

---

# 23. Knowledge Layer

Knowledge Layer odpowiada za zewnętrzną wiedzę.

Przepływ:

```text
Sources
 ↓
Ingestion
 ↓
Documents
 ↓
Chunks
 ↓
Embeddings
 ↓
Index
 ↓
Retrieval
 ↓
Evidence
```

Knowledge Layer powinien być niezależny od pamięci pacjenta.

---

# 24. RAG Architecture

RAG powinien składać się z:

```text
Query Builder
      ↓
Metadata Filtering
      ↓
Keyword Search
      ↓
Semantic Search
      ↓
Candidate Merge
      ↓
Re-ranking
      ↓
Evidence Selection
```

Nie należy ograniczać RAG do samego similarity search.

---

# 25. PostgreSQL i pgvector

Pierwsza wersja może używać:

```text
PostgreSQL
+
pgvector
```

PostgreSQL może przechowywać:

- dane domenowe,
- pamięć,
- analizy,
- wzorce,
- hipotezy,
- dokumenty,
- chunks,
- embeddings,
- metadata.

Nie ma potrzeby wprowadzania osobnej vector database, dopóki skala produktu tego nie uzasadni.

---

# 26. Cache

Cache może być stosowany dla:

- Current State,
- często używanych danych Nightscout,
- retrieval results,
- embeddings,
- wyników kosztownych analiz.

Cache nie może być źródłem prawdy.

---

# 27. Trigger Engine

Trigger Engine odpowiada za proaktywne zachowanie systemu.

Przykładowy przepływ:

```text
New data
   ↓
Event Detection
   ↓
Trigger Rules
   ↓
Trigger
   ↓
Context Retrieval
   ↓
Analysis
   ↓
Potential Conversation
```

Trigger Engine nie powinien generować bezsensownych powiadomień.

---

# 28. Trigger Types

Przykładowe:

```text
HYPO_DETECTED
REPEATED_HYPO
UNUSUAL_HYPER
UNEXPECTED_RESPONSE
PATTERN_CHANGE
MISSING_CONTEXT
THERAPY_PATTERN
```

Każdy trigger powinien mieć:

- warunek,
- priorytet,
- cooldown,
- status,
- powiązany task.

---

# 29. Conversation Service

Conversation Service odpowiada za:

- rozmowy,
- wiadomości,
- historię,
- kontekst rozmowy,
- powiązania z Event/Analysis/Recommendation.

Nie powinien samodzielnie implementować logiki pamięci.

---

# 30. Recommendation Layer

Recommendation Layer tworzy wynik przeznaczony dla użytkownika.

Może korzystać z:

```text
Analysis
+
Calculations
+
Patterns
+
Hypotheses
+
Knowledge Evidence
+
User Preferences
```

Recommendation nie wykonuje działania.

---

# 31. Recommendation vs Action

Architektura powinna rozdzielać:

```text
Recommendation
```

od:

```text
Action
```

W pierwszej wersji:

```text
Recommendation
    ↓
User
    ↓
Manual action
```

System nie powinien posiadać automatycznej ścieżki:

```text
LLM
 ↓
Insulin
```

---

# 32. API

API powinno być zorganizowane wokół domeny, nie wokół promptów.

Przykładowo:

```text
/users
/patients
/therapy
/events
/conversations
/analyses
/recommendations
/patterns
/hypotheses
/memories
/knowledge
```

Nie:

```text
/ask-ai
```

jako jedyny interfejs całego systemu.

---

# 33. Database

PostgreSQL jest preferowaną bazą pierwszej wersji.

Logiczne obszary:

```text
identity
patients
therapy
events
context
memory
patterns
hypotheses
analysis
calculations
recommendations
conversations
knowledge
audit
```

Szczegółowy schemat tabel powinien powstać dopiero po ustabilizowaniu modelu domeny.

---

# 34. Audit Layer

System powinien posiadać audit trail dla istotnych operacji.

Przykładowo:

```text
Calculation created
Analysis created
Recommendation generated
Memory promoted
Pattern updated
Hypothesis changed
Knowledge source used
Therapy proposal generated
```

Audit powinien umożliwić rekonstrukcję procesu bez przechowywania prywatnego chain-of-thought LLM.

---

# 35. Observability

System powinien zbierać telemetry dotyczące:

- czasu odpowiedzi,
- kosztu modeli,
- tokenów,
- tool calls,
- retrieval quality,
- błędów,
- czasu synchronizacji,
- triggerów,
- skuteczności analiz.

Nie należy rejestrować więcej danych wrażliwych niż jest potrzebne.

---

# 36. Error Handling

Każda warstwa powinna obsługiwać błędy niezależnie.

Przykłady:

```text
Nightscout unavailable
RAG unavailable
LLM timeout
Calculation error
Database error
Invalid source data
```

Awaria jednej warstwy nie powinna powodować niekontrolowanego zachowania całego systemu.

---

# 37. Graceful degradation

System powinien umieć działać przy częściowej niedostępności.

Przykład:

Jeżeli RAG jest niedostępny:

```text
Patient data
+
Patient history
+
Calculations
```

nadal mogą być użyte.

System powinien jednak wiedzieć, że:

```text
External knowledge unavailable
```

i nie może udawać, że została wykorzystana.

---

# 38. Security boundaries

Dostęp powinien być ograniczony na poziomie:

```text
User
→ Patient
→ Data
→ Tool
→ AI Task
```

LLM nie powinien mieć większych uprawnień niż użytkownik i system wymaga.

---

# 39. Secrets

Sekrety:

- API keys,
- Nightscout tokens,
- database credentials,
- model provider credentials

nie mogą znajdować się:

- w promptach,
- w kodzie frontendowym,
- w pamięci,
- w logach.

---

# 40. Multi-user readiness

Od początku należy rozdzielać:

```text
User
Patient
Relationship
```

Nie należy zakładać:

```text
one account = one patient
```

W przyszłości możliwe powinno być:

```text
User A
 ├── Patient 1
 └── Patient 2

User B
 └── Patient 1
```

z odpowiednimi uprawnieniami.

---

# 41. Multi-device / Multi-source readiness

Architektura powinna umożliwiać wiele źródeł danych.

Przykład:

```text
Nightscout
CGM
Pump
Activity tracker
Manual input
```

Nie należy projektować domeny bezpośrednio pod jeden konkretny model urządzenia.

---

# 42. Frontend

Frontend powinien być klientem domenowego API.

Główne obszary:

```text
Chat
Meal
Therapy
Patterns
History
Patient
Settings
```

Frontend nie powinien zawierać krytycznych obliczeń terapeutycznych.

---

# 43. Chat UX

Chat powinien umożliwiać:

- rozmowę,
- wyświetlanie źródeł,
- przejście do analizy,
- przejście do historii,
- przejście do rekomendacji,
- pokazanie niepewności,
- pokazanie użytych danych.

---

# 44. Explainability UX

Przy rekomendacji użytkownik powinien móc zobaczyć:

```text
Why?
```

i otrzymać:

```text
Data used
History
Patterns
Calculations
External evidence
Uncertainties
```

Nie należy pokazywać użytkownikowi wewnętrznego chain-of-thought LLM.

Należy pokazywać **źródła i uzasadnienie oparte na danych**.

---

# 45. Wersjonowanie

Wersjonowane powinny być co najmniej:

- schema domeny,
- Calculation Engine,
- Pattern Engine,
- Memory Policy,
- prompts,
- AI task definitions,
- Knowledge documents,
- Knowledge ingestion,
- retrieval configuration.

Dzięki temu można odtworzyć, dlaczego system wygenerował konkretny wynik.

---

# 46. Testowanie architektury

Testy powinny być podzielone na warstwy.

### Unit

- calculations,
- parsers,
- domain logic,
- memory policy,
- pattern calculations.

### Integration

- Nightscout adapter,
- database,
- RAG,
- AI Gateway,
- tool calling.

### End-to-end

Przykładowe scenariusze:

```text
Hypo
→ Context
→ Question
→ UNKNOWN
→ Analysis
→ Recommendation
```

```text
Meal
→ Carb estimate
→ Calculation
→ Historical comparison
→ Proposal
```

```text
Repeated pattern
→ Pattern detection
→ Medical evidence
→ Hypothesis
→ Explanation
```

---

# 47. Evaluation AI

LLM powinien być oceniany osobno.

Evaluation powinno sprawdzać:

- poprawność wykorzystania kontekstu,
- brak halucynacji,
- właściwe rozróżnienie UNKNOWN,
- konkretność odpowiedzi,
- jakość propozycji,
- poprawność cytowania,
- wykorzystanie historii,
- unikanie confirmation bias,
- poprawne korzystanie z tools,
- przestrzeganie AI Contract.

---

# 48. Nie budować całego systemu od razu

Implementacja powinna być prowadzona przez vertical slices.

Pierwszy slice:

```text
Nightscout
    ↓
Hypo Detection
    ↓
Event
    ↓
Trigger
    ↓
Context Question
    ↓
User Answer
    ↓
Memory
    ↓
Analysis
    ↓
Recommendation
    ↓
Conversation History
```

Dopiero po działającym end-to-end flow należy rozszerzać kolejne obszary.

---

# 49. Proponowana kolejność implementacji

## Phase 1 - Foundation

- repository,
- backend,
- PostgreSQL,
- authentication,
- Patient/User,
- Nightscout adapter,
- basic event model.

## Phase 2 - First vertical slice

- hypo detection,
- trigger,
- context question,
- UNKNOWN,
- event analysis,
- conversation.

## Phase 3 - Memory

- memory extraction,
- Memory Policy,
- episodic memory,
- context memory,
- provenance,
- retrieval.

## Phase 4 - Pattern Engine

- similarity,
- historical comparison,
- pattern detection,
- pattern evidence.

## Phase 5 - Calculation Engine

- deterministic calculations,
- versioning,
- auditability.

## Phase 6 - Meal

- meal input,
- photo,
- carb estimation,
- dose calculation,
- historical comparison,
- proposal.

## Phase 7 - Therapy

- therapy profiles,
- historical settings,
- analysis,
- proposals.

## Phase 8 - Knowledge / RAG

- Knowledge Base,
- ingestion,
- embeddings,
- hybrid retrieval,
- citations.

## Phase 9 - Advanced AI

- adaptive questioning,
- hypothesis engine,
- improved context retrieval,
- proactive behavior.

---

# 50. Nie zaczynać od RAG

RAG jest ważny, ale nie powinien być pierwszym komponentem.

Najpierw system musi nauczyć się:

```text
What happened?
```

następnie:

```text
What happened before?
```

następnie:

```text
What pattern do we see?
```

dopiero później:

```text
What does the literature say?
```

W przeciwnym razie powstanie chatbot z publikacjami, a nie drugi mózg.

---

# 51. Nie zaczynać od wielkiego prompta

Nie należy próbować zbudować GlucoMind poprzez jeden ogromny prompt zawierający:

- wszystkie zasady,
- całą historię,
- całą pamięć,
- dane Nightscout,
- dokumenty medyczne.

System powinien budować kontekst warstwowo.

```text
Data
↓
Analysis
↓
Retrieval
↓
Context Package
↓
AI
```

---

# 52. Modularność

Komponenty powinny mieć jasne granice.

Przykład:

```text
Nightscout Adapter
     ↓
Event Store
     ↓
Analysis Engine
     ↓
Memory / Pattern / Calculation
     ↓
Context Engine
     ↓
AI Gateway
```

Zmiana modelu LLM nie powinna wymagać przebudowy domeny.

Zmiana Nightscout na inne źródło nie powinna wymagać przebudowy Pattern Engine.

Zmiana modelu embeddingów nie powinna wymagać przebudowy pamięci.

---

# 53. Najważniejsza granica

System powinien zachować rozdzielenie:

```text
DATA
ANALYSIS
KNOWLEDGE
AI
ACTION
```

Czyli:

```text
DATA
→ co się wydarzyło

ANALYSIS
→ co widzimy w danych

KNOWLEDGE
→ co wiadomo z zewnętrznych źródeł

AI
→ jak połączyć te informacje i wyjaśnić/proponować

ACTION
→ decyzja i wykonanie przez użytkownika
```

Nie należy skracać tego do:

```text
DATA → LLM → ACTION
```

---

# 54. Docelowy przepływ analizy

Przykładowy pełny flow:

```text
Nightscout
    ↓
Current State
    ↓
Event Detection
    ↓
Trigger
    ↓
Context Engine
    ├── Recent Events
    ├── Similar Events
    ├── Memory
    ├── Patterns
    ├── Hypotheses
    ├── Therapy
    └── User Context
              ↓
        Knowledge Retrieval
              ↓
        Deterministic Calculation
              ↓
        Context Package
              ↓
           AI Gateway
              ↓
             LLM
              ↓
       Structured Result
              ↓
        Recommendation
              ↓
            User
```

---

# 55. Architektoniczna zasada nadrzędna

> **Najpierw zbudujmy system, który wie, co wie. Dopiero potem system, który potrafi o tym dobrze porozmawiać.**

GlucoMind powinien być systemem danych, pamięci, analiz, wiedzy i AI.

LLM jest warstwą rozumowania i komunikacji.

Największa wartość produktu ma powstać z połączenia:

```text
Patient Data
+
Patient Memory
+
Pattern Analysis
+
Hypotheses
+
Deterministic Calculations
+
External Knowledge
+
AI Reasoning
```

a nie z samego modelu językowego.
