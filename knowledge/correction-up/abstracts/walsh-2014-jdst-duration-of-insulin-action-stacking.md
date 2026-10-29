---
id: walsh-2014-jdst-duration-of-insulin-action-stacking
title: "Walsh, Roberts, Heinemann, JDST 2014: DIA 4.5-6.5 h (6-6.5 h for >0.2 U/kg); children 3.5-6.9 y show insulin action >=5 h; 3 h DIA hides 2.5-4.7 U of a 10 U bolus at 3 h and causes stacking, especially in children"
publisher: "Journal of Diabetes Science and Technology 2014;8"
authors: "Walsh J, Roberts R, Heinemann L"
year: 2014
url: https://pmc.ncbi.nlm.nih.gov/articles/PMC4454113/
doi: 10.1177/1932296813514319
licence: "Own summary (Mellis); original: © 2014 Diabetes Technology Society; free to read on PMC, not openly licensed; short quotes only"
mode: SUMMARY_ONLY
language: en
retrieved: 2026-10-21
topics: [correction, children, insulin]
index: true
corpus_v7: correction-up/abstracts/walsh-2014-jdst-duration-of-insulin-action-stacking.md
---

*Our summary or notes (Mellis knowledge base), written in our own words with short quotes only; not the original text and not medical advice. Original: https://pmc.ncbi.nlm.nih.gov/articles/PMC4454113/.*

# Confusion Regarding Duration of Insulin Action: A Potential Source for Major Insulin Dose Errors by Bolus Calculators (DIA 4.5-6.5 h, hidden insulin stacking with a 3 h DIA, children's insulin activity lasts at least 5 h)

- **Authors:** Walsh J, Roberts R, Heinemann L
- **Journal/year:** Journal of Diabetes Science and Technology 2014;8(1):170-178
- **DOI:** 10.1177/1932296813514319
- **URL:** https://pmc.ncbi.nlm.nih.gov/articles/PMC4454113/
- **Licence:** paraphrased (© 2014 Diabetes Technology Society; free to read on PMC, not openly licensed; short quotes only)
- **Saved:** summary from the PMC full text on 2026-10-21 for the Mellis RAG corpus.

## What it is

A review/commentary on how pump bolus calculators use the duration of insulin action (DIA) to compute "bolus on board" (BOB, IOB), why users and clinicians often choose DIA settings that are too short, and what this does to correction boluses. It proposes a clamp protocol to measure DIA and interim recommendations.

## Key points

- **Clamp "insulin action time" underestimates real DIA:** pharmacodynamic data from larger doses (0.2 U/kg or more) are the best guide; about 40 % of the glucose-lowering effect of insulin aspart 0.2 U/kg may remain at 3 h.
- **Children:** a common belief is that small doses in young children last about 3 h, but bolus sizes per kg are similar to adults, and pharmacodynamic studies in children aged 3.5-6.9 years show insulin activity persisting for at least 5 h. Using a DIA of 3 h "makes insulin stacking especially common in children who tend to bolus more frequently".
- **Hidden stacking (Table 1):** 3 h after a 10 U bolus, the calculator believes this much insulin remains: DIA 3 h - 0 U; 4 h - 1.8 U; 4.5 h - 2.5 U; 5 h - 3.3 U; 5.5 h - 4.0 U; 6 h - 4.7 U. With a 3 h DIA a correction given at 3 h ignores 2.5-4.7 U of real remaining activity and leads to hypoglycaemia, which may then be wrongly blamed on basal rates, carb ratio or correction factor.
- **Recommendations:** do not base DIA on published "insulin action time" ranges; DIA settings of 4.5-6.5 h are probably better estimates, 6.0-6.5 h for boluses typically larger than 0.2 U/kg; discourage shortening DIA to obtain bigger boluses when glucose runs high - fix the carb ratio, correction factor or basal instead; pumps should drop 2 h and 3 h DIA options; insulin makers should publish true DIA so users "know how to avoid insulin stacking".
- **Glucose 2 h after a meal:** compare it with the BOB still active to decide whether a correction is needed (if glucose falls slowly and BOB is not enough to reach target, a correction is needed; if BOB is enough, no correction).

## Notes for Mellis

- **Relevance (high for interval/stacking rules):** supports always computing corrections against IOB with a realistic insulin curve (open-source AID uses 5-7 h per Braune 2022; current Trio docs lock DIA at 10 h with an exponential curve and do not allow less than 5 h) and never against a short 2-3 h window; children are not exempt. It contrasts with Hanas & Adolfsson 2017, who found families of prepubertal children set 2-3 h DIA in non-AID pump calculators (see that summary for why).
- **Population:** adults and children (review).
- **Evidence level:** [Ed] expert review/commentary (pharmacodynamic reasoning, no outcome trial).
