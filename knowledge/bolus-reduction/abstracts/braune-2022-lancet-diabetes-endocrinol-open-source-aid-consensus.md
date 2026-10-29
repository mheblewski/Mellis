---
id: braune-2022-lancet-diabetes-endocrinol-open-source-aid-consensus
title: "Braune et al., Lancet Diabetes Endocrinol 2022: open-source AID consensus - enter all carbs incl. hypo treatment; bolus before meals; fewer carbs after long suspension; DIA 5-7 h; target 110-120 mg/dL"
publisher: "Lancet Diabetes & Endocrinology 2022;10"
authors: "Braune K, Lal RA, Petruželková L, Scheiner G, Winterdijk P, Schmidt S, Raimond L, Hood KK, Riddell MC, Skinner TC, Raile"
year: 2022
url: https://pmc.ncbi.nlm.nih.gov/articles/PMC8720075/
doi: 10.1016/S2213-8587(21
licence: "Own summary (Mellis); original: PMC author manuscript, available for text mining and fair use; publisher copyright"
mode: SUMMARY_ONLY
language: en
retrieved: 2026-10-21
topics: [bolus-reduction, hypoglycaemia, rescue-carbs, aid, targets, insulin]
index: true
corpus_v7: bolus-reduction/abstracts/braune-2022-lancet-diabetes-endocrinol-open-source-aid-consensus.md
---

*Our summary or notes (Mellis knowledge base), written in our own words with short quotes only; not the original text and not medical advice. Original: https://pmc.ncbi.nlm.nih.gov/articles/PMC8720075/.*

# Open-source automated insulin delivery: international consensus statement and practical guidance for health-care professionals

- **Authors:** Braune K, Lal RA, Petruželková L, Scheiner G, Winterdijk P, Schmidt S, Raimond L, Hood KK, Riddell MC, Skinner TC, Raile K, Hussain S; OPEN International Healthcare Professional Network and OPEN Legal Advisory Group
- **Journal/year:** Lancet Diabetes & Endocrinology 2022;10(1):58-74
- **DOI:** 10.1016/S2213-8587(21)00267-9
- **URL:** https://pmc.ncbi.nlm.nih.gov/articles/PMC8720075/ (author manuscript)
- **Licence:** paraphrased (PMC author manuscript, available for text mining and fair use; publisher copyright)
- **Saved:** summary from the PMC author manuscript on 2026-10-21 for the Mellis RAG corpus (paraphrased; short quotes only).

## What it is

The first international consensus on open-source ("do-it-yourself") AID systems - OpenAPS, AndroidAPS, Loop/FreeAPS (Trio is the later successor of FreeAPS X and uses the OpenAPS oref algorithm). It reviews evidence, technology, ethics and law, and gives practical clinical guidance in panels: a glossary of customisable settings, practical scenarios and advice (panel 3), safety parameters (panel 4) and temporary setting changes (panel 5).

## Points relevant to meals and hypoglycaemia (panel 3 "practical scenarios and advice" and the settings section)

- **Carbohydrate entry:** every carbohydrate eaten, explicitly including carbs taken to treat hypoglycaemia, should always be entered into the open-source system (so the algorithm's predictions include them). This differs from commercial-AID advice that warns against entering "fictitious" carbs.
- **Bolus timing:** as with conventional therapy, bolus ahead of the meal. A late bolus can make the system raise basal or give a correction bolus first, which combined with the meal bolus can cause hypoglycaemia.
- **Hypoglycaemia:** like commercial AID users, open-source users may treat lows with fewer carbohydrates than usual if insulin delivery has been suspended for a prolonged time (no gram amount given).
- **Duration of insulin action:** open-source systems typically use 5-7 h for rapid-acting insulin, longer than the 2-5 h active insulin time in most pumps and commercial systems; settings should reflect true pharmacodynamics so insulin on board is estimated accurately.
- **Targets:** start with an algorithm target of about 110-120 mg/dL (6.1-6.7 mmol/L), optimise first for hypoglycaemia prevention and tighten gradually; personalise. Some users choose stronger carb ratios on AID because the system lowers basal when a low is predicted.
- **Meal features (glossary):** Loop lets the user set carb absorption time per meal (30 min to 8 h; about 3 h suggested for large, low-GI or high-fat meals and gastroparesis); OpenAPS "advanced meal assist" sets a high temp basal quickly after a meal bolus if carbs are entered reliably; super-microboluses (SMB) bring basal insulin forward; unannounced-meal mode can cause post-meal highs unless diet is strict.
- **Exercise (panel 3):** temp target of at least 126 mg/dL (7 mmol/L) and about 50 % less overall insulin for prolonged aerobic activity; carbs eaten 5-90 min before exercise without a bolus can still raise IOB (the algorithm responds) - small amounts just before or during exercise are preferable.
- **Children:** at least 20 % of open-source AID users are 19 or younger; caregivers often choose these systems for remote monitoring and remote control; the child's welfare, assent and engagement should be considered.

## Notes for Mellis

- **Relevance to reducing a meal bolus when falling / predicted low:** moderate for Trio users. Three rules transfer directly: log rescue carbs in the system (so oref's prediction and IOB-based dosing account for them), bolus before the meal rather than after, and use smaller rescue doses after a long suspension. There is no advice on reducing the meal bolus when glucose is low or falling.
- **Population:** all ages; specific paragraph on children and adolescents.
- **AID systems:** OpenAPS, AndroidAPS, Loop/FreeAPS (open-source); comparison table with commercial systems.
- **Evidence level:** international expert consensus with practical guidance; evidence base is real-world observational and in-silico, no RCTs at the time.
