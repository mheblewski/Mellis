---
id: trio-bolus-calculator-correction-code
title: "Trio source (main 0b29cd5, v1.0.2): calculator high side = ((BG-target)/ISF + 15-20 min delta/ISF + (COB+carbs)/CR - IOB incl. SMB and temp basal) x Recommended Bolus Percentage 80% (5-150%), reduced bolus 70%, super bolus +100% of 1 h basal, capped Max Bolus 10 U and Max IOB - IOB; 0 U if loop >15 min; insulinReq not in dose, shown as 'Trio would give' = insulinReq x 80%"
publisher: "nightscout/Trio, branch `main` at commit 0b29cd53415e7f0e668677749cad8daf81c68c2f"
url: https://github.com/nightscout/Trio/blob/0b29cd53415e7f0e668677749cad8daf81c68c2f/Trio/Sources/Services/BolusCalculator/BolusCalculationManager.swift
licence: "Own text (Mellis); short code excerpts from nightscout/Trio and openaps/oref0 under the MIT License"
licence_url: https://opensource.org/license/mit
mode: SUMMARY_ONLY
language: en
retrieved: 2026-10-21
topics: [correction, bolus-reduction, bolus-calculator, trio, loop, smb, limits]
index: true
corpus_v7: correction-up/devices/trio-bolus-calculator-correction-code.md
---

*Our summary or notes (Mellis knowledge base), written in our own words with short quotes only; not the original text and not medical advice. Original: https://github.com/nightscout/Trio/blob/0b29cd53415e7f0e668677749cad8daf81c68c2f/Trio/Sources/Services/BolusCalculator/BolusCalculationManager.swift.*

# Trio bolus calculator on the high side: positive correction (BG − target)/ISF, trend, COB, −IOB, Recommended Bolus Percentage 80%, super bolus, Max Bolus/Max IOB caps and "Trio would give" = insulinReq × 80% (source-code notes)

- **Type:** Source-code notes (open-source AID app for iOS, oref-based)
- **Journal/year:** nightscout/Trio, branch `main` at commit 0b29cd53415e7f0e668677749cad8daf81c68c2f (2026-10-07, release v1.0.2). Files: `Trio/Sources/Services/BolusCalculator/BolusCalculationManager.swift`, `Trio/Sources/Modules/Treatments/TreatmentsStateModel.swift`, `Trio/Sources/Modules/Treatments/View/PopupView.swift`, `Trio/Sources/Models/TrioSettings.swift`, `Trio/Sources/Models/DecimalPickerSettings.swift`, `Trio/Sources/Models/Preferences.swift`, `Trio/Sources/Modules/BolusCalculatorConfig/View/BolusCalculatorConfigRootView.swift`, `Trio/Sources/Models/DosingMode.swift`, `Trio/Sources/Models/Preferences+DosingMode.swift`, `Trio/Sources/APS/OpenAPSSwift/Iob/IobCalculation.swift`, `Trio/Resources/json/defaults/settings/settings.json`
- **DOI:** none
- **URL:** https://github.com/nightscout/Trio/blob/0b29cd53415e7f0e668677749cad8daf81c68c2f/Trio/Sources/Services/BolusCalculator/BolusCalculationManager.swift
- **Licence:** MIT (LICENSE.txt in the repo, "Copyright (c) 2021 Ivan Valkou"). Only short code excerpts are quoted; the rest is a description in our own words.
- **Saved:** notes from the GitHub source (raw files at the commit above) on 2026-10-21 for the Mellis RAG corpus. The low/falling side of the same calculator (54 mg/dL gate, falling trend, carbsReq) is in `bolus-reduction/devices/trio-bolus-calculator-forecast-code.md`; this file covers what the calculator does when glucose is HIGH and how it relates to oref's insulinReq and SMBs.

## Summary in one paragraph

Trio's bolus calculator does add a positive correction when glucose is above target: (current BG − target)/ISF plus (15–20 min glucose rise)/ISF plus (COB + new carbs)/CR, minus ALL insulin on board (manual boluses, SMBs and net temp-basal insulin; basal IOB can be negative and then increases the dose). The total is multiplied by the "Recommended Bolus Percentage" (code name `overrideFactor`, passed as `fraction`; default 80%, allowed 5–150%), then capped at Max Bolus (default 10 U), then at Max IOB − IOB, and rounded to the pump increment. The calculator never adds oref's `insulinReq` or `eventualBG` to the dose; since 2026-09 it only displays insulinReq separately as "Trio would give" = min(insulinReq × 80%, Max Bolus). With 0 carbs it is a pure correction calculator (correction + trend + existing COB − IOB, × 80%). It returns 0 U whenever the last loop is older than 15 minutes, current BG < 54 mg/dL or oref minPredBG < 54 mg/dL. Because IOB already includes every SMB and high temp, a calculator correction does not double count insulin the loop has already delivered; the 80% default exists because SMB/UAM will add the rest.

