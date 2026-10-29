---
id: trio-bolus-calculator-forecast-code
title: "Trio source (main 0b29cd5, v1.0.2): calculator = (BG-target)/ISF + 15-20 min delta/ISF + (COB+carbs)/CR - IOB, all negatives subtracted before the percentage; forced to 0 if BG <54, oref minPredBG <54 (simulated with typed meal) or loop >15 min old; carbsReq not used by the calculator"
publisher: "nightscout/Trio, branch `main` at commit 0b29cd53415e7f0e668677749cad8daf81c68c2f"
url: https://github.com/nightscout/Trio/blob/0b29cd53415e7f0e668677749cad8daf81c68c2f/Trio/Sources/Services/BolusCalculator/BolusCalculationManager.swift
licence: "Own text (Mellis); short code excerpts from nightscout/Trio and openaps/oref0 under the MIT License"
licence_url: https://opensource.org/license/mit
mode: SUMMARY_ONLY
language: en
retrieved: 2026-10-21
topics: [bolus-reduction, hypoglycaemia, rescue-carbs, bolus-calculator, trio, loop, oref]
index: true
corpus_v7: bolus-reduction/devices/trio-bolus-calculator-forecast-code.md
---

*Our summary or notes (Mellis knowledge base), written in our own words with short quotes only; not the original text and not medical advice. Original: https://github.com/nightscout/Trio/blob/0b29cd53415e7f0e668677749cad8daf81c68c2f/Trio/Sources/Services/BolusCalculator/BolusCalculationManager.swift.*

# Trio bolus calculator: how current glucose, trend, IOB and the oref forecast (minPredBG) enter the recommendation (source-code notes)

- **Type:** Source-code notes (open-source AID app for iOS, oref-based)
- **Journal/year:** nightscout/Trio, branch `main` at commit 0b29cd53415e7f0e668677749cad8daf81c68c2f (2026-10-07, release v1.0.2). Files: `Trio/Sources/Services/BolusCalculator/BolusCalculationManager.swift` (last changed bf2d531, 2026-09-13), `Trio/Sources/Modules/Treatments/TreatmentsStateModel.swift`, `Trio/Sources/Modules/Treatments/View/PopupView.swift`, `Trio/Sources/Modules/Treatments/View/TreatmentsRootView.swift`, `Trio/Sources/APS/OpenAPS/OpenAPS.swift`, `Trio/Sources/APS/OpenAPSSwift/DetermineBasal/DosingEngine.swift`, `Model/Helper/Determination+helper.swift`, `TrioTests/BolusCalculatorTests/BolusCalculatorTests.swift`, `TrioTests/AlgorithmSuggestedBolusTests.swift`
- **DOI:** none
- **URL:** https://github.com/nightscout/Trio/blob/0b29cd53415e7f0e668677749cad8daf81c68c2f/Trio/Sources/Services/BolusCalculator/BolusCalculationManager.swift
- **Licence:** MIT (LICENSE.txt in the repo, "Copyright (c) 2021 Ivan Valkou"; the GitHub API also reports MIT). Only short code excerpts are quoted; the rest is a description in our own words.
- **Saved:** notes from the GitHub source (raw files at the commit above) on 2026-10-21 for the Mellis RAG corpus. The user-facing Trio documentation of the same calculator is already in the corpus (Trio docs, usage/features/bolus-calculator and configuration pages); this file covers only what the code does with low/falling glucose and the forecast.

## Summary in one paragraph

Trio's bolus calculator is a classic additive formula, not a forecast-based dose: (current BG − target)/ISF + (glucose change over the last ~15–20 min)/ISF + (COB + new carbs)/CR − IOB. All terms can be negative, so a glucose below target, a falling trend and positive IOB are all subtracted from the meal insulin ("reverse correction" is built in and cannot be switched off). The oref forecast is used only as a safety gate: if the current glucose or the oref `minPredBG` is below 54 mg/dL (or the last loop is older than 15 min), the recommendation is forced to 0 and the screen shows a warning. There is no proportional reduction for a forecast between 54 mg/dL and the target, and oref's `carbsReq` is not used by the calculator at all (it drives a separate home-screen badge and an optional alert).

