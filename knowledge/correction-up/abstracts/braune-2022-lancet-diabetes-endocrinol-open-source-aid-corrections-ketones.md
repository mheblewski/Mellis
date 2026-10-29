---
id: braune-2022-lancet-diabetes-endocrinol-open-source-aid-corrections-ket
title: "Braune et al., Lancet Diabetes Endocrinol 2022 (open-source AID consensus), corrections: log pen insulin in the system; after set failure inject the undelivered IOB; ketones: set change + profile 30-200 % until <0.6 mmol/L; DIA 5-7 h; no need to stop AID when ill"
publisher: "Lancet Diabetes & Endocrinology 2022;10"
authors: "Braune K, Lal RA, Petruželková L, Scheiner G, Winterdijk P, Schmidt S, Raimond L, Hood KK, Riddell MC, Skinner TC, Raile"
year: 2022
url: https://pmc.ncbi.nlm.nih.gov/articles/PMC8720075/
doi: 10.1016/S2213-8587(21
licence: "Own summary (Mellis); original: PMC author manuscript, publisher copyright; short quotes only"
mode: SUMMARY_ONLY
language: en
retrieved: 2026-10-21
topics: [correction, aid, sick-day, ketones, insulin]
index: true
corpus_v7: correction-up/abstracts/braune-2022-lancet-diabetes-endocrinol-open-source-aid-corrections-ketones.md
---

*Our summary or notes (Mellis knowledge base), written in our own words with short quotes only; not the original text and not medical advice. Original: https://pmc.ncbi.nlm.nih.gov/articles/PMC8720075/.*

# Open-source automated insulin delivery: international consensus statement and practical guidance for health-care professionals (summary of the correction, infusion-set-failure, ketone, sick-day and insulin-action advice)

- **Authors:** Braune K, Lal RA, Petruželková L, Scheiner G, Winterdijk P, Schmidt S, Raimond L, Hood KK, Riddell MC, Skinner TC, Raile K, Hussain S; OPEN International Healthcare Professional Network and OPEN Legal Advisory Group
- **Journal/year:** Lancet Diabetes & Endocrinology 2022;10(1):58-74
- **DOI:** 10.1016/S2213-8587(21)00267-9
- **URL:** https://pmc.ncbi.nlm.nih.gov/articles/PMC8720075/ (author manuscript)
- **Licence:** paraphrased (PMC author manuscript, publisher copyright; short quotes only)
- **Saved:** summary from the PMC author manuscript (Panel 4 settings glossary, Panel 5 practical scenarios, Settings and Safety sections) on 2026-10-21 for the Mellis RAG corpus. A separate summary of the same paper's meal and hypoglycaemia advice exists (braune-2022-lancet-diabetes-endocrinol-open-source-aid-consensus.md); this file covers the high-glucose side only.

## What it is

The first international consensus on open-source ("do-it-yourself") AID - OpenAPS, AndroidAPS and Loop/FreeAPS; Trio is the later successor of FreeAPS X/iAPS and uses the OpenAPS oref algorithm. Panel 5 ("practical scenarios and advice") gives short rules for situations clinicians meet; Panel 4 explains settings such as maximum IOB, super-microbolus (SMB) and the insulin activity model.

## Points relevant to correcting high glucose

- **Correction insulin given outside the pump (Panel 5):** if insulin is injected (or inhaled) to treat hyperglycaemia without telling the system, the system sees a glucose lower than it predicted and becomes less aggressive in its own dosing; if the system supports it, the injected insulin should be entered into it. Manual injections "can be recorded in the AID system".
- **Confirmed infusion set failure (Panel 5):** when correction insulin was not delivered because the set failed, the user can inject the amount of insulin that the system believes it has delivered but that never reached the body (the "undelivered" IOB).
- **Ketosis (Panel 5):** standard principles apply - high ketones need additional corrective insulin; change the infusion set and reservoir (or the patch pump); the user may switch to a raised profile ("30-200 %", i.e. a percentage profile/override) until blood ketones are below 0.6 mmol/L (or urine ketones are no longer "++").
- **Sick days (Panel 5):** stopping the AID system during illness is not necessary, provided a set failure has been considered and managed; profiles can be switched up (insulin resistance) or down (illness that lowers hepatic glucose output).
- **Late meal boluses (Panel 5):** a late bolus can make the system raise basal or give a correction (SMB) first, and the combination with the meal bolus can produce hypoglycaemia - bolus before the meal.
- **Insulin action (Panel 5 and Settings):** open-source systems typically use a duration of insulin action of 5-7 h for rapid-acting insulin, unlike the 2-5 h "active insulin time" of most pumps and commercial systems; the model should reflect true pharmacodynamics because an accurate model "can help to prevent insulin stacking and enable safe correction treatments". Some commercial systems allow an unrealistically short active insulin time, which permits aggressive dosing.
- **Safety limits (Panel 4):** maximum IOB (OpenAPS/AndroidAPS), maximum basal rate and maximum bolus cap what the algorithm can add; SMB can bring basal insulin forward for faster action.
- **Loop not running (Panel 1 and Safety):** open-source systems enact short (15-60 min) temporary basals or microboluses, so if connectivity is lost the user returns to the pump's scheduled basal - "baseline risk" of conventional pump therapy - and must dose manually.
- **Carbohydrates:** all carbohydrates eaten, including hypo treatments, should be entered.

## Notes for Mellis

- **Relevance (high for Trio):** this is the only consensus that addresses open-source loops directly. For a Trio meal card it implies: (1) a correction is fine when computed by the system's own calculator against its net IOB with a realistic 5-7 h insulin curve; (2) insulin given by pen must be logged in Trio as external insulin so oref counts it in IOB, otherwise oref reduces its own dosing only after the glucose falls, and the two sources can stack; (3) after a confirmed site failure, the "missing" insulin is the IOB the system thinks it delivered, which can be replaced by injection; (4) ketones are treated with extra corrective insulin, a set change and a raised profile until ketones < 0.6 mmol/L, rather than by stopping the loop.
- **Difference from commercial-AID guidance:** commercial consensus (Phillip 2023, Polish paediatric HCL 2024) advises switching automation off for 2-4 h after a pen correction; the open-source consensus instead advises recording the injection in the system.
- **Population:** all ages; caregivers of children are a large user group (at least 20 % of users are 19 or younger).
- **AID systems:** OpenAPS, AndroidAPS, Loop/FreeAPS (open-source).
- **Evidence level:** [E] international expert consensus; evidence base observational and in-silico.
