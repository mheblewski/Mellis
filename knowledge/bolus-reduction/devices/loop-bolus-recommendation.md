---
id: loop-bolus-recommendation
title: "Loop (LoopDocs + LoopAlgorithm MIT): forecast over 6 h(+10 min); smallest dose bringing every point to a target that equals the Glucose Safety Limit for the first 50% of DIA then rises to the correction midpoint; any point below the safety limit (guardrail 67-110, typical 74-80 mg/dL) -> 0; meal bolus reduced implicitly"
publisher: "LoopDocs"
url: https://loopkit.github.io/loopdocs/operation/algorithm/bolus/
licence: "Own summary (Mellis); original: LoopDocs has no licence file: paraphrased with short quotes only; short LoopKit/LoopAlgorithm code excerpts under the MIT License (LoopAlgorithm LICENSE.md)"
mode: SUMMARY_ONLY
language: en
retrieved: 2026-10-21
topics: [bolus-reduction, correction, loop, targets, insulin]
index: true
corpus_v7: bolus-reduction/devices/loop-bolus-recommendation.md
---

*Our summary or notes (Mellis knowledge base), written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/operation/algorithm/bolus/.*

# Loop (LoopKit): forecast-based bolus recommendation, Glucose Safety Limit and below-range behaviour

- **Type:** Documentation (LoopDocs, paraphrased with short quotes) + source-code notes (LoopAlgorithm and Loop app)
- **Journal/year:** LoopDocs (LoopKit/loopdocs `main` at bd15f961d1b385d523d1378471e89659af3f99bc, 2026-10-16): pages operation/algorithm/bolus, operation/algorithm/auto-adjust, operation/algorithm/prediction, operation/features/bolus, loop-3/therapy-settings, faqs/algorithm-faqs. Code: LoopKit/LoopAlgorithm `main` at 7ef67243adb0445f5138083c30908a4745eafc83 (2026-10-13): `Sources/LoopAlgorithm/Insulin/DoseMath.swift`, `LoopAlgorithm.swift`, `ManualBolusRecommendation.swift`, `Insulin/ExponentialInsulinModelPreset.swift`; LoopKit/Loop `dev` at 05a7f1bf31432555ef2f378458872be6e37f2b28 (2026-10-20): `Loop/Models/ManualBolusRecommendation.swift`, `Loop/Views/BolusEntryView.swift`, `Loop/View Models/BolusEntryViewModel.swift`
- **DOI:** none
- **URL:** https://loopkit.github.io/loopdocs/operation/algorithm/bolus/ ; https://github.com/LoopKit/LoopAlgorithm/blob/7ef67243adb0445f5138083c30908a4745eafc83/Sources/LoopAlgorithm/Insulin/DoseMath.swift
- **Licence:** LoopDocs: no licence file found in the repo → paraphrased, short quotes only. LoopAlgorithm: MIT ("Loop is released under the MIT license", LICENSE.md, with exceptions for frameworks/graphics); Loop app: MIT per LoopKit. Short code excerpts only.
- **Saved:** notes from LoopDocs markdown sources and GitHub code on 2026-10-21 for the Mellis RAG corpus.

## Key idea

Loop does not add up "carbs/CR + (BG − target)/ISF − IOB". It first builds a glucose forecast (insulin, carbs including the carb entry being typed, momentum, retrospective correction) over the insulin effect duration (6 h + 10 min delay for the rapid-acting presets), and then asks: what is the smallest bolus that brings every future point to its target? Any part of the forecast that sits below target (including a dip below the correction range while a meal is still absorbing) automatically makes the recommended meal bolus smaller. If any forecast point is below the Glucose Safety Limit, the recommendation is 0.

## What LoopDocs says (paraphrased)

