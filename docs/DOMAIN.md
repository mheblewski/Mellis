# DOMAIN.md

# Model domeny GlucoMind

## 1. Cel dokumentu

Ten dokument definiuje model domeny GlucoMind - najważniejsze pojęcia, encje, relacje i zasady reprezentowania danych.

Model domeny powinien być:

- niezależny od konkretnego interfejsu,
- niezależny od konkretnego modelu LLM,
- niezależny od konkretnego dostawcy AI,
- możliwie uniwersalny względem wieku pacjenta i relacji użytkownika do pacjenta,
- przygotowany na rozwój produktu poza pierwszym scenariuszem użycia.

Domena opisuje **co istnieje w systemie i jakie ma znaczenie**.

Nie opisuje jeszcze szczegółów implementacji bazodanowej ani API.

---

## 2. Podstawowy model

GlucoMind powinien być oparty na następującym modelu:

```text
User
  │
  │ manages / observes
  ↓
Patient
  │
  ├── Diabetes Profile
  ├── Therapy
  ├── Events
  ├── Context
  ├── Memory
  ├── Patterns
  ├── Hypotheses
  └── Analyses
```

Równolegle:

```text
External Knowledge
        ↓
Knowledge Base / RAG
        ↓
Relevant Evidence
        ↓
Context Assembly
        ↓
AI
```

Oraz:

```text
Nightscout / CGM / Pump / other sources
        ↓
Source Data
        ↓
Events / Current State / Analysis
```

---

# 3. User

`User` reprezentuje osobę korzystającą z GlucoMind.

User nie jest automatycznie pacjentem.

Przykładowe relacje:

- rodzic,
- opiekun,
- partner,
- pacjent zarządzający własną terapią,
- inna osoba uprawniona do korzystania z danych.

### Przykładowe pola

```text
User
- id
- display_name
- preferences
- communication_preferences
- custom_instructions
- created_at
- updated_at
```

Relacja z pacjentem powinna być reprezentowana osobno.

---

# 4. Caregiver Relationship

`CaregiverRelationship` opisuje relację użytkownika do pacjenta.

Przykładowe wartości:

```text
SELF
PARENT
GUARDIAN
PARTNER
FAMILY_MEMBER
CAREGIVER
OTHER
```

Relacja nie powinna być zakodowana w logice aplikacji.

Przykład:

```text
User A
  └── PARENT → Patient B
```

lub:

```text
User A
  └── SELF → Patient A
```

---

# 5. Patient

`Patient` reprezentuje osobę, której dane i terapia są analizowane.

### Przykładowe pola

```text
Patient
- id
- display_name
- date_of_birth / age information
- diabetes_profile
- created_at
- updated_at
```

System powinien unikać zakładania, że każdy pacjent jest dzieckiem.

Pierwsza wersja może być zoptymalizowana pod T1D, ale model powinien umożliwiać późniejsze rozszerzenie.

---

# 6. Diabetes Profile

`DiabetesProfile` opisuje podstawowy kontekst cukrzycy pacjenta.

Może obejmować:

- typ cukrzycy,
- datę diagnozy,
- sposób prowadzenia terapii,
- używane urządzenia,
- używany system automatyzacji,
- istotne informacje dotyczące terapii.

Przykładowe wartości:

```text
diabetes_type:
- T1D
- T2D
- OTHER
- UNKNOWN
```

Model powinien umożliwiać rozszerzenie bez konieczności przebudowy całej domeny.

---

# 7. Therapy

`Therapy` reprezentuje aktualny lub historyczny sposób prowadzenia terapii.

Może obejmować:

- insulinę,
- profile,
- bazę,
- ICR,
- ISF,
- target,
- DIA,
- ustawienia automatycznej regulacji,
- inne parametry zależne od używanej terapii.

Terapia jest **wersjonowana w czasie**.

Nie należy zakładać, że jedna wartość ustawienia obowiązuje przez całą historię.

---

# 8. Therapy Profile

`TherapyProfile` reprezentuje konkretny profil terapii.

Przykładowo:

```text
Profile A
- basal schedule
- ICR schedule
- ISF schedule
- target schedule
- DIA
```

Każdy parametr może być zależny od czasu.

Przykład:

```text
00:00 - basal 0.30
06:00 - basal 0.40
12:00 - basal 0.35
18:00 - basal 0.45
```

Profil powinien mieć:

```text
valid_from
valid_to
source
version
```

Dzięki temu analiza historyczna może wykorzystać ustawienia obowiązujące w momencie danego zdarzenia.