## The formula (BolusCalculationManager.calculateInsulin)

Order of operations, with the variable names used in the code:

1. `targetDifference = currentBG − target`; `targetDifferenceInsulin = targetDifference / isf`. Negative when glucose is below target, and it is not floored.
2. `fifteenMinutesInsulin = deltaBG / isf`. Despite the name, `deltaBG` is the newest reading minus the oldest reading among readings less than 20 minutes old (needs at least 2 readings; otherwise 0). With 5-minute CGM this is usually a 15-minute change. A falling trend therefore subtracts insulin. Short excerpt:

   ```swift
   let twentyMinutesAgo = Date().addingTimeInterval(-20 * 60)
   ...
   delta = Decimal(newestInWindow) - Decimal(oldestInWindow)
   ```

3. `wholeCob = min(COB + carbs, maxCOB)`; `wholeCobInsulin = wholeCob / carbRatio`. COB is taken from the latest oref determination (or from a simulated determination if the carb entry is back-dated; in that case the typed carbs are set to 0 to avoid double counting).
4. `iobInsulinReduction = −IOB` (IOB from the latest determination; negative IOB, i.e. withheld basal, increases the dose).
5. `wholeCalc = targetDifferenceInsulin + iobInsulinReduction + wholeCobInsulin + fifteenMinutesInsulin` (the trend term is dropped if `deltaBG == 0`; if there is no BG at all only −IOB + COB insulin is used).
6. The user's "Recommended Bolus Percentage" (`fraction`) and, if ticked, the "reduced bolus" factor (`fattyMealFactor`) are applied only when `wholeCalc > 0`:

   ```swift
   // If factoredInsulin is negative, though, don't apply either
   if factoredInsulin > 0 {
       factoredInsulin *= input.fraction
   ```

7. Super bolus (optional): `sweetMealFactor × current basal rate` is added after the percentage.
8. Safety gate and limits:

   ```swift
   // don't recommend insulin when current glucose or minPredBG is < 54 or last sucessful loop was over 15 minutes ago
   if input.currentBG < 54 || input.minPredBG < 54 || isLoopStale {
       insulinCalculated = 0
   ```

   otherwise `max(factoredInsulin, 0)`, then capped at Max Bolus, then at `maxIOB − IOB`, then rounded to the pump's bolus increment.

Practical consequences:

- A negative total (e.g. low glucose + falling trend + IOB larger than the meal needs) gives a recommendation of 0 U. The calculator does not convert the negative remainder into "eat X g more carbs" (unlike AndroidAPS, which shows a carb equivalent).
- Because the percentage is applied only to a positive total, the low-glucose/IOB subtraction is applied in full before the percentage is taken (e.g. 80% of (meal − below-target − IOB − trend)).
- The target used is the profile target from the latest determination (`currentTarget`, which reflects temp targets/overrides) with fallback to the scheduled target's `low` value. Trio's profile targets are a single value, so "below target" means below that single value, not below a range.

## Where the forecast comes in

- `minPredBG` is parsed from the oref "reason" string of the determination (`Determination+helper.swift`, property `minPredBGFromReason`, which reads the number after "minPredBG "). `eventualBG` (`evBG`) and `insulinReq` are also read, but `calculateInsulin` uses only `minPredBG`, and only in the `< 54` test.
- When the user types carbs, changes the bolus amount or the carb time, the Treatments screen runs `apsManager.simulateDetermineBasal(simulatedCarbsAmount: carbs, simulatedBolusAmount: amount, simulatedCarbsDate: date)` (a full oref run in simulation mode that inserts the typed carbs and a simulated bolus event), then replaces `evBG` and `minPredBG` with the simulated values and draws the forecast cone. So the 54 mg/dL gate is evaluated on a forecast that already contains the meal being entered and the bolus amount currently in the field.
- The same 54 mg/dL test drives the warnings on the recommendation card (PopupView `recommendedBolusCard`), in this priority order: "Last loop was > 15 m ago." → "Glucose is very low." (current BG < 54, red) → "Glucose forecast is very low." (minPredBG < 54) → Max Bolus / Max IOB limits.
- On the bolus button (TreatmentsRootView `bolusWarning`), if the user enters an amount > 0 for a pump bolus while current BG < 54 or minPredBG < 54, the same message is shown; with the "confirm bolus" setting on, an extra confirmation ("Ignore Warning and Enact Bolus") is required. External (logged) insulin is not warned.
- Unit test `testMinPredBGGuardBolusCalculation` (BolusCalculatorTests.swift) fixes this behaviour: with minPredBG = 45 mg/dL the recommendation must be 0 U; with minPredBG = 80 the same inputs give a positive dose.

