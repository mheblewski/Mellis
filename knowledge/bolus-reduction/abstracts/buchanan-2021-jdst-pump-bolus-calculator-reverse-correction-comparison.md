---
id: buchanan-2021-jdst-pump-bolus-calculator-reverse-correction-comparison
title: "Buchanan 2021 JDST: Omnipod (reverse correction ON), 670G (reduces by default), t:slim (Reduce Bolus Calc prompt) with identical settings; below target doses differed up to 10-fold (0.15 vs 1.5 U for BG 75 + 30 g); t:slim subtracts IOB and negative correction, 670G only the negative correction"
publisher: "Journal of Diabetes Science and Technology 2021;15"
authors: "Buchanan J, Zabinsky JA, Ferrara-Cook C, Adi S, Wong JC (University of California San Francisco)"
year: 2021
url: https://pmc.ncbi.nlm.nih.gov/articles/PMC8655273/
doi: 10.1177/1932296820951855
licence: "Own summary (Mellis); original: free to read in PMC, not under an open licence"
mode: SUMMARY_ONLY
language: en
retrieved: 2026-10-21
topics: [bolus-reduction, correction, aid, targets, settings]
index: true
corpus_v7: bolus-reduction/abstracts/buchanan-2021-jdst-pump-bolus-calculator-reverse-correction-comparison.md
---

*Our summary or notes (Mellis knowledge base), written in our own words with short quotes only; not the original text and not medical advice. Original: https://pmc.ncbi.nlm.nih.gov/articles/PMC8655273/.*

# Comparison of Insulin Pump Bolus Calculators Reveals Wide Variation in Dose Recommendations

- **Authors:** Buchanan J, Zabinsky JA, Ferrara-Cook C, Adi S, Wong JC (University of California San Francisco)
- **Journal/year:** Journal of Diabetes Science and Technology 2021;15(6):1290–1296 (online 2020-09-01)
- **DOI:** 10.1177/1932296820951855
- **URL:** https://pmc.ncbi.nlm.nih.gov/articles/PMC8655273/ (PMID 32869656)
- **Licence:** © 2020 Diabetes Technology Society (free to read in PMC, not under an open licence) → paraphrased summary with short quotes.
- **Saved:** summary from the PMC full text on 2026-10-21 for the Mellis RAG corpus.

## Design

- Bench simulation, no participants. Three FDA-approved pump bolus calculators (BCs) used in manual mode by typing BG and carbs: BC1 Insulet Omnipod UST 400, BC2 Medtronic MiniMed 670G, BC3 Tandem t:slim X2.
- Identical settings: ICR 15 g/U, ISF 50 mg/dL/U, single target 100 mg/dL, active insulin time 3 h. BC1 uses linear IOB decay; BC2 and BC3 curvilinear.
- Below-target handling as configured: Omnipod "Reverse Correction" turned **on**; the 670G reduces the bolus below target **by default**; t:slim asks the user whether to "Reduce Bolus Calc", which was accepted.
- A 4 U bolus was given from three starting situations (BG 100 + 60 g; BG 200 + 30 g; BG 300 + 0 g). At 1 h and 2 h (IOB still present), follow-up BGs of 60, 75, 100, 150, 250 and 350 mg/dL were combined with 0, 30 or 75 g carbs → 108 recommendations per pump (each repeated 3×, identical).

## Reverse-engineered formulas (Table 1, paraphrased)

CHO dose = g / ICR; BG dose = (BG − target)/ISF (negative below target).

| Follow-up BG | Omnipod (BC1) | 670G (BC2) | t:slim X2 (BC3) |
|---|---|---|---|
| Above target | CHO dose + BG dose with IOB subtracted (IOB from earlier carb boluses only reduces the correction, not below 0; IOB from earlier correction boluses subtracted) | CHO dose + (BG dose − total IOB, floored at 0) | CHO dose + (BG dose − total IOB, floored at 0) |
| At target | CHO dose − correction-derived IOB | CHO dose | CHO dose |
| Below target | CHO dose + negative BG dose − correction-derived IOB | CHO dose + negative BG dose (IOB not subtracted) | CHO dose + negative BG dose − total IOB |

## Results relevant to low glucose

- "Insulin doses were the most variable between BCs when the subsequent BG was below target."
- Example BG 75 mg/dL with 30 g carbs at 2 h: Omnipod 0.15–1.5 U depending on the earlier bolus (leaving ~28 g to ~7.5 g of the 30 g uncovered), 670G 1.5 U (7.5 g uncovered), t:slim 0.53 U (~22 g uncovered). Up to ~10-fold differences (0.15 vs 1.5 U); in one scenario one calculator suggested 1.2 U and another 0.
- IOB at 2 h after the 4 U bolus differed by decay model: 1.35 U (Omnipod, linear) vs 1.0 U (670G) vs 0.97 U (t:slim); ~2.7–2.8 U at 1 h for all.
- The main sources of disagreement were how IOB is combined with the negative correction and the IOB decay curve, not the carb or correction arithmetic.

## Authors' conclusions

- Identical settings give different doses across brands; patients switching pumps may see different glucose patterns and settings may not transfer 1:1.
- Very conservative coverage below target can lead to rebound hyperglycaemia; the authors call for manufacturers to publish full dosing formulas and worked example scenarios.
- Limitations: simulation only, no glucose outcomes, single target value instead of range, no patient factors.

## Notes for Mellis

- **Relevance:** Direct evidence that "reverse correction" is standard in commercial pump calculators (on by default in the 670G, a switch on Omnipod, a prompt on t:slim) but that the size of the reduction differs widely when IOB is present: some subtract both the negative correction and IOB (t:slim, like Trio and AAPS), others only the negative correction (670G). Below target the negative correction is computed to the single target (here 100 mg/dL).
- Practical lesson for a meal while low with IOB: subtracting both negative correction and full IOB can leave a large part of the meal uncovered (here up to ~28 of 30 g), which the authors flag as a rebound-high risk; subtracting neither risks a further low.
- **Evidence level:** bench/simulation comparison of device logic (no clinical outcomes).