## The positive side of the formula (BolusCalculationManager.calculateInsulin, lines 381–485)

Terms, in the order of the code (all in units of insulin):

1. **Correction:** `targetDifferenceInsulin = (currentBG − target) / isf` (lines 383–386). Positive when glucose is above target. `target` is `currentTarget` from the latest oref determination (reflects overrides and temp targets), falling back to the scheduled target's `low` value; `isf` is the determination's `insulinSensitivity` (autosens/dynamic ISF already applied), falling back to the profile ISF (lines 268–280).
2. **Trend:** `fifteenMinutesInsulin = deltaBG / isf` (line 390). `deltaBG` = newest minus oldest reading among readings less than 20 minutes old (lines 215–232). A rise of 30 mg/dL in 15 min with ISF 50 adds 0.6 U. If `deltaBG == 0` (or fewer than 2 recent readings) the trend term is dropped (lines 405–419).
3. **Carbs:** `wholeCob = min(COB + carbs, maxCOB)` (default maxCOB 120 g) and `wholeCobInsulin = wholeCob / carbRatio` (lines 395–396). Note that existing COB from earlier meals is dosed again here; this is balanced by the IOB term, which contains the boluses already given for those carbs.
4. **IOB:** `iobInsulinReduction = −iob` (line 400), IOB from the latest determination.
5. **Sum:** `wholeCalc = correction + (−IOB) + carb insulin + trend` (line 407).
6. **Percentage:** only if `wholeCalc > 0`: `factoredInsulin = wholeCalc × fraction`, and if the user ticked "Reduced Bolus", also `× fattyMealFactor` (lines 428–436). So the 80% default applies to the correction part as well as to the meal part.
7. **Super bolus:** if ticked, `superBolusInsulin = sweetMealFactor × basal` is ADDED after the percentage (lines 440–444). `basal` is the current scheduled basal rate in U/h, so with the default 100% the super bolus adds one hour of basal (e.g. basal 0.8 U/h → +0.8 U; at 200% → +1.6 U). The calculator does not itself set a zero temp to "pay back" this basal; the loop does that by itself through the higher IOB.
8. **Gates and caps (lines 448–470):** if loop stale (> 15 min), BG < 54 or minPredBG < 54 → 0 U. Otherwise `max(factoredInsulin, 0)`, then `min(…, maxBolus)`, then `min(…, maxIOB − iob)`, then rounded to the pump's bolus increment (`apsManager.roundBolus`).

## Settings, defaults and allowed ranges

From `TrioSettings.swift` (lines 60–64), `DecimalPickerSettings.swift` (lines 49–52, 136) and the settings help text:

- **Recommended Bolus Percentage** (`overrideFactor` → `fraction`): default 0.8 (80%), picker 0.05–1.5 (5%–150%) in steps of 5%. Help text: Trio "first calculates an insulin required value, which is the full dosage", then multiplies it by this percentage; the default is below 100% "because Trio utilizes SMBs and UAM SMBs to help you reach your target glucose".
- **Reduced Bolus Percentage** (`fattyMealFactor`): default 0.7 (70%), range 5%–100%, feature OFF by default. Multiplies on top of the 80%: 0.8 × 0.7 = 56% of the full calculation.
- **Super Bolus Percentage** (`sweetMealFactor`): default 1.0 (100%), range 5%–200%, feature OFF by default; adds `sweetMealFactor × current basal rate`.
- **Max Bolus:** picker default 10 U, range 0.5–30 U (fresh-install `settings.json` also 10 U).
- **Max IOB** (`max_iob`): default 0 U, range 0–30 U. With 0, the calculator cap `maxIOB − IOB` is ≤ 0, so it can never recommend insulin above that limit, and oref cannot add insulin above scheduled basal. Users must raise it before closing the loop.
- The user documentation page `trio/usage_features_bolus-calculator.md` uses an example with a "default of 50%"; the code and `trio/configuration_settings_features_bolus-calculator.md` say 80% (5%–150%). The code value (80%) is current.

## Which IOB is subtracted (IobCalculation.swift, lines 216–229)

