---
id: walsh-2011-jdst-bolus-calculator-settings-adults
title: "Walsh 2011 JDST: 396 Cozmo pumps; calculator cut 1.40 U/day for bolus-on-board and 0.27 U/day for hypoglycaemia vs 0.09 U/day user reductions; BOB should be subtracted from carb and correction doses; CF=1960/TDD, CarbF=5.7xkg/TDD, DIA 4.5-6 h"
publisher: "Journal of Diabetes Science and Technology 2011;5"
authors: "Walsh J, Roberts R, Bailey T"
year: 2011
url: https://pmc.ncbi.nlm.nih.gov/articles/PMC3045234/
doi: 10.1177/193229681100500118
licence: "Own summary (Mellis); original: free to read in PMC, not under an open licence"
mode: SUMMARY_ONLY
language: en
retrieved: 2026-10-21
topics: [bolus-reduction, hypoglycaemia, correction, bolus-calculator, pump, insulin]
index: true
corpus_v7: bolus-reduction/abstracts/walsh-2011-jdst-bolus-calculator-settings-adults.md
---

*Our summary or notes (Mellis knowledge base), written in our own words with short quotes only; not the original text and not medical advice. Original: https://pmc.ncbi.nlm.nih.gov/articles/PMC3045234/.*

# Guidelines for Optimal Bolus Calculator Settings in Adults

- **Authors:** Walsh J, Roberts R, Bailey T
- **Journal/year:** Journal of Diabetes Science and Technology 2011;5(1):129–135
- **DOI:** 10.1177/193229681100500118
- **URL:** https://pmc.ncbi.nlm.nih.gov/articles/PMC3045234/
- **Licence:** © 2011 Diabetes Technology Society (free to read in PMC, not under an open licence) → paraphrased summary with short quotes.
- **Saved:** summary from the PMC full text on 2026-10-21 for the Mellis RAG corpus.

## Design

- Retrospective analysis of the Actual Pump Practices (APP) data: downloads from 396 Deltec Cozmo pumps (2007 software upgrade), split into tertiles by mean meter glucose. Formulas derived from the best-control tertile (n = 132; mean glucose 144 mg/dL, 8.0 mmol/L; range 109–163 mg/dL).
- Bolus calculator use was near-universal: 92.7% of pumps for carb boluses, 96.5% for corrections.

## Key findings

- The pump's calculator lowered its recommendations by on average **1.40 U/day for bolus on board (BOB)** and by **0.27 U/day for hypoglycaemia** (our reading: the calculator's reduction when the entered glucose was low/below target; the paper does not spell out the formula), while users themselves reduced recommended doses by only **0.09 U/day**. The calculator added 4.2 U/day for hyperglycaemia (users added 0.56 U/day).
- "Most of the protection against hypoglycemia in our pump analysis arose through dose reductions made by the BC" — i.e. automatic BOB subtraction plus low-glucose reduction did far more than user overrides.
- In the best-control tertile, basal was 47.8% of TDD, carb boluses 43.1%, correction boluses 9.0%.

## Recommended settings (formulas)

- Basal ≈ TDD × 0.48 (adjust for diet).
- Carb factor (g/U) = 2.6 × weight (lb) / TDD = 5.7 × weight (kg) / TDD.
- Correction factor (mg/dL/U) = 1960 / TDD (109 / TDD in mmol/L); lower constant (e.g. 1500) if average glucose is high, higher (e.g. 2200) if near-normal.
- Duration of insulin action for rapid analogues: 4.5–6.0 h for curvilinear models (4.0–5.5 h linear); a 3-h DIA hides residual insulin and risks stacking.
- Use a single correction target rather than a range: "Always select a CT for the glucose desired about 5 hours later."
- Safe calculator logic: count both carb and correction boluses as BOB and subtract BOB "from carb and correction doses when a glucose test is performed" (i.e. BOB reduces the meal dose too, not only the correction).
- With frequent hypoglycaemia, lower TDD immediately by 5% or more.

## Limitations stated

- For 60–90 min after a carb bolus the calculator cannot estimate the net effect of digestion vs insulin; slow-absorbing meals, pramlintide, GLP-1 agonists, gastroparesis reduce accuracy. Formulas need prospective validation.

## Notes for Mellis

- **Relevance:** Quantifies that in real pump use (adults, Cozmo) the calculator's own reductions — BOB (1.40 U/day) and below-target reduction (0.27 U/day) — supplied most of the hypo protection, and that users rarely reduce doses themselves (0.09 U/day). Supports making the reduction automatic and visible in Mellis rather than relying on the caregiver to cut doses by feel. Also supports subtracting active bolus insulin from the meal dose, not just from the correction.
- The paper does not describe the exact below-target formula of the Cozmo calculator or report outcomes of reverse correction; it does not cover AID or children.
- **Evidence level:** retrospective observational analysis of pump downloads (adults); expert guideline formulas.
