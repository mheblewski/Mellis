---
id: commercial-aid-automatic-corrections
title: "AID comparison of high-side handling: automatic share per step Loop 40%, oref/Trio/AAPS 50%, Control-IQ 60% once/h max 6 U, 780G every 5 min to 120, Omnipod 5 microboluses <=4x adaptive basal, CamAPS none; all calculators add a correction net of IOB incl. automated insulin except CamAPS; guidance: follow calculator, no overrides, site/ketone check for persistent highs"
publisher: "sources as in the per-system files: LoopDocs + LoopKit code"
url: https://doi.org/10.2337/cd21-0083
doi: 10.2337/cd21-0083
licence: "Own summary (Mellis); original: compiled in own words with short quotes; manufacturer material paraphrased"
mode: SUMMARY_ONLY
language: en
retrieved: 2026-10-21
topics: [correction, bolus-calculator, trio, loop, oref, aid, sick-day]
index: true
corpus_v7: correction-up/devices/commercial-aid-automatic-corrections.md
---

*Our summary or notes (Mellis knowledge base), written in our own words with short quotes only; not the original text and not medical advice. Original: https://doi.org/10.2337/cd21-0083.*

# How AID systems correct highs automatically and how their manual bolus calculators count automatic insulin: Loop 40% per 5 min, oref/AAPS/Trio SMB 50%, Control-IQ 60% once per hour (max 6 U), 780G every 5 min to 120 mg/dL, Omnipod 5 microboluses up to 4x adaptive basal, CamAPS/iLet

- **Type:** Compiled device notes (comparison) from manufacturer user guides, FDA summaries, open-source documentation/code and clinical training papers; each row is detailed in its own file in this folder.
- **Journal/year:** sources as in the per-system files: LoopDocs + LoopKit code (2026-10); AndroidAPS docs + code (2026-10); Tandem t:slim X2 Control-IQ User Guide v7.4 (AW-1005628_B); Medtronic MiniMed 780G System User Guide (M072481C001_2, 2025-08-29); Insulet Omnipod 5 user/caregiver guides and HCP brochure (2024); mylife/Ypsomed "Step by Step to myLoop" (CamAPS FX, V03); Beta Bionics meal announcements (2025); Berget C et al., Clin Diabetes 2022;40(2):168-184; Carlson AL et al., Diabetes Technol Ther 2022;24(3):178-189; PANTHER Program tools for Control-IQ (2023) and 780G (2023); Phillip M et al., Endocr Rev 2023 (in corpus).
- **DOI:** Berget 2022 10.2337/cd21-0083; Carlson 2022 10.1089/dia.2021.0319; Phillip 2023 10.1210/endrev/bnac022
- **URL:** see per-system files: loop-correction-and-automatic-bolus.md, androidaps-correction-superbolus-smb.md, tandem-control-iq-automatic-correction.md, medtronic-780g-auto-correction.md, omnipod5-smartadjust-smartbolus-high-glucose.md, camaps-ilet-diabeloop-high-glucose.md
- **Licence:** compiled in own words with short quotes; manufacturer material paraphrased.
- **Saved:** 2026-10-21 for the Mellis RAG corpus.

## Summary in one paragraph

No automated insulin delivery system delivers 100% of a computed correction at once. Open-source loops recompute the need every 5 minutes and give a fixed share of it: Loop's Automatic Bolus 40% per cycle (20-80% with Glucose Based Partial Application), oref1 SMB in AndroidAPS and Trio 50% of insulinReq per cycle, each capped (Loop at 40% of Maximum Bolus per cycle and 2 x Maximum Bolus IOB; oref at 30 minutes of basal per SMB by default and maxIOB). Commercial systems are more conservative per step: Tandem Control-IQ gives one automatic correction of 60% of the computed correction to 110 mg/dL when glucose is predicted >= 180 mg/dL in 30 minutes, at most once per 60 minutes, max 6 U, and never within 60 minutes of a manual bolus; Medtronic 780G gives auto corrections up to every 5 minutes toward 120 mg/dL once auto basal is at maximum (fraction undisclosed); Omnipod 5 gives only 5-minute microboluses up to 400% of its adaptive basal rate; CamAPS FX gives no automatic boluses (basal and "Boost" only); iLet corrects automatically and allows no manual bolus. Every system with a manual bolus calculator still adds a correction when glucose is above target, and all except CamAPS FX subtract insulin on board that includes the insulin the algorithm itself delivered (Loop via the forecast, AAPS via bolus+basal IOB incl. SMB, Control-IQ via IOB "including all basal delivered above and below the programmed basal rate", 780G via active bolus insulin plus a "basal is sufficient" check, Omnipod 5 via IOB that includes AID insulin). CamAPS FX, whose calculator ignores algorithm insulin, recommends bolusing meals without the glucose term. Clinical guidance across systems: give corrections as the system's calculator recommends, never override upward or add fake carbs, reduce or skip late meal boluses, and treat persistent highs (> 250-300 mg/dL for 1.5-3 h, or no fall after a correction) as possible site failure with ketone checks and pen injection.

## Comparison table: automatic correction