- **Safety rule (bolus page, "Bolusing safety feature"):** if the current glucose or any predicted glucose is below the Glucose Safety Limit, Loop will not return a recommended bolus; a recommendation comes back once the minimum predicted glucose rises above the limit.
- **When a bolus is recommended:** when the eventual (end-of-DIA) glucose is above the correction target (feature page: above the high end of the Correction Range) and the active insulin plus any running 30-min temp basal will not cover the predicted rise. The manual recommendation subtracts insulin from the temp basal Loop is currently running and measures the excess to the top of the correction range (the code below uses a time-varying target; see "Contradictions").
- **Slow meals:** for carbs with long absorption time, Loop's initial meal bolus is smaller than grams ÷ CR, sized so the forecast does not dip below the Glucose Safety Limit; the rest is delivered later by temp basal or automatic boluses as absorption is observed (LoopDocs compares it to an "extended/dual wave" bolus).
- **Glucose below the correction range (therapy settings page):** if you ask for a manual recommendation while current glucose is below the bottom of the correction range but above the safety limit, Loop recommends an amount that should keep you above the safety limit. Loop will not add insulin automatically (high temp or automatic bolus) until current glucose is above the bottom of the correction range.
- **Feature page:** "Loop allows you to dip below the correction range but its recommended bolus will be limited by the glucose prediction and the Glucose Safety Limit. Check back once your glucose starts to rise and there will probably be a bigger recommendation." After a meal bolus smaller than recommended, extra insulin below range is manual only and limited to an amount predicted to keep glucose above the Safety Threshold.
- **Glucose Safety Limit (therapy settings):** "Loop will deliver basal and recommend bolus insulin only if your glucose is predicted to be above the Glucose Safety Limit for the next three hours." Guardrails: 67–110 mg/dL selectable (3.7–6.0 mmol/L); recommended range without warning 74–80 mg/dL (4.2–4.4 mmol/L). Correction Range guardrails 87–180 mg/dL (recommended 100–115 mg/dL); Correction and Pre-Meal ranges cannot be set below the Safety Limit.
- **Prediction horizon:** "Loop estimates future glucose over the next 6 hours (DIA)… Loop uses or recommends the smallest amount of insulin that will bring you to your target (Correction Range midpoint) over the whole forecast." The FAQ adds that the nearest 3 hours influence the recommendation more than the later 3 hours, but all 6 hours are considered.
- **Automatic dosing:** a negative recommended dose is always applied as a lower temp basal ("typically to zero"); zero temp if the minimum predicted glucose is below the suspend threshold regardless of eventual glucose. With Automatic Bolus, 40% of the recommendation is delivered each cycle (Glucose Based Partial Application: 20% at lower glucose to 80% at higher glucose).
- **Larger bolus than recommended:** Loop will probably set a 0 U/h temp basal afterwards (the "super-bolus" effect of borrowing basal).
- **Carb absorption model:** remaining carbs are assumed to absorb at a minimum rate of grams ÷ (1.5 × entered absorption time), e.g. 72 g with 4 h → 12 g/h for 6 h.

## What the code does (LoopAlgorithm DoseMath.insulinCorrection)

For each forecast point from now until the end of the insulin effect duration:

1. If the point is below the suspend threshold (= Glucose Safety Limit; if not set, the lower bound of the correction range), return `.suspend` immediately:

   ```swift
   // If any predicted value is below the suspend threshold, return immediately
   guard prediction.quantity >= suspendThreshold else {
       return .suspend(min: prediction)
   }
   ```

2. Compute a time-varying target for that point: equal to the suspend threshold for the first 50% of the insulin effect duration, then rising linearly to the midpoint of the correction range at 100% (`targetGlucoseValue(percentEffectDuration:minValue: suspendThreshold, maxValue: correctionRange.averageValue)`, `useMinValueUntilPercent = 0.5`).
3. Dose needed for that point = (predicted glucose − target at that time) ÷ (ISF × fraction of the insulin effect that will have acted by that time).
4. Keep the smallest positive dose over all points (`minCorrectionUnits`). A point close to its target early in the forecast therefore caps the dose.

