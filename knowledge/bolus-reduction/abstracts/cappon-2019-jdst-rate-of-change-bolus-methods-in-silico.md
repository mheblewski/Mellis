---
id: cappon-2019-jdst-rate-of-change-bolus-methods-in-silico
title: "Cappon 2019 JDST in silico (100 adults, 75 g): trend-adjusted bolus beats standard formula on average; with ROC -3..-2 mg/dL/min Pettus/Edelman best (BGRI 8.36 vs 12.88 at 100 mg/dL); slow falls inconsistent; upward adjustments raise hypo risk"
publisher: "Journal of Diabetes Science and Technology 2019;13"
authors: "Cappon G, Marturano F, Vettoretti M, Facchinetti A, Sparacino G (University of Padova)"
year: 2019
url: https://pmc.ncbi.nlm.nih.gov/articles/PMC6313276/
doi: 10.1177/1932296818777524
licence: "Own summary (Mellis); original: free to read in PMC, not under an open licence"
mode: SUMMARY_ONLY
language: en
retrieved: 2026-10-21
topics: [bolus-reduction, hypoglycaemia]
index: true
corpus_v7: bolus-reduction/abstracts/cappon-2019-jdst-rate-of-change-bolus-methods-in-silico.md
---

*Our summary or notes (Mellis knowledge base), written in our own words with short quotes only; not the original text and not medical advice. Original: https://pmc.ncbi.nlm.nih.gov/articles/PMC6313276/.*

# In Silico Assessment of Literature Insulin Bolus Calculation Methods Accounting for Glucose Rate of Change

- **Authors:** Cappon G, Marturano F, Vettoretti M, Facchinetti A, Sparacino G (University of Padova)
- **Journal/year:** Journal of Diabetes Science and Technology 2019;13(1):103–110 (online 2018-05-31)
- **DOI:** 10.1177/1932296818777524
- **URL:** https://pmc.ncbi.nlm.nih.gov/articles/PMC6313276/ (PMID 29848104)
- **Licence:** © 2018 Diabetes Technology Society (free to read in PMC, not under an open licence) → paraphrased summary with short quotes.
- **Saved:** summary from the PubMed abstract and PMC full text on 2026-10-21 for the Mellis RAG corpus.

## Question

Does adjusting the standard bolus formula (SF) for the CGM rate of change (ROC) improve post-meal outcomes, and which literature method is best?

## Methods

- SF: bolus = CHO/CR + (G − target)/CF − IOB.
- Adjustments compared (as summarised by the authors): Buckingham (BU) — change the total bolus by ±10% for ROC 1–2 mg/dL/min and ±20% for > 2 mg/dL/min; Scheiner (SC) — shift the glucose used in the correction by ±25 mg/dL (ROC 1–3) or ±50 mg/dL (> 3); Pettus/Edelman (PE) — shift by ±50/±75/±100 mg/dL for ROC 1–2/2–3/> 3 mg/dL/min. Shifts are downward (smaller dose) for falling glucose.
- UVa/Padova T1D simulator, 100 virtual adults, single 75 g lunch, noise-free CGM, optimal therapy parameters; pre-meal glucose 60, 70, 80, 100, 150, 250 mg/dL × ROC bands −3 to −2, −2 to −1, +1 to +2, +2 to +3 mg/dL/min (24 scenarios; |ROC| < 1 not adjusted by any method). Outcome: blood glucose risk index (BGRI) over 9 h, plus LBGI ratio vs SF.

## Results

- On average all three ROC methods improved BGRI vs SF.
- Rapidly falling glucose (ROC −3 to −2): PE (the largest reduction) performed best; e.g. pre-meal 100 mg/dL median BGRI 12.88 (SF) vs 9.10 (BU), 9.01 (SC), 8.36 (PE). In an example subject, PE removed time in hypoglycaemia.
- Moderately falling (−2 to −1): no method consistently better; at 60 mg/dL pre-meal, median BGRI 5.51 (SF), 5.39 (BU), 5.20 (SC), 5.15 (PE); differences not significant at 60 and 150 mg/dL. PE had the lowest LBGI ratio at 60 mg/dL (0.79 vs 0.88 for BU and SC).
- Rising glucose: hypoglycaemia risk increased with the upward adjustments ("systematically increases"); in one subject all three methods caused hypoglycaemia.
- "the bigger the correction of SF, the higher the variability obtained in terms of BGRI" — ROC adjustments helped on average but worsened outcomes in some subjects.

## Conclusion

In this idealised setting none of the methods is globally better; more effective formulas for using ROC in calculators are needed.

## Notes for Mellis

- **Relevance:** Simulation support for reducing the meal bolus when CGM shows a falling trend, especially a fast fall (≤ −2 mg/dL/min), where the most aggressive reduction (PE) was best; for slow falls the benefit is small and inconsistent. Upward (rising-trend) increases carry hypo risk.
- Adults only, single meal, no sensor noise, no AID (open loop with fixed basal); results are not directly transferable to AID in children.
- **Evidence level:** in-silico study (UVa/Padova simulator).