| System | How highs are corrected automatically | Fraction of computed need per step | Target | Interval | Caps |
|---|---|---|---|---|---|
| Loop (Automatic Bolus) | automatic bolus from the forecast-based recommendation | 40% (GBPA: 20% near range -> 80% at >= 200 mg/dL); Temp Basal Only about 17% | correction range (late target = midpoint) | every 5 min | <= 40% x Maximum Bolus per cycle; automatic IOB <= 2 x Maximum Bolus; none if forecast dips below range |
| oref1 SMB (AAPS, Trio) | super micro bolus + zero/low temp | 50% of insulinReq (AAPS Auto ISF: 50-100%) | profile target | every 3 min min interval (each loop) | current basal x 30 min (default; 15-120) per SMB; maxIOB |
| Tandem Control-IQ | automatic correction bolus when predicted >= 180 mg/dL at 30 min and basal already increased | 60% of correction (Personal Profile CF, predicted CGM) | 110 mg/dL | max once per 60 min; none within 60 min of any bolus; none in Sleep | 6 U per automatic correction; 50% of TDI per 2 h (Berget) |
| Medtronic 780G | auto correction bolus when max auto basal reached and SG > 120 mg/dL; stronger with meal detection | not disclosed | 120 mg/dL (fixed) | up to every 5 min | none during temp target 150; SmartGuard exit after 7 h at max basal |
| Omnipod 5 | microbolus every 5 min above adaptive basal (60-min prediction) | not a bolus fraction; up to 400% of adaptive basal rate | Target Glucose 110-150 mg/dL | every 5 min | 4 x adaptive basal per hour (e.g. 4 U/h at TDI 48) |
| CamAPS FX | basal only (more aggressive), optional Boost | no automatic boluses | 104 mg/dL default (80-200) | not stated in the sources read | Boost 10 min-12 h 59 min |
| iLet | automatic (meal announcements only) | not published | not user-set | continuous | no manual bolus possible |
| Diabeloop DBLG1 | automatic correction boluses | not published | 110 mg/dL default (100-130) | 5-min decisions | not published |

## Comparison table: manual calculator and automatic insulin

| System | Correction added when high? | Automatic insulin subtracted? | Other details |
|---|---|---|---|
| Loop | yes, implicitly (forecast to correction range) | yes: all IOB (auto boluses, temp basals) in the forecast; currently running temp basal subtracted | meal screen shows full recommendation; giving less lets Automatic Bolus deliver the rest at 40%/cycle |
| AndroidAPS wizard | yes: (BG - top of target)/ISF; optional trend (+3 x delta/ISF) | yes: bolus IOB (incl. SMB) + basal IOB (TBR), separate boxes | wizard percentage (default 100%) multiplies the correction too; Super Bolus option |
| Tandem Control-IQ | yes, to the Personal Profile target, no trend | yes: IOB includes all basal above and below programmed + all boluses (5-h fixed duration); IOB subtracted only from the correction part when above target | auto correction locked 60 min after a manual bolus |
| Medtronic 780G SmartGuard | only if BG/SG >= 120 mg/dL | yes: active (bolus) insulin incl. auto corrections; no correction if basal judged sufficient | algorithm sensitivity, not programmed ISF; bolus not editable; AIT 2-3 h |
| Omnipod 5 SmartBolus | yes, above "Correct Above" (<= 200), with trend adjustment | yes: AID insulin added for hyperglycaemia counts in IOB (Berget) | programmed CF; reverse correction on/off |
| CamAPS FX | yes if the glucose value is included | **no**: calculator active insulin "excludes algorithm-driven insulin" | guide: leave glucose grey for meals; corrections with caution, not too often |
| iLet | no calculator, no manual bolus | n/a | do not announce meals to treat highs |

## When to give a manual correction (cross-system guidance)

- **Follow the system's calculator, do not exceed it:** PANTHER Control-IQ and 780G tools ("Do not override boluses to give more insulin than the pump recommends"; "Do not enter fake carb boluses"), Berget 2022 (parent overriding Omnipod 5 corrections caused hypoglycaemia), Phillip 2023 (in corpus: fictitious carbs, postprandial meal boluses, manual corrections or overriding recommended doses can destabilise AID), Messer 2019 CARES (in corpus).
- **Late meal bolus:** reduce it (enter fewer carbs) or skip it because the system has already increased insulin (PANTHER Control-IQ and 780G; Phillip 2023: half the bolus at 30-60 min, system-recommended correction only after > 60 min).
- **Spacing:** Control-IQ guide: wait about 60 minutes after a bolus before giving more; auto corrections are blocked for 60 min after a manual bolus. CamAPS: corrections "not too often". Omnipod 5 caregiver guide: recheck 2 hours after a correction.
- **Persistent high / site failure:** Phillip 2023 (in corpus): suspect set failure if > 250 mg/dL persists or glucose does not fall >= 50 mg/dL within 1 hour after a correction; correct by pen, because failed pump boluses inflate IOB. 780G: High SG alert at >= 250 mg/dL for 3 h -> check infusion set and ketones. Omnipod 5: > 250 mg/dL -> check ketones; ketones -> bolus per provider + Pod change, recheck in 2 h; no ketones -> correction via Pod, recheck in 2 h, if not lower treat as site failure; Berget: > 250 mg/dL for > 90-120 min after a correction -> Pod change, injection if ketones. PANTHER: > 300 mg/dL for 2 h -> ketones; >= 1.0 mmol/L -> syringe injection + set change. CamAPS: do not rely on the AID system to clear ketones.
- **Injected insulin is invisible** to 780G, Omnipod 5 and Control-IQ IOB; 780G forbids using SmartGuard/Bolus Wizard for a period after an injection; Berget suggests Omnipod 5 Manual Mode for 2-4 h after a pen correction.

## Notes for Mellis

- Adding a correction to a meal bolus is what every manual AID calculator does, so the question is not "whether" but "net of what": all of them except CamAPS FX subtract the insulin the loop has already delivered, and none adds a correction on top of the loop's own pending automatic correction. Trio's own calculator follows the same pattern (separate file in the corpus).
- Partial automatic correction is universal (40-60% per step in open and commercial systems), which is why manual corrections are recommended only as the system calculates them and with 1-2 hour spacing.
- **Evidence level:** device design and labelling, plus expert training guidance; none of these fractions was chosen in a published comparative trial.