- oref's `iob` is the sum of every insulin entry within DIA: manual boluses, SMBs (stored as boluses with `isSMB = true`) and the temp-basal difference from scheduled basal, which is split into tiny ±0.05 U pseudo-boluses. Entries < 0.1 U go to `basaliob`, larger ones to `bolusiob`; `iob` is their sum.
- Scheduled basal itself is not IOB. A zero temp creates negative basal IOB; a high temp creates positive basal IOB.
- Consequence: when SMBs and high temps have already been given for a high, the calculator's −IOB removes them from the correction. Negative IOB after a suspension increases the correction.
- Trio's default DIA in the fresh-install `settings.json` is 10 h (`insulin_action_curve: 10`; picker 5–10 h), so IOB decays slowly.

## Does the calculator use oref's insulinReq or eventualBG?

- `insulinRequired`, `evBG` and `minPredBG` are read from the latest determination (TreatmentsStateModel lines 895–897; BolusCalculationManager lines 269–271), but `calculateInsulin` uses only `minPredBG`, and only in the `< 54` gate. The positive correction is the simple current-BG formula, not a forecast.
- **"Trio would give"** (PopupView lines 906–921; TreatmentsStateModel lines 71–74): `algorithmSuggestedBolus = min(insulinReq × fraction, maxBolus)`, shown only when `insulinReq > 0`. The code comment says it is "what oref says is still needed on top of scheduled basal, discounted by the user's Recommended Bolus Percentage", and explicitly "never `smbToDeliver`, which oref pairs with a compensating low temp that is not enacted here". It is informational and is not added to the recommended bolus. The row is labelled with the current dosing mode (Closed Loop / Open Loop / Low Glucose Suspend / Basal Testing).
- When the user types carbs or a bolus amount, Trio runs a full simulated oref determination with them (`simulateDetermineBasal`), which updates the forecast chart and `minPredBG`/`evBG`, but the positive correction is unchanged.

## Pure correction (0 carbs)

With carbs = 0 the calculator still runs: `(BG − target)/ISF + trend/ISF + COB/CR − IOB`, × 80%, then the caps. Example: BG 220, target 100, ISF 50, rise +15 mg/dL over 15 min, COB 0, IOB 1.2 U (all from SMBs) → 2.4 + 0.3 − 1.2 = 1.5 U → × 0.8 = 1.2 U. If the SMBs had already delivered 2.7 U of active insulin, the total would be 0 U.

## When the calculator returns 0

- Last successful loop more than 15 minutes ago (`isLoopStale`, line 448), even if glucose is very high.
- Current BG < 54 mg/dL or minPredBG < 54 mg/dL (line 452).
- No determination in the last 30 minutes (`predicateFor30MinAgoForDetermination`, lines 325–327): IOB and COB fall back to 0 (lines 252–266), but a loop that old is also stale, so the result is 0.
- Total negative (IOB larger than correction + carbs).

So Trio itself refuses to suggest a correction (or a meal bolus) when it has no fresh loop.

## Dosing modes in v1.0.2 (DosingMode.swift, Preferences+DosingMode.swift)

- **Closed Loop:** full automation (corrections, SMBs, reductions).
- **Open Loop:** nothing is enacted; "Trio would give" shows what oref asked for.
- **Low Glucose Suspend:** oref sees Max IOB = 0, so it can lower basal but "will never give extra insulin to bring a high down".
- **Basal Testing:** Max IOB 0, autosens pinned to 1, suspend threshold at least 72 mg/dL.

In the last three modes, highs are not corrected automatically.

## Notes for Mellis

- **Relevance:** Trio's own calculator does add a correction when glucose is high, but always (a) subtracts all IOB including SMBs and temp-basal insulin, (b) scales by 80% by default, (c) caps at Max Bolus and Max IOB − IOB, (d) refuses (0 U) when the loop is more than 15 min old. A Mellis meal card that adds (BG − target)/ISF without subtracting IOB would give more than Trio's own calculator whenever SMBs or high temps have been running.
- "Trio would give" = insulinReq × 80% is the only place where Trio shows oref's forecast-based need as a bolus number; it already accounts for IOB because oref's eventualBG is computed after subtracting IOB × ISF.
- **Evidence level:** behaviour of a specific open-source app version (code). Numbers (80% default, 5–150% range, 70% reduced bolus, 100% super bolus = 1 h of basal, 15 min staleness, 54 mg/dL gate, 20 min trend window, Max Bolus 10 U, Max IOB 0 U by default) are constants/defaults at the commit above and may change.
