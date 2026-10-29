---
id: loop-correction-and-automatic-bolus
title: "Loop high side (LoopDocs + LoopKit MIT): forecast-based correction incl. all IOB; Automatic Bolus 40% per 5-min cycle (GBPA 20% -> 80% at >=200 mg/dL, Temp Basal ~17%); <=40% x Maximum Bolus per cycle, automatic IOB <= 2 x Maximum Bolus; meal screen shows full amount, remainder auto-delivered"
publisher: "LoopDocs"
url: https://loopkit.github.io/loopdocs/loop-3/features/#glucose-based-partial-application-gbpa
licence: "Own summary (Mellis); original: LoopDocs has no licence file: paraphrased with short quotes only; short LoopKit/LoopAlgorithm code excerpts under the MIT License (LoopAlgorithm LICENSE.md)"
mode: SUMMARY_ONLY
language: en
retrieved: 2026-10-21
topics: [correction, loop, settings]
index: true
corpus_v7: correction-up/devices/loop-correction-and-automatic-bolus.md
---

*Our summary or notes (Mellis knowledge base), written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/loop-3/features/#glucose-based-partial-application-gbpa.*

# Loop (LoopKit): high-side behaviour - forecast-based correction, Automatic Bolus 40% per cycle, Glucose Based Partial Application 20-80%, 2 x Maximum Bolus IOB cap, manual bolus while auto-bolusing

- **Type:** Documentation (LoopDocs, paraphrased with short quotes) + source-code notes (LoopAlgorithm and Loop app)
- **Journal/year:** LoopDocs (LoopKit/loopdocs `main` at bd15f961d1b385d523d1378471e89659af3f99bc, 2026-10-16): pages operation/features/bolus, operation/features/carbs ("Automatic Bolus"), operation/algorithm/bolus, operation/algorithm/auto-adjust, operation/loop/close-loop, loop-3/settings, loop-3/features ("Glucose Based Partial Application"), loop-3/therapy-settings ("Maximum Bolus"), faqs/algorithm-faqs ("Manual Dose", "Automatic Dose"), version/code-custom-edits, nightscout/remote-commands. Code: LoopKit/LoopAlgorithm `main` at 7ef67243adb0445f5138083c30908a4745eafc83 (2026-10-12): `Sources/LoopAlgorithm/LoopAlgorithm.swift` (`defaultBolusPartialApplicationFactor`, `recommendAutomaticDose`), `Sources/LoopAlgorithm/Insulin/DoseMath.swift` (`asPartialBolus`); LoopKit/Loop `dev` at 05a7f1bf31432555ef2f378458872be6e37f2b28 (2026-10-20): `Loop/Models/LoopConstants.swift`, `Loop/Models/GlucoseBasedApplicationFactorStrategy.swift`, `Loop/Managers/LoopDataManager.swift`
- **DOI:** none
- **URL:** https://loopkit.github.io/loopdocs/loop-3/features/#glucose-based-partial-application-gbpa ; https://loopkit.github.io/loopdocs/faqs/algorithm-faqs/ ; https://github.com/LoopKit/Loop/blob/05a7f1bf31432555ef2f378458872be6e37f2b28/Loop/Models/GlucoseBasedApplicationFactorStrategy.swift
- **Licence:** LoopDocs: no licence file found in the repo, so paraphrased with short quotes only. LoopAlgorithm and Loop app: MIT (LoopKit). Short code excerpts only, the rest in own words.
- **Saved:** notes from LoopDocs markdown sources and GitHub code on 2026-10-21 for the Mellis RAG corpus. Companion to `devices/loop-bolus-recommendation.md` in the bolus-reduction corpus, which covers the low side (Glucose Safety Limit, time-varying target, suspend); this file covers the high side only.

## Summary in one paragraph