---

# 9. Therapy Parameter

Pojedyncze parametry terapii powinny być reprezentowane w sposób umożliwiający historię zmian.

Przykłady:

- basal rate,
- ICR,
- ISF,
- target,
- DIA.

Ważne jest rozróżnienie:

```text
Current value
```

od:

```text
Historical value at event time
```

---

# 10. Source

`Source` reprezentuje źródło informacji.

Przykładowe typy:

```text
NIGHTSCOUT
CGM
PUMP
DEVICE
USER
CAREGIVER
SYSTEM_ANALYSIS
AI_INFERENCE
MEDICAL_SOURCE
MANUAL_ENTRY
```

Każda istotna informacja powinna mieć możliwość wskazania źródła.

---

# 11. Source Record

`SourceRecord` reprezentuje konkretny rekord pochodzący ze źródła zewnętrznego.

Przykłady:

- wpis Nightscout,
- odczyt CGM,
- bolus pompy,
- temporary basal,
- ręcznie zapisany posiłek.

Minimalnie powinien umożliwiać:

```text
source_type
source_id
timestamp
raw_reference
```

Nie należy bez potrzeby kopiować całych danych źródłowych do domenowej pamięci GlucoMind.

---

# 12. Current State

`CurrentState` reprezentuje aktualny stan pacjenta istotny dla analizy.

Może zawierać:

- aktualną glikemię,
- trend,
- tempo zmiany,
- IOB,
- ostatnią insulinę,
- ostatni posiłek,
- aktywny profil terapii,
- aktywny temporary basal,
- inne aktualne dane.

Current State powinien być obliczany na podstawie aktualnych źródeł.

Nie powinien być traktowany jako niezależne źródło prawdy.

---

# 13. Event

`Event` reprezentuje zdarzenie mające znaczenie dla historii pacjenta.

Przykładowe typy:

```text
GLUCOSE_EVENT
HYPO
HYPER
MEAL
SNACK
BOLUS
BASAL_CHANGE
TEMP_BASAL
ACTIVITY
SLEEP
ILLNESS
SYMPTOM
DEVICE_EVENT
UNEXPECTED_RESPONSE
OTHER
```

Event powinien mieć:

```text
id
type
patient_id
occurred_at
recorded_at
source
context
```

### Occurred vs recorded

Należy zawsze rozróżniać:

- kiedy coś faktycznie się wydarzyło,
- kiedy system się o tym dowiedział.

Przykład:

> Użytkownik o 20:00 informuje, że o 18:00 pacjent zjadł dodatkową przekąskę.

`occurred_at = 18:00`

`recorded_at = 20:00`

---

# 14. Event Context

`EventContext` zawiera informacje związane z konkretnym zdarzeniem.

Może obejmować:

```text
activity
food
sleep
illness
therapy
environment
user_report
```

Informacja może mieć stan:

```text
YES
NO
UNKNOWN
```

Ważne:

```text
UNKNOWN != NO
```

---

# 15. Meal

`Meal` reprezentuje posiłek.

Może zawierać:

- opis,
- zdjęcie,
- szacowane CHO,
- zakres CHO,
- tłuszcz,
- białko,
- ilość faktycznie zjedzona,
- informację o niedokończeniu,
- czas posiłku,
- źródło informacji.

Należy rozróżniać:

```text
planned_amount
```

od:

```text
estimated_consumed_amount
```

Przykład:

> Zaplanowano 50 g CHO, ale pacjent prawdopodobnie zjadł 30 g.

Obie informacje powinny być zachowane.

---

# 16. Activity

`Activity` reprezentuje aktywność fizyczną.

Może zawierać:

- typ,
- rozpoczęcie,
- zakończenie,
- intensywność,
- źródło,
- opis,
- pewność informacji.

Przykładowo:

```text
SWIMMING
RUNNING
CYCLING
WALKING
PLAY
SPORT
OTHER
```

System nie powinien ograniczać się do listy zamkniętej.

---

# 17. Sleep

`Sleep` reprezentuje okres snu lub istotną informację o śnie.

Może obejmować:

- rozpoczęcie,
- zakończenie,
- czas trwania,
- jakość,
- źródło,
- nietypowe zdarzenia.

Sen może być istotnym kontekstem dla późniejszej analizy.

---

# 18. Illness

`Illness` reprezentuje okres choroby lub objawy mogące wpływać na terapię.

Może zawierać:

- typ,
- rozpoczęcie,
- zakończenie,
- objawy,
- gorączkę,
- źródło,
- pewność.