Then:

- If both the minimum and the eventual glucose are below the correction range → `.entirelyBelowRange` with a negative dose (to the range midpoint) → manual bolus 0, notice "allGlucoseBelowTarget".
- If eventual glucose is above the correction range → `.aboveRange` with the minimum dose from step 4. If that dose is > 0 and the minimum forecast is below the lower bound of the range, the notice `predictedGlucoseBelowTarget(minGlucose)` is attached (bolus is still offered).
- Otherwise `.inRange` → 0, notice "Predicted glucose is in range."
- Manual bolus = `min(maxBolus, max(0, units))`. If current glucose is below the correction range, the notice `currentGlucoseBelowTarget` is set, but the dose is still the forecast-based one.
- Automatic dosing: if the forecast minimum is below the lower bound of the range while eventual is above, the automatic bolus maximum is set to 0 (`deliveryMax = 0`) and basal stays at scheduled; the temp-basal mode limits the max rate to the neutral basal in the same case. Max active insulin for automation = 2 × max bolus (default multiplier).
- Data freshness: glucose must be < 15 min old (`inputDataRecencyInterval`), otherwise no recommendation.

Insulin model presets (ExponentialInsulinModelPreset): action duration 360 min for rapid-acting adult, rapid-acting child, Fiasp and Lyumjev (Afrezza 300 min); peak 75 min (adult), 65 min (child), 55 min (Fiasp, Lyumjev); delay 10 min. Effect duration = action duration + delay (370 min).

## Messages the user sees (Loop app)

- "No Bolus Recommended — Your glucose is below or predicted to go below your glucose safety limit, X." (suspend case)
- "No Bolus Recommended — Based on your predicted glucose, no bolus is recommended." (in range / entirely below range)
- Notice texts: "Predicted glucose of X is below your glucose safety limit setting."; "Current glucose of X is below correction range."; "Predicted glucose at TIME is X." (forecast dips below target but a bolus is still offered); "Predicted glucose is in range."
- If a new CGM value arrives while on the bolus screen: "Bolus Recommendation Updated".

## Does Loop subtract the below-target part from the meal bolus?

Yes, implicitly. The carb entry being typed is part of the forecast; the recommended meal bolus is the smallest dose that keeps every forecast point at or above its time-varying target (safety limit for the first ~3 h, then rising to the correction-range midpoint), so current low glucose, a falling trend (momentum and retrospective correction), IOB and slow carbs all reduce it. There is no separate "reverse correction" switch. If any forecast point is below the Glucose Safety Limit the recommendation is 0 even with a meal entered; LoopDocs' advice in that situation is to check back when glucose starts rising.

## Contradictions / caveats found

- LoopDocs bolus page says the manual-bolus delta is measured to the top of the correction range; the current LoopAlgorithm code uses the correction-range midpoint (`averageValue`) as the late target and the suspend threshold as the early target; whether eventual glucose must exceed the top of the range is checked against `upperBound`. Treat the docs sentence as a simplification.
- Therapy settings page says "predicted to be above the Glucose Safety Limit for the next three hours"; the code checks every point until the end of the effect duration (about 6 h 10 min). The "3 hours" matches the 50% point where the target starts rising from the safety limit, not the suspend check.

## Notes for Mellis

- **Relevance:** Loop's design is the clearest example of "reduce, don't skip": the meal bolus is reduced exactly by the amount that would make the forecast dip below the safety limit early or below the correction midpoint late, and it is zero only when any forecast point is below the Glucose Safety Limit (typical 74–80 mg/dL). Trio (the owner's system) is different: additive formula plus a single 54 mg/dL forecast gate.
- Loop treats the early part of the forecast (first ~3 h) against the safety limit, not the target: a forecast that dips to, say, 85 mg/dL early with a safety limit of 75 still allows a meal bolus, only smaller.
- **Evidence level:** documentation/code of an open-source AID (no outcome trial of this specific rule in this file).
