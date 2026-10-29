---
id: cappon-2018-jdst-neural-network-bolus-cgm
title: "Cappon 2018 JDST in silico: neural-network bolus using CGM ROC lowered BGRI by 0.37 vs standard formula, 0.23 vs Scheiner, 0.20 vs Pettus/Edelman (p<0.001); proof of concept only"
publisher: "Journal of Diabetes Science and Technology 2018;12"
authors: "Cappon G, Vettoretti M, Marturano F, Facchinetti A, Sparacino G (University of Padova)"
year: 2018
url: https://pmc.ncbi.nlm.nih.gov/articles/PMC5851237/
doi: 10.1177/1932296818759558
licence: "Own summary (Mellis); original: not under an open licence"
mode: SUMMARY_ONLY
language: en
retrieved: 2026-10-21
topics: [bolus-reduction, hypoglycaemia, cgm]
index: true
corpus_v7: bolus-reduction/abstracts/cappon-2018-jdst-neural-network-bolus-cgm.md
---

*Our summary or notes (Mellis knowledge base), written in our own words with short quotes only; not the original text and not medical advice. Original: https://pmc.ncbi.nlm.nih.gov/articles/PMC5851237/.*

# A Neural-Network-Based Approach to Personalize Insulin Bolus Calculation Using Continuous Glucose Monitoring

- **Authors:** Cappon G, Vettoretti M, Marturano F, Facchinetti A, Sparacino G (University of Padova)
- **Journal/year:** Journal of Diabetes Science and Technology 2018;12(2):265–272
- **DOI:** 10.1177/1932296818759558
- **URL:** https://pmc.ncbi.nlm.nih.gov/articles/PMC5851237/ (PMID 29493356)
- **Licence:** © 2018 Diabetes Technology Society (not under an open licence) → paraphrased summary.
- **Saved:** summary from the PubMed abstract on 2026-10-21 for the Mellis RAG corpus.

## Summary

- Standard formula (SF): carbs/CR + correction (BG − target)/CF − IOB. Earlier fixes for the pre-meal rate of change (ROC) include Scheiner and Pettus/Edelman.
- A neural network was trained to output the optimal meal bolus from the SF inputs plus ROC, body weight, basal rate and insulin sensitivity.
- UVa/Padova simulator, 100 virtual adults, single meal, noise-free, varying meal size, pre-meal glucose and ROC.
- The network reduced the blood glucose risk index by a small but significant amount (p < 0.001): by 0.37 vs SF, 0.23 vs Scheiner and 0.20 vs Pettus/Edelman.
- Preliminary; future work to add sensor noise and behavioural variability.

## Notes for Mellis

- **Relevance:** Shows that a personalised, trend-aware dose beats fixed trend rules in simulation, but gains are small; it does not give a usable rule for "how much to reduce when falling". For concrete rule comparisons see Cappon 2019 and Noaro 2023.
- **Evidence level:** in-silico proof of concept (adults).
