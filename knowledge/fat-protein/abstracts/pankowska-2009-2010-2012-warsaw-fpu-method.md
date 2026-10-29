---
id: pankowska-2009-2010-2012-warsaw-fpu-method
title: "Pańkowska et al., 2009/2010/2012: Warsaw fat-protein unit (WBT) method, definition and extension times (summary)"
publisher: "Pediatr Diabetes 2009;10"
authors: "Pańkowska E and colleagues (Warsaw, Poland)"
year: 2009
url: https://doi.org/10.1111/j.1399-5448.2008.00471.x
doi: 10.1111/j.1399-5448.2008.00471.x
licence: "Own summary (Mellis); original: © Diabetes Technology Society; no open licence"
mode: SUMMARY_ONLY
language: en
retrieved: 2026-10-21
topics: [fat-protein]
index: true
corpus_v7: fat-protein/abstracts/pankowska-2009-2010-2012-warsaw-fpu-method.md
---

*Our summary or notes (Mellis knowledge base), written in our own words with short quotes only; not the original text and not medical advice. Original: https://doi.org/10.1111/j.1399-5448.2008.00471.x.*

# Warsaw (Pańkowska) fat-protein unit method: original papers (2009 cross-sectional, 2010 bolus calculator algorithm, 2012 randomised pizza study)

- **Authors:** Pańkowska E and colleagues (Warsaw, Poland)
- **Journal/year:** Pediatr Diabetes 2009;10(5):298-303; J Diabetes Sci Technol 2010;4(3):571-576; Diabetes Technol Ther 2012;14(1):16-22
- **DOI:** 10.1111/j.1399-5448.2008.00471.x; 10.1177/193229681000400310; 10.1089/dia.2011.0083
- **PubMed:** https://pubmed.ncbi.nlm.nih.gov/19175902/ ; https://pubmed.ncbi.nlm.nih.gov/20513322/ (PMC2901033) ; https://pubmed.ncbi.nlm.nih.gov/22013887/
- **Licence:** the 2010 JDST article is free to read on PMC (© Diabetes Technology Society; no open licence). The 2009 and 2012 papers are not open access. All content below is paraphrased.

## 1. Definition of the fat-protein unit (FPU, Polish WBT) - Pańkowska & Błazik, J Diabetes Sci Technol 2010 (PMC2901033)

Paraphrased from the article's algorithm table (read on PMC; the article is © Diabetes Technology Society, no open licence stated):

- **1 FPU = 100 kcal from fat and/or protein**; FPU = (protein g × 4 + fat g × 9) / 100.
- The meal bolus is a **dual-wave bolus**: the **normal (immediate) part** is calculated from carbohydrate units (CU, 10 g carbohydrate) × insulin ratio; the **square-wave (extended) part** is FPU × the same insulin ratio (i.e. 1 FPU is dosed like 10 g carbohydrate).
- No extended part if FPU < 1.0.
- **Extension duration by FPU:** 1 to < 2 FPU → **3 h**; 2 to < 3 FPU → **4 h**; 3 to < 4 FPU → **5 h**; ≥ 4 FPU → **8 h**.
- The algorithm also scales or drops the square-wave part according to the share of energy from carbohydrate (no square wave when the carbohydrate share is above 0.8; a correction factor when it is 0.2-0.8).

## 2. Pańkowska et al., Pediatr Diabetes 2009 (cross-sectional, 499 children)

- Pump records of 499 patients aged 0-18 years over 2 weeks; mean 16.6 ± 0.77 dual/square-wave boluses per 14 days (range 0-95); 18.8% never used them.
- Lowest HbA1c in children using **≥ 2 dual/square-wave boluses per day** (p = 0.001). Children with HbA1c < 7.5% used more of them (19.55 vs 12.42 per 14 days, p < 0.001). No association in the remission phase (< 0.5 IU/kg/day).
- Observational; shows feasibility of FPU counting in children, not causality.

## 3. Pańkowska et al., Diabetes Technol Ther 2012 (randomised, 24 pump users)

- Pizza dinner: 45 g carbohydrate (180 kcal) + 400 kcal from fat/protein (= 4 FPU).
- Group A: dual-wave bolus = carbohydrate units × ICR (normal part) + FPU × ICR extended over 6 h. Group B: carbohydrate units × ICR only.
- The abstract reports a significant between-group difference in glucose increment from 120 to 360 min, largest at 240 min: **60.2 vs -3.0 mg/dL** (P = 0.04). (The abstract's sentence is worded as "in Group A", which is ambiguous; its conclusion states that the FPU dual-wave bolus controlled postprandial glucose, so the larger rise is presumably in the carbohydrate-only group. Check the full text before quoting the direction.)
- Conclusion: the mixed meal raised glucose after 4-6 h and the FPU dual-wave bolus controlled it. Original Warsaw papers did not report excess hypoglycaemia; later independent studies with longer observation did (see Kordonouri 2012, Lopez 2018, Furthner 2021).

## Notes for Mellis

- Mellis's existing WBT feature (1 WBT = 100 kcal from fat+protein) is exactly this unit. The original Warsaw method doses **100%** (WBT × 10 g/ICR), extended over 3-8 h. Mellis's 30% standard WBT dose is a strongly reduced variant, in line with later safety data.
- Trio's FPU conversion (corpus trio/configuration_settings_features_meal-settings.md) uses fat × 90% + protein × 40% = carb-equivalent grams (i.e. kcal/10, the same as Pańkowska), then multiplies by a default **50%** factor and spreads the carb equivalents from a default 60 min delay over up to 8 h.
