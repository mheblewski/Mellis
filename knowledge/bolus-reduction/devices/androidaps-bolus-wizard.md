---
id: androidaps-bolus-wizard
title: "AndroidAPS Bolus Wizard (docs + code, AGPL): BG below range corrected to the LOW end (negative), optional 15-min trend = shortAvgDelta x3 / ISF (off by default), IOB subtracted; negative total -> 0 U and carbs required = deficit x IC; percentage (default 100%) only on positive totals"
publisher: "AndroidAPS documentation (openaps/AndroidAPSdocs) and source code"
url: https://androidaps.readthedocs.io/en/latest/DailyLifeWithAaps/AapsScreens.html#bolus-wizard
licence: "AGPL-3.0"
licence_url: https://github.com/openaps/AndroidAPSdocs/blob/master/LICENSE
mode: SHIP_TEXT
language: en
retrieved: 2026-10-21
topics: [bolus-reduction, hypoglycaemia, bolus-calculator, aid, settings]
index: true
corpus_v7: bolus-reduction/devices/androidaps-bolus-wizard.md
attribution: "Contains text from the AndroidAPS documentation (openaps/AndroidAPSdocs) and/or code from nightscout/AndroidAPS, GNU AGPL v3.0 (https://github.com/openaps/AndroidAPSdocs/blob/master/LICENSE). Original: https://androidaps.readthedocs.io/en/latest/DailyLifeWithAaps/AapsScreens.html#bolus-wizard"
changes: "Docs text reproduced (images omitted) with our notes and a header; see the file header for what is verbatim."
---

