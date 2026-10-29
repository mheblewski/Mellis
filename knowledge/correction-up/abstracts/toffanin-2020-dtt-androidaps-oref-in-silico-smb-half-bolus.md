---
id: toffanin-2020-dtt-androidaps-oref-in-silico-smb-half-bolus
title: "Toffanin et al., Diabetes Technol Ther 2020: in silico AndroidAPS (oref) - best with SMB + half meal bolus (TIR 91 %, 54-70 <1 %); +/-50 % bolus errors did not change TIR or lows"
publisher: "Diabetes Technology & Therapeutics 2020;22"
authors: "Toffanin C, Kozak M, Sumnik Z, Cobelli C, Petruzelkova L"
year: 2020
url: https://pubmed.ncbi.nlm.nih.gov/31769699/
doi: 10.1089/dia.2019.0375
licence: "Own summary (Mellis); original: abstract only"
mode: SUMMARY_ONLY
language: en
retrieved: 2026-10-21
topics: [correction, hypoglycaemia, oref, smb, aid, targets, insulin]
index: true
corpus_v7: correction-up/abstracts/toffanin-2020-dtt-androidaps-oref-in-silico-smb-half-bolus.md
---

*Our summary or notes (Mellis knowledge base), written in our own words with short quotes only; not the original text and not medical advice. Original: https://pubmed.ncbi.nlm.nih.gov/31769699/.*

# In Silico Trials of an Open-Source Android-Based Artificial Pancreas: A New Paradigm to Test Safety and Efficacy of Do-It-Yourself Systems

- **Authors:** Toffanin C, Kozak M, Sumnik Z, Cobelli C, Petruzelkova L
- **Journal/year:** Diabetes Technology & Therapeutics 2020;22(2):112-120
- **DOI:** 10.1089/dia.2019.0375
- **URL:** https://pubmed.ncbi.nlm.nih.gov/31769699/
- **Licence:** paraphrased (abstract only)
- **Saved:** summary from the PubMed/Europe PMC abstract on 2026-10-21 for the Mellis RAG corpus.

## What it is

The only in silico trial found of the oref (OpenAPS) algorithm as implemented in AndroidAPS - the same algorithm family as Trio - run on the FDA-accepted UVA/Padova type 1 diabetes simulator.

## Methods

- Five AndroidAPS configurations differing in aggressiveness and user interaction (with/without SMB microboluses, full vs partial meal bolus), each with insulin sensitivity varied +/-30 %.
- Best configurations then stress-tested: meal bolus over- and under-estimated by 50 %, bolus 15 min before the meal, and late bolus 15 min after.

## Results relevant to correction boluses

- **Best results with SMB enabled and only half of the calculated meal bolus given up front**: mean glucose 131 mg/dL (SD 27), TIR 91 %, time 54-70 mg/dL <1 %, LBGI <1.
- With SMB active, a meal bolus 50 % too large or 50 % too small, and a late bolus, **did not change TIR or time 54-70 mg/dL**.
- Implication for Mellis: under oref with SMB the loop fills the gap of a partial bolus; there is no simulated benefit from giving more than the calculated dose, and the best configuration gave less up front.

## Limitations

- Simulation (virtual adults/children of the UVA/Padova simulator), not real patients; abstract-level details (which age cohort, how SMB settings were set, and whether a correction was added are not stated in the abstract); AndroidAPS 2019 version.