Choroba jest zwykle informacją czasową.

---

# 19. Observation

`Observation` reprezentuje pojedynczą informację o pacjencie.

Może pochodzić z:

- użytkownika,
- urządzenia,
- systemu,
- analizy.

Przykład:

> Pacjent nie zjadł całego posiłku.

Observation może zostać powiązane z Eventem.

---

# 20. Memory

`Memory` reprezentuje informację przeznaczoną do wykorzystania w przyszłych analizach.

Memory nie jest synonimem Event.

Typy pamięci:

```text
EPISODIC
CONTEXT
PATTERN
HYPOTHESIS
STABLE_PROFILE
ANALYSIS
```

Szczegółowa polityka pamięci znajduje się w `MEMORY.md`.

---

# 21. Memory Evidence

Każda istotna pamięć powinna mieć dowody.

`MemoryEvidence` może wskazywać:

- Event,
- Observation,
- wiadomość użytkownika,
- Analysis,
- inne źródło.

Przykład:

```text
Pattern
  ↓
Evidence
  ├── Event 1
  ├── Event 2
  ├── Event 3
  └── Event 11
```

Dzięki temu pamięć może być audytowalna.

---

# 22. Pattern

`Pattern` reprezentuje powtarzalną zależność wykrytą w historii.

Pattern nie jest automatycznie przyczynowością.

Przykład:

> Po wieczornym pływaniu w 8 z 11 podobnych przypadków wystąpił późniejszy spadek glukozy.

Pattern powinien zawierać:

```text
id
patient_id
definition
scope
observations_count
supporting_count
contradicting_count
confidence
status
algorithm_version
created_at
updated_at
```

---

# 23. Hypothesis

`Hypothesis` reprezentuje możliwe wyjaśnienie obserwowanego zjawiska.

Przykład:

> Późny spadek może być związany z wcześniejszym wysiłkiem.

Hypothesis może mieć:

```text
id
patient_id
statement
supporting_evidence
contradicting_evidence
confidence
status
created_at
updated_at
```

Status może obejmować:

```text
NEW
ACTIVE
SUPPORTED
WEAKENED
CONTRADICTED
EXPIRED
```

---

# 24. Analysis

`Analysis` reprezentuje konkretną analizę wykonaną przez system.

Przykłady:

- analiza hipoglikemii,
- analiza posiłku,
- analiza ustawienia ICR,
- analiza wzorca,
- porównanie dwóch okresów,
- analiza nieoczekiwanej reakcji.

Analysis powinno przechowywać:

- cel,
- czas,
- dane wejściowe,
- wykorzystane Eventy,
- wykorzystane Memory,
- wykorzystane Patterns,
- wykorzystane Hypotheses,
- wykorzystane źródła wiedzy,
- obliczenia,
- wynik,
- wersję algorytmu.

---

# 25. Calculation

`Calculation` reprezentuje wynik deterministycznego obliczenia.

LLM nie powinien być źródłem prawdy dla wartości obliczeniowych.

Calculation powinno zawierać:

```text
id
type
inputs
assumptions
method
algorithm_version
result
uncertainty
created_at
```

Przykładowe typy:

```text
INSULIN_DOSE
CARB_ESTIMATE
CORRECTION
IOB
ICR
ISF
OTHER
```

Calculation powinno być możliwe do odtworzenia.

---

# 26. Recommendation

`Recommendation` reprezentuje konkretną propozycję przedstawioną użytkownikowi.

Przykładowo:

- propozycja dawki,
- propozycja ilości CHO,
- propozycja zakresu,
- propozycja obserwacji,
- propozycja ponownej analizy ustawienia.

Recommendation nie oznacza wykonania działania.

Powinna zawierać:

```text
recommendation
reasoning_summary
supporting_data
uncertainties
alternatives
created_at
```

W przypadku propozycji terapeutycznej użytkownik musi móc zobaczyć podstawę wyniku.

---

# 27. Conversation

`Conversation` reprezentuje rozmowę użytkownika z AI.

Może być:

```text
USER_INITIATED
TRIGGER_INITIATED
MODULE_INITIATED
```

Conversation może być powiązana z:

- Event,
- Analysis,
- Recommendation,
- Therapy,
- Meal,
- Pattern,
- Hypothesis.

Rozmowa jest źródłem potencjalnych informacji dla Memory Extraction, ale sama rozmowa nie jest pamięcią.

---

# 28. Message

`Message` reprezentuje pojedynczą wiadomość w Conversation.

