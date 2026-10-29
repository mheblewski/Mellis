---
id: king-2007-jdst-icr-cf-relationship-carb-sensitivity
title: "King & Armstrong, J Diabetes Sci Technol 2007: in 30 CGM-titrated adult pump users CF ≈ 4.44 × ICR, i.e. carb sensitivity ≈4.4 mg/dL per gram; ICR = 217/TDD + 3, CF = 1076/TDD + 12"
publisher: "Journal of Diabetes Science and Technology 2007;1"
authors: "King AB, Armstrong DU"
year: 2007
url: https://pmc.ncbi.nlm.nih.gov/articles/PMC2769601/
doi: 10.1177/193229680700100107
licence: "Own summary (Mellis); original: © Diabetes Technology Society; free to read in PMC, no open licence stated"
mode: SUMMARY_ONLY
language: en
retrieved: 2026-10-21
topics: [bolus-reduction, bolus-calculator, pump, cgm, insulin]
index: true
corpus_v7: bolus-reduction/abstracts/king-2007-jdst-icr-cf-relationship-carb-sensitivity.md
---

*Our summary or notes (Mellis knowledge base), written in our own words with short quotes only; not the original text and not medical advice. Original: https://pmc.ncbi.nlm.nih.gov/articles/PMC2769601/.*

# A prospective evaluation of insulin dosing recommendations in patients with type 1 diabetes at near normal glucose control: bolus dosing

- **Authors:** King AB, Armstrong DU
- **Journal/year:** Journal of Diabetes Science and Technology 2007;1(1):42–46
- **DOI:** 10.1177/193229680700100107
- **URL:** https://pmc.ncbi.nlm.nih.gov/articles/PMC2769601/
- **Licence:** paraphrased (© Diabetes Technology Society; free to read in PMC, no open licence stated)
- **Saved:** summary from the PMC full text and abstract on 2026-10-21 for the Mellis RAG corpus.

## Design

- 30 adults with T1D on insulin pumps (mean age 46.1 y, range 20–72; mean weight 74.1 kg, range 48.2–110.1), blinded CGM for about 2 weeks with near-daily dose adjustment.
- Basal set first (< 5% of values < 70 mg/dL, < 20% > 170 mg/dL). Then for each meal time:
  - ICR (g/U) set so glucose returned to within ±20% of the pre-meal value by the 4th hour after the bolus;
  - CF (mg/dL per U) set so glucose reached 80–120 mg/dL by the 4th hour after a correction.

## Results

- Mean TDD 35.4 U/day; mean ICR 10.3 g/U (5–22.3); mean CF 46.3 mg/dL/U (21–100).
- Best-fit formulas: ICR = 217/TDD + 3; CF = 1076/TDD + 12. The usual ICR = 450/TDD gave too little insulin (p < 0.0005); CF = 1700/TDD did not differ significantly (p = 0.087). The weight-based formula 2.8 × weight (lb)/TDD also differed from observed values.
- ICR and CF were tightly linked: CF ≈ 4.44 × ICR (r = 0.90, intercept forced to 0). No time-of-day difference.

## Notes for Mellis

- **Key number:** CF/ICR is the "carb sensitivity factor" (glucose rise per gram not covered by insulin). In these well-controlled adults it averaged about 4.4 mg/dL per gram (≈0.25 mmol/L per g). This is a derived ratio (the paper reports CF = 4.44 × ICR; the mg/dL-per-gram reading is our arithmetic).
- **Use:** supports computing grams of carbohydrate that "cover" a forecast drop as (target − forecast low) / (ISF/ICR) using the patient's own ISF and ICR, as oref/OpenAPS does (carbsReq). A child's ratio is larger (smaller body, e.g. ISF 150 / ICR 20 = 7.5 mg/dL per g); use the patient's settings, not the adult mean.
- **Population:** adults on pumps (pre-AID), CGM-guided titration.
- **Evidence level:** small prospective clinical titration study.