Loop never adds a separate "correction term" to a meal bolus. Its manual bolus recommendation is the smallest dose that brings the whole 6-hour forecast (insulin on board including every automatic bolus and temp basal, the carbs being typed, momentum and retrospective correction) down to the correction range, so a high current glucose or a forecast that ends above range simply makes the recommended dose larger, and insulin already delivered automatically makes it smaller. With the optional Automatic Bolus dosing strategy Loop recomputes that same recommendation every 5 minutes and delivers only 40% of it as an automatic bolus (constant `bolusPartialApplicationFactor = 0.4`), capped at 40% of Maximum Bolus per cycle and by an automatic IOB ceiling of 2 x Maximum Bolus; with the Loop 3.4+ experiment Glucose Based Partial Application (GBPA) the fraction slides from 20% (glucose at or below the correction range's lower bound + 10 mg/dL) to 80% (at 200 mg/dL and above). Temp Basal Only delivers about 17% of the recommendation per 5 minutes. When the user opens the meal bolus screen, Loop shows the full recommended amount, not the 40% fraction; if the user gives less (or saves carbs without bolusing), Automatic Bolus will deliver the remainder in 40% steps over the next cycles. A manual bolus can exceed the automatic IOB ceiling, after which no further automatic dosing happens until IOB falls below 2 x Maximum Bolus.

## Manual recommendation on the high side (what changes compared with the low side)

- **When a bolus is recommended (LoopDocs, bolus algorithm page):** when the eventual glucose is above the correction target and active insulin plus any running 30-minute temp basal will not cover the predicted excursion. The feature page phrases it as: eventual glucose (end of insulin action) above the high end of the Correction Range and the forecast above the Glucose Safety Limit.
- **Two differences from the automatic dose (LoopDocs):** for the manual recommendation, (1) the insulin from the temp basal Loop is currently running is subtracted, and (2) the delta is measured to the top of the correction range rather than the range average. (The LoopAlgorithm code uses a time-varying target that ends at the correction-range midpoint; see the companion low-side file for this contradiction.)
- **Everything is in the forecast:** the correction for a high current glucose is not computed from current BG minus target. A rising glucose adds to the forecast through momentum (slope of the last 3 CGM readings, blended into the next 20 minutes) and retrospective correction; IOB from earlier automatic boluses and high temp basals lowers the forecast. There is therefore no way for Loop to "double count" its own automatic insulin in a manual recommendation.
- **Meals while high (LoopDocs, close-loop page):** "If glucose is trending up, Loop may be trying to add a correction to the meal dose." After the meal bolus, "Do not be surprised if Loop immediately suspends basal." A bolus larger than recommended is typically followed by a 0 U/h temp basal (borrowing future basal, a "super-bolus" effect).
- **Cap:** the manual recommendation is limited to Maximum Bolus (`min(maxBolus, max(0, units))`); a typed amount above Maximum Bolus is refused with a warning. LoopDocs suggests Maximum Bolus no higher than the typical large meal bolus, e.g. 9 or 9.9 U rather than 10 U to avoid typing 10 instead of 1.0.

## Automatic Bolus dosing strategy: how much of the needed correction is delivered automatically

- **Default fraction 40%:** "Automatic Bolus" provides 40% of the recommended bolus as an immediate bolus at each loop cycle (each new CGM reading, typically every 5 minutes); Temp Basal Only provides "no more than 17% (per 5 minute interval)" of the recommendation as a 30-minute temp basal. Code: `LoopConstants.bolusPartialApplicationFactor = 0.4` (Loop app) and `LoopAlgorithm.defaultBolusPartialApplicationFactor = 0.4`; the factor is multiplied by `timeBasedDoseApplicationFactor = min(1, minutes since last loop / 5)` so that loops closer together than 5 minutes give proportionally less.
- **How fast 40% converges (LoopDocs simplified example, 1 U recommended, prediction then exact):** cumulative 0.40 U at 0 min, 0.65 U at 5 min, 0.80 U at 10 min, 0.90 U at 15 min, 0.95 U at 20 min. With 20%: 0.20, 0.35, 0.50, 0.60, 0.70, 0.75, 0.80 U at 0-30 min; with 80%: 0.80, 0.95, 1.00 U by 10 min.
- **Per-cycle caps (LoopDocs FAQ + code):** automatic dose = min(dose, 2 x Maximum Bolus - current IOB); the automatic bolus is the application factor x that dose, and never more than application factor x Maximum Bolus per cycle (e.g. Maximum Bolus 5 U: at most 2 U per automatic bolus with 40%), so a big correction is spread over many 5-minute cycles. Code: `maxAutomaticBolus = min(iobHeadroom, maxBolus * min(effectiveBolusApplicationFactor, 1.0))`.
- **Maximum automatic IOB = 2 x Maximum Bolus** (both Temp Basal Only and Automatic Bolus). "The user can exceed Maximum Automatic IOB with a manual bolus"; afterwards no additional automatic dosing occurs until IOB drops below the limit, but scheduled basal continues while the prediction is above range. A documented code customisation raises the multiplier (e.g. 3 x Maximum Bolus).
- **No automatic correction while low or dipping:** Loop gives no high temp basal or automatic bolus until current glucose is above the lower bound of the correction range; if the forecast dips below the correction range before ending above it, the automatic bolus maximum is set to 0 and scheduled basal resumes (`deliveryMax = 0` in `recommendAutomaticDose`). A manual recommendation is still available in that state.
- **Decreases are always temp basal:** a negative recommended dose is applied as a lower temp basal (often 0 U/h), whichever dosing strategy is selected.
- **Changing the fraction:** LoopDocs describes a code customisation of `bolusPartialApplicationFactor` (default 0.4, advice: change by 0.1 at a time, keep below 1); since Loop 3.4.0 the in-app alternative is GBPA.

## Glucose Based Partial Application (GBPA, Loop 3.4.0+, Algorithm Experiments, off by default)

- Only used with Automatic Bolus; "does not affect the recommended dose, only how quickly the recommended dose is automatically delivered". Proposed as Loop PR 1988; replaces the community "switcher patch" that moved between Automatic Bolus at high glucose and Temp Basal Only at low glucose.
- **Rule (LoopDocs + code):** application factor = 20% when glucose is at or below the correction range's lower value (including overrides) + 10 mg/dL (0.6 mmol/L); rises linearly to 80% at 200 mg/dL (11.1 mmol/L); 80% above 200 mg/dL. Code constants: `minPartialApplicationFactor = 0.20`, `maxPartialApplicationFactor = 0.80`, `minGlucoseDeltaSlidingScale = 10.0` mg/dL, `maxGlucoseSlidingScale = 200.0` mg/dL; factor = 0.20 + max(0, BG - (lower bound + 10)) x 0.60 / (200 - (lower bound + 10)), capped at 0.80.
- **Worked example (own arithmetic):** correction range 100-115 mg/dL -> sliding scale starts at 110 mg/dL. At 155 mg/dL the factor is 0.20 + 45 x 0.60/90 = 0.50 (50%); at 200 mg/dL and above it is 80%; at 110 mg/dL or lower it is 20%.
- The 20% floor was chosen to resemble Temp Basal Only (about 17% per 5 minutes) at lower glucose.

## Manual bolus while Automatic Bolus is active

- **Meal bolus screen shows the full amount (LoopDocs, carbs page):** with Automatic Bolus, users "should still prebolus and/or bolus for meals"; the Recommended value on the Meal Bolus screen is the full recommendation, "not the 40% partial bolus delivered automatically". Entering less than recommended and tapping Deliver, or "Save Without Bolusing", tells Loop to deliver the remaining recommended insulin automatically, 40% per cycle. LoopDocs warns that carb entry alone leads to insulin delivery (faster with Automatic Bolus than with Temp Basal Only).
- **No automatic dosing during a bolus request:** while a bolus command is in progress Loop does not generate new dosing recommendations (code: `lastRequestedBolus` guard, warning `.bolusInProgress`). After a manual bolus, the next cycle's forecast includes it as IOB, so the automatic recommendation shrinks or becomes a low temp.
- **Remote commands (LoopDocs, Nightscout remote):** sending remote carbs and then a remote bolus can give too much insulin because Loop already starts dosing for the carbs (max temp basal, or a percentage of the recommendation with Automatic Bolus) before the bolus arrives; if both are sent, send the bolus first, then the carbs. "Typically, sending a remote carb entry alone is sufficient" for Loop to dose for the carbs.

## What LoopDocs does and does not say about manual corrections

- Starting advice: begin closed loop with Temp Basal Only and a conservative maximum basal rate (experienced users at most 3-4 x average basal), switch to Automatic Bolus only after getting comfortable; set the correction range slightly higher at first.
- Loop recalculates the recommendation every 5 minutes, but "Loop will not give an alert when a bolus is being recommended"; the bolus entry tool must be opened to see it (the Nightscout Loop pill also shows it). The user can accept or override it; LoopDocs' meal advice is to consider why Loop suggests more or less than expected (a rising trend adds a correction, a falling trend reduces the dose).
- No explicit "don't fight the loop" or "rage bolus" guidance and no ketone/site-failure algorithm were found in LoopDocs at this commit (searched for stack, rage, ketone, occlusion, manual correction). The only bad-site remark is that sites, illness or wrong basal confound carb-absorption (ICE) analysis.

## Notes for Mellis

- **Relevance to "add a correction on the meal card?":** Loop's recommendation always contains the correction implicitly, and it already subtracts all automatic insulin because it is forecast-based. A card that adds a separate correction on top of a Loop-style recommendation would double count.
- **Fraction delivered automatically:** Loop's default automatic share is 40% of the remaining need per 5-minute cycle (GBPA 20-80% by glucose), versus oref/Trio SMB 50% of insulinReq per cycle; both recompute every cycle, so the cumulative automatic delivery approaches the full need within about 15-20 minutes unless capped by Maximum Bolus, the per-cycle cap or the IOB ceiling.
- **Evidence level:** documentation and code of an open-source AID; no outcome trial of the 40% or GBPA settings in this file.