Powinna zawierać:

```text
id
conversation_id
role
content
created_at
```

Może również mieć informacje o:

- użytym kontekście,
- źródłach,
- modelu,
- wersji promptów,
- narzędziach.

---

# 29. Context Question

`ContextQuestion` reprezentuje pytanie zadane użytkownikowi w celu zmniejszenia istotnej niepewności.

Powinna mieć:

```text
question
reason
expected_information_gain
related_event
status
```

Pytanie powinno być zadawane tylko wtedy, gdy odpowiedź może wpłynąć na analizę.

---

# 30. Knowledge Source

`KnowledgeSource` reprezentuje zewnętrzne źródło wiedzy.

Przykładowe typy:

```text
GUIDELINE
SCIENTIFIC_PAPER
SYSTEMATIC_REVIEW
META_ANALYSIS
DEVICE_DOCUMENTATION
SOFTWARE_DOCUMENTATION
OTHER_VERIFIED_SOURCE
```

Powinno zawierać:

- tytuł,
- autorów,
- datę,
- publikację/organizację,
- wersję,
- temat,
- populację,
- źródło,
- jakość/klasyfikację źródła.

---

# 31. Knowledge Evidence

`KnowledgeEvidence` reprezentuje fragment wiedzy pobrany z Knowledge Base.

Powinien zachować:

- źródło,
- fragment dokumentu,
- identyfikator dokumentu,
- identyfikator fragmentu,
- metadane,
- sposób retrieval,
- relevance score.

RAG powinien dostarczać **evidence**, a nie zastępować proces rozumowania.

---

# 32. Context Package

`ContextPackage` jest przygotowanym pakietem informacji przekazywanym do AI.

Może zawierać:

```text
CURRENT STATE
CURRENT EVENT
RECENT EVENTS
SIMILAR EVENTS
CONTEXT MEMORY
PATTERNS
HYPOTHESES
STABLE PROFILE
CALCULATIONS
KNOWLEDGE EVIDENCE
USER PREFERENCES
AI CONTRACT
```

Context Package jest tworzony dla konkretnego zadania.

Nie powinien być stałym snapshotem całej historii pacjenta.

---

# 33. Trigger

`Trigger` reprezentuje warunek, który może uruchomić działanie systemu.

Przykłady:

```text
HYPO_DETECTED
REPEATED_HYPO
UNUSUAL_HYPER
UNEXPECTED_RESPONSE
PATTERN_CHANGE
MISSING_CONTEXT
OTHER
```

Trigger może uruchomić:

- analizę,
- pytanie,
- Conversation,
- aktualizację pamięci,
- inne działanie systemowe.

---

# 34. User Preferences

`UserPreferences` reprezentuje preferencje użytkownika.

Może obejmować:

- długość odpowiedzi,
- styl komunikacji,
- poziom szczegółowości,
- sposób prezentowania wyników,
- preferowany język.

---

# 35. Custom Instructions

`CustomInstructions` reprezentuje dodatkowe instrukcje użytkownika dotyczące sposobu działania i komunikacji AI.

Przykład:

> Rozmawiaj ze mną jak z opiekunem osoby z T1D. Znam podstawy Loop i nie potrzebuję wyjaśniania podstaw.

Custom instructions:

- nie zastępują AI Contract,
- nie zastępują danych strukturalnych,
- nie zastępują pamięci pacjenta,
- nie powinny mieć możliwości wyłączenia podstawowych zasad bezpieczeństwa systemu.

---

# 36. Evidence

W GlucoMind należy rozróżniać różne rodzaje evidence.

```text
PATIENT_DATA
PATIENT_HISTORY
CAREGIVER_REPORT
SYSTEM_ANALYSIS
CALCULATION
MEDICAL_KNOWLEDGE
```

Przykład:

```text
Patient history:
8/11 similar events

Medical knowledge:
literature describes similar mechanism

Calculation:
3.75 U

Caregiver report:
"probably ate half"
```

Nie należy łączyć tych informacji w jeden nieopisany poziom pewności.

---

# 37. Confidence

Confidence jest metadanymi opisującymi siłę wsparcia dla informacji.

Confidence może dotyczyć:

- Observation,
- Memory,
- Pattern,
- Hypothesis,
- Analysis,
- Recommendation.

Powinien być wyliczany przez odpowiednią logikę systemową.

Nie powinien być dowolnie wymyślany przez LLM.

---

# 38. Status

Obiekty domenowe powinny mieć jawny status tam, gdzie ich stan może się zmieniać.