## "Trio would give" (algorithm-suggested bolus, added 2026-09-13)

Since commit bf2d531 the card also shows what oref itself asked for: `algorithmSuggestedBolus = min(insulinReq × fraction, maxBolus)`, shown only if `insulinReq > 0`. `insulinReq` is oref's `(min(minPredBG, eventualBG) − target)/ISF` (see the oref file). The unit test notes that oref returns a negative `insulinReq` when it wants basal reduced, "which is not a bolus", so negatives display as nothing. This number is informational; it does not change the calculator's recommendation.

## carbsReq is not part of the calculator

- `Treatments.StateModel` declares `carbsRequired` but the calculator never reads it.
- oref (Swift port, `DosingEngine.calculateCarbsRequired`) reports `carbsReq` only when it is ≥ `carbsReqThreshold` (Trio default 1 g) and BG is projected to fall below the low threshold within 45 min (`minutes <= 45`).
- The home screen shows a "carbs required" badge when `carbsReq` > `carbsRequiredThreshold` (default 10 g, can be hidden with `showCarbsRequiredBadge`), and there is an optional "Carbs Required" glucose alert ("Fires when oref recommends eating carbs to avoid a low", default threshold 10 g).

## Which oref runs in Trio now

Current `main` runs a native Swift port of oref (`Trio/Sources/APS/OpenAPSSwift/...`, called from `OpenAPS.determineBasal` via `DeterminationGenerator.generate`); the JavaScript `trio-oref/lib/determine-basal/determine-basal.js` is still in the repo. Trio's low threshold differs from upstream oref0: `threshold = min(max(threshold_setting, min_bg − 0.5 × (min_bg − 40), 60), 120)` with `threshold_setting` default 60 mg/dL (DetermineBasal+Helpers.swift and trio-oref determine-basal.js). Details in `devices/oref-determine-basal-low-and-carbsreq.md`.

## Notes for Mellis

- **Relevance:** Trio is the owner's AID. Its calculator already reduces a meal bolus for (a) BG below target, (b) a falling 15–20 min trend and (c) IOB, all additively and without a floor until the very end. It uses the oref forecast only as an all-or-nothing gate at 54 mg/dL (current BG or minPredBG of a simulation that includes the typed meal and bolus). Between 54 mg/dL and the target there is no forecast-based scaling, so a Mellis suggestion to reduce a meal bolus when a low is predicted (e.g. minPredBG 60–80 mg/dL, or a predicted-low push) goes beyond what Trio's calculator does by itself. When comparing with Trio's number, remember Trio has already subtracted the below-target and trend parts; reducing again would double count.
- A recommendation of 0 U in Trio may mean "negative total", not "skip the meal"; Trio does not show the carb equivalent. oref's `carbsReq` (badge/alert) is the only Trio output that says "eat more".
- Trio's `fraction` (Recommended Bolus Percentage) is applied after the low/IOB subtraction, only to a positive total.
- **Evidence level:** documentation/code (behaviour of a specific open-source app version); not a clinical trial. Numbers (54 mg/dL, 15 min loop staleness, 20 min trend window, 45 min carbsReq horizon, 1 g / 10 g thresholds) are code constants/defaults at the commit above and may change in later versions.
