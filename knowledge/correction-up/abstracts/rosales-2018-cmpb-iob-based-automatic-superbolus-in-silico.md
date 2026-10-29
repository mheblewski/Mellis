---
id: rosales-2018-cmpb-iob-based-automatic-superbolus-in-silico
title: "Rosales et al., Comput Methods Programs Biomed 2018: in silico IOB-based super-bolus - 75 g meal euglycaemia 81.9 to 89.5 %, hypoglycaemia 5.9 to 1.0 %"
publisher: "Computer Methods and Programs in Biomedicine 2018;159:145-158"
authors: "Rosales N, De Battista H, Vehí J, Garelli F"
year: 2018
url: https://pubmed.ncbi.nlm.nih.gov/29650309/
doi: 10.1016/j.cmpb.2018.03.007
licence: "Own summary (Mellis); original: abstract only"
mode: SUMMARY_ONLY
language: en
retrieved: 2026-10-21
topics: [correction, hypoglycaemia]
index: true
corpus_v7: correction-up/abstracts/rosales-2018-cmpb-iob-based-automatic-superbolus-in-silico.md
---

*Our summary or notes (Mellis knowledge base), written in our own words with short quotes only; not the original text and not medical advice. Original: https://pubmed.ncbi.nlm.nih.gov/29650309/.*

# Open-Loop Glucose Control: Automatic IOB-Based Super-Bolus Feature for Commercial Insulin Pumps

- **Authors:** Rosales N, De Battista H, Vehí J, Garelli F
- **Journal/year:** Computer Methods and Programs in Biomedicine 2018;159:145-158
- **DOI:** 10.1016/j.cmpb.2018.03.007
- **URL:** https://pubmed.ncbi.nlm.nih.gov/29650309/
- **Licence:** paraphrased (abstract only)
- **Saved:** summary from the PubMed/Europe PMC abstract on 2026-10-21 for the Mellis RAG corpus.

## What it is

In silico study of an automatic "super-bolus": the pump adds extra insulin to the meal bolus and cuts basal for a time computed from a two-compartment insulin-on-board (IOB) model, restoring basal when IOB returns to its basal level.

## Methods

- 30 virtual patients (UVA/Padova-type simulation); single-meal (75 g and 100 g) and single-day scenarios with intra-patient variability; compared with standard bolus treatment.

## Results relevant to correction boluses

- 75 g meal: time in euglycaemia 81.9 % -> 89.5 %; time in hypoglycaemia 5.92 % -> 0.97 % (p = 0.008).
- 100 g meal: 75.1 % -> 85.5 %; hypoglycaemia 9.5 % -> 1.85 % (p = 0.014).
- Single day: hypoglycaemia 9.57 % -> 4.21 % (p = 0.028); euglycaemia 79.5 % -> 86.3 %.
- Key design point: **extra up-front insulin was safe in simulation only because it was paired with an IOB-matched basal cut** (total insulin roughly conserved), and benefit was largest for large, high-GI meals.

## Limitations

- Simulation only, open loop (no AID); abstract-level; the hypoglycaemia in the comparator depends on the simulator's standard-therapy settings.