Przykładowe statusy:

```text
ACTIVE
INACTIVE
PENDING
EXPIRED
CONTRADICTED
WEAKENED
SUPPORTED
REJECTED
```

Status powinien być semantycznie zdefiniowany dla konkretnej encji.

---

# 39. Temporal Model

Czas jest fundamentalnym elementem domeny.

System powinien rozróżniać co najmniej:

```text
occurred_at
recorded_at
created_at
updated_at
valid_from
valid_to
```

Dla ustawień terapii szczególnie ważne jest:

```text
valid_from / valid_to
```

Dla zdarzeń:

```text
occurred_at
```

Dla informacji zgłoszonych później:

```text
occurred_at != recorded_at
```

---

# 40. Unknown Model

`UNKNOWN` powinno być wspierane na poziomie domeny.

Nie należy reprezentować go wyłącznie jako:

```text
null
```

jeżeli utrata informacji o znaczeniu `UNKNOWN` mogłaby prowadzić do błędnej interpretacji.

Przykład:

```text
activity:
status = UNKNOWN
```

oznacza:

> Nie wiemy, czy aktywność wystąpiła.

Nie oznacza:

> Aktywność nie wystąpiła.

---

# 41. Conflict Model

System powinien umożliwiać przechowywanie wielu informacji dotyczących tego samego faktu.

Przykład:

```text
Nightscout:
50 g CHO

Caregiver:
probably 30 g CHO
```

Nie należy automatycznie usuwać jednej informacji.

System powinien reprezentować:

```text
Fact A
Fact B
Conflict
Resolution status
```

Rozstrzygnięcie konfliktu może nastąpić później.

---

# 42. Source of Truth

W GlucoMind należy jasno określić źródło prawdy.

### Nightscout / urządzenia

Źródło prawdy dla danych, które faktycznie rejestrują:

- glikemia,
- insulinę,
- bolusy,
- temporary basal,
- dane urządzeń,
- inne dane źródłowe.

### GlucoMind Database

Źródło prawdy dla:

- pamięci,
- kontekstu,
- hipotez,
- wzorców,
- analiz,
- rozmów,
- preferencji,
- propozycji,
- wyników własnych obliczeń,
- relacji między informacjami.

### Knowledge Base

Źródło prawdy dla przechowywanej wiedzy zewnętrznej i jej metadanych.

---

# 43. Relacje wysokiego poziomu

Najważniejsze relacje:

```text
User
  ↓
CaregiverRelationship
  ↓
Patient
  ↓
DiabetesProfile
  ↓
Therapy
  ↓
Events
```

oraz:

```text
Events
  ↓
Analysis
  ↓
Patterns
  ↓
Hypotheses
  ↓
Memory
```

oraz:

```text
Conversation
  ↓
Memory Extraction
  ↓
Candidate Memory
  ↓
Memory Policy
  ↓
Memory
```

oraz:

```text
Current Task
  ↓
Context Retrieval
  ├── Events
  ├── Memory
  ├── Patterns
  ├── Hypotheses
  ├── Calculations
  └── Knowledge Evidence
        ↓
Context Package
        ↓
AI
```

---

# 44. Zasada domeny

Najważniejszą zasadą modelu domeny jest:

> **Nie przechowujemy wszystkiego jako „tekst dla AI”.**

Informacje powinny mieć odpowiedni typ.

Zdarzenie powinno być zdarzeniem.

Wzorzec powinien być wzorcem.

Hipoteza powinna być hipotezą.

Obliczenie powinno być obliczeniem.

Źródło powinno być źródłem.

Wiedza medyczna powinna być wiedzą zewnętrzną.

Rozmowa powinna być rozmową.

Dzięki temu AI może otrzymać odpowiedni kontekst bez konieczności przetwarzania całej historii systemu.

---

# 45. Zasada rozszerzalności

Model domeny powinien być przygotowany na przyszłe rozszerzenia, ale nie powinien projektować funkcji, których produkt jeszcze nie potrzebuje.

W szczególności:

- nie zakładamy, że pacjent jest zawsze dzieckiem,
- nie zakładamy, że użytkownik jest zawsze rodzicem,
- nie zakładamy jednego urządzenia,
- nie zakładamy jednego systemu terapii,
- nie zakładamy jednego dostawcy danych,
- nie zakładamy jednego modelu AI,
- nie zakładamy jednego źródła wiedzy.

Pierwsza implementacja może wspierać ograniczony zakres, ale domena nie powinna być sztucznie związana z jednym przypadkiem użycia.