*Contains text from the AndroidAPS documentation (openaps/AndroidAPSdocs) and/or code from nightscout/AndroidAPS, GNU AGPL v3.0 (https://github.com/openaps/AndroidAPSdocs/blob/master/LICENSE). Original: https://androidaps.readthedocs.io/en/latest/DailyLifeWithAaps/AapsScreens.html#bolus-wizard*

# AndroidAPS (AAPS) Bolus Wizard: below-target correction, 15-min trend, IOB/COB, carbs-required and Super Bolus

- **Type:** Documentation (AndroidAPS docs, verbatim excerpts) + source-code notes (AndroidAPS app)
- **Journal/year:** openaps/AndroidAPSdocs `master` at be7332a0fd2e9d9eb5d028d09f291932e767b710 (2026-10-19): `docs/EN/DailyLifeWithAaps/AapsScreens.md` (sections "Carbs required", "Prediction lines", "Bolus Wizard"), `docs/EN/SettingUpAaps/Preferences.md` ("Superbolus", "Deliver this part of bolus wizard result"), `docs/EN/SettingUpAaps/ConfigBuilder.md`, `docs/EN/DailyLifeWithAaps/DynamicISF.md` ("ISF in Bolus Wizard"), `docs/EN/RemoteFeatures/RemoteControlWearOS.md`. Code: nightscout/AndroidAPS `master` at aa16db64196e570b15bf41e85422fc159c058308 (2026-10-16): `core/objects/src/main/kotlin/app/aaps/core/objects/wizard/BolusWizard.kt`, `ui/src/main/kotlin/app/aaps/ui/dialogs/WizardDialog.kt`, `core/keys/.../BooleanKey.kt`, `IntKey.kt`
- **DOI:** none
- **URL:** https://androidaps.readthedocs.io/en/latest/DailyLifeWithAaps/AapsScreens.html#bolus-wizard ; https://github.com/nightscout/AndroidAPS/blob/aa16db64196e570b15bf41e85422fc159c058308/core/objects/src/main/kotlin/app/aaps/core/objects/wizard/BolusWizard.kt
- **Licence:** AGPL-3.0 (both the docs repo and the app repo, per GitHub). Docs excerpts below are verbatim and unaltered except for removed image links; code excerpts are short.
- **Saved:** excerpt from the AndroidAPS docs (GitHub markdown sources) and notes from the app source on 2026-10-21 for the Mellis RAG corpus.

## Documentation excerpts (verbatim)

### Bolus Wizard — Section I (AapsScreens.md)

> Shows the calculated bolus.
>
> If the amount of insulin on board already exceeds the calculated bolus then it will just display the amount of carbs still required.
>
> The bolus calculator can be used whatever your current **BG**, including when it is too high or too low. If **BG** is above target, a correction is added to the meal bolus. If **BG** is below target, the bolus is reduced and, if the insulin already on board is more than needed, the calculator tells you how many carbs are still required instead of proposing insulin.

### Section J (inputs)

> BG field is normally already populated with the latest reading from your CGM. If you don't have a working CGM then it will be blank.
>
> The **Corr** field is if you want to modify the end dosage for some reason.
>
> The **Carb time** field is for pre-bolusing so you can tell the system that there will be a delay before the carbs are to be expected. You can put a negative number in this field if you are bolusing for past carbs.

### Section K (Super Bolus)

> **Super Bolus** is where the basal insulin for the next two hours is added to the immediate bolus and a zero TBR is issued for the following two hours to take back the extra insulin. The option only shows when "Enable Superbolus in wizard" is set in the [Preferences > Overview > Advanced Settings]. The idea is to deliver the insulin sooner and hopefully reduce spikes.

Preferences.md adds: "Use with caution and do not enable it until you learn what it really does. Basically, the basal for the next two hours is added to the bolus and a two hour zero-temp activated. **AAPS looping functions will be disabled - so use with care! If you use SMB AAPS looping functions will be disabled according to your settings in "Max minutes of basal to limit SMB to", if you do not use SMB looping functions will be disabled for two hours.**"

### Section L (which terms are included)

> You can deselect any that you do not want to include, but you normally wouldn't want to.
>
> For safety reasons the **TT box must be ticked manually**, if you want the bolus wizard to calculate based on an existing temporary target.
>
> * For safety reasons, the IOB box cannot be unticked when COB box is ticked as you might run the risk of too much insulin as **AAPS** is not accounting for what's already given.
> * If you tick COB and IOB, unabsorbed carbs that are not already covered with insulin + all insulin that has been delivered as TBR or SMB will be taken into account.
> * If you tick IOB without COB, **AAPS** takes account of already delivered insulin but won't cover that off against any carbs still to be absorbed. This leads to a 'missing carbs' notice.
> * If you bolus for **additional food** shortly after a meal bolus (i.e. additional desert) it can be helpful to **untick all boxes**. This way just the new carbs are being added as the main meal won't necessarily be absorbed so IOB won't match COB accurately shortly after a meal bolus.

### Carbs required (home screen, AapsScreens.md)

> Carbs suggestions are given when the reference design detects that it requires carbs.
>
> This is when the oref algorithm thinks it can't rescue you by zero-temping, and you will need carbs to fix.
>
> The carb notifications are much more sophisticated than the bolus calculator ones. You might see carbs suggestion whilst bolus calculator does not show missing carbs.

### Deliver this part of bolus wizard result (Preferences.md)

> Default is 100%: no correction. Even when setting a different value here, you can still change each time you use the bolus wizard. If this setting is 75 % and you had to bolus 10U, the bolus wizard will propose a meal bolus of only 7.5 units.

ConfigBuilder.md: "When using SMB, many people do not meal-bolus 100% of needed insulin, but only a part of it (e.g. 75 %) and let the SMB with UAM (unattended meal detection) do the rest."

### Prediction lines (for context)

The home graph shows the oref curves: COB (orange), IOB (dark blue), zero-temp (light blue, SMB only), UAM (dark yellow, SMB only). The bolus wizard does not use these curves (see code below).

## What the code does (BolusWizard.kt, doCalc)

- **Target:** profile target range low/high (or the temp target's low/high if the TT box is ticked).
- **BG term:**

  ```kotlin
  bgDiff = when {
      bg in targetBGLow..targetBGHigh -> 0.0
      bg <= targetBGLow               -> bg - targetBGLow
      else                            -> bg - targetBGHigh
  }
  insulinFromBG = bgDiff / sens
  ```

  Below the range, the difference is measured to the **low end** of the target range and is negative (reverse correction always on when the BG box is ticked); above the range, to the high end; inside the range, 0.
- **Trend term ("Insulin from 15 min trend"):** `insulinFromTrend = shortAvgDelta × 3 / ISF`, i.e. the average 5-min change over roughly the last 15 min × 3 = expected 15-min change, converted to insulin. Negative when falling. The trend box is **off by default** (`WizardIncludeTrend` default false; also `WearWizardTrend` false on the watch).
- **Carbs:** `carbs / IC`; COB term `cob / IC` only if COB box ticked (`WizardIncludeCob` default false).
- **IOB:** bolus IOB and basal IOB (TBR/SMB) are subtracted if ticked; with the "positive IOB only" option a negative total IOB is treated as 0.
- **Super bolus:** basal rate now + basal rate in 1 h (≈ 2 h of basal) added.
- **Total:** `insulinFromBG + insulinFromTrend + insulinFromCarbs − IOB + Corr + superbolus + insulinFromCOB`.
- **Percentage** (default 100%, allowed 10–100% via `OverviewBolusPercentage`) is applied **only if the total is ≥ 0**. If the total is negative:

  ```kotlin
  carbsEquivalent = (-calculatedTotalInsulin) * ic
  calculatedTotalInsulin = 0.0
  ```

  i.e. bolus 0 and the deficit is shown as grams of carbs still required (deficit × IC).
- ISF: with Dynamic ISF the wizard uses the average of the past 24 h dynamic ISF values (DynamicISF.md); DynamicISF.md also says ISF is used "if BG is above target to add a correction" — the code shows it is also used below target (negative correction).
- No forecast/minPredBG gate in the wizard; constraints (max bolus etc.) are applied at the end.

## Notes for Mellis

- **Relevance:** AAPS gives the clearest "reduce, don't skip" calculator output: negative BG correction (to the low end of the target range), optional negative 15-min trend, IOB subtraction, and when the total is negative it converts the deficit to "carbs required" (deficit × IC) instead of just showing 0. This is a direct model for Mellis's wording ("reduce the meal bolus by X U, or if the deficit exceeds the meal, eat X g more").
- The trend option is off by default; current BG and IOB are on. The forecast (oref predBGs) is not used by the wizard; oref's own carbsReq notification is separate and, per the docs, "more sophisticated".
- **Hypo / eating while low:** no dedicated AAPS doc advice on bolusing a meal while low was found beyond the Section I statement above and the Hypo temp target (TT Hypo: aim 126 mg/dL / 7 mmol/L for 30 min by default, per TempTargets.md).
- **Evidence level:** documentation/code of an open-source AID app; no outcome data.
