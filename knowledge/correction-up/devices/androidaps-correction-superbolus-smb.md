---
id: androidaps-correction-superbolus-smb
title: "AndroidAPS high side (docs + code, AGPL): wizard adds (BG - top of target)/ISF minus bolus IOB incl. SMB and basal IOB; wizard % (default 100%) also cuts the correction; Super Bolus = +2 h basal with 2-h zero temp; SMB = 50% of insulinReq capped at basal x 30 min (15-120), Auto ISF ratio 0.5-1.0"
publisher: "AndroidAPS documentation (openaps/AndroidAPSdocs) and source code"
url: https://androidaps.readthedocs.io/en/latest/DailyLifeWithAaps/KeyAapsFeatures.html#super-micro-bolus-smb
licence: "AGPL-3.0"
licence_url: https://github.com/openaps/AndroidAPSdocs/blob/master/LICENSE
mode: SHIP_TEXT
language: en
retrieved: 2026-10-21
topics: [correction, bolus-calculator, smb, aid, targets, settings]
index: true
corpus_v7: correction-up/devices/androidaps-correction-superbolus-smb.md
attribution: "Contains text from the AndroidAPS documentation (openaps/AndroidAPSdocs) and/or code from nightscout/AndroidAPS, GNU AGPL v3.0 (https://github.com/openaps/AndroidAPSdocs/blob/master/LICENSE). Original: https://androidaps.readthedocs.io/en/latest/DailyLifeWithAaps/KeyAapsFeatures.html#super-micro-bolus-smb"
changes: "Docs text reproduced (images omitted) with our notes and a header; see the file header for what is verbatim."
---

*Contains text from the AndroidAPS documentation (openaps/AndroidAPSdocs) and/or code from nightscout/AndroidAPS, GNU AGPL v3.0 (https://github.com/openaps/AndroidAPSdocs/blob/master/LICENSE). Original: https://androidaps.readthedocs.io/en/latest/DailyLifeWithAaps/KeyAapsFeatures.html#super-micro-bolus-smb*

# AndroidAPS (AAPS): high-side correction in the Bolus Wizard (IOB incl. SMB subtracted, percentage applies to the correction too), Super Bolus, and SMB = 50% of insulinReq capped at 30 min of basal

- **Type:** Documentation (AndroidAPS docs, short verbatim excerpts) + source-code notes (AndroidAPS app)
- **Journal/year:** openaps/AndroidAPSdocs `master` at be7332a0fd2e9d9eb5d028d09f291932e767b710 (2026-10-19): `docs/EN/DailyLifeWithAaps/KeyAapsFeatures.md` (SMB, maxIOB, "Max minutes of basal to limit SMB to", hard-coded limits), `docs/EN/SettingUpAaps/Preferences.md` ("Superbolus"), `docs/EN/SettingUpAaps/ConfigBuilder.md`, `docs/EN/SettingUpAaps/CompletingTheObjectives.md`, `docs/EN/DailyLifeWithAaps/CobCalculation.md`, `docs/EN/DailyLifeWithAaps/DynamicISF.md`, `docs/EN/AdvancedOptions/FullClosedLoop.md`. Code: nightscout/AndroidAPS `master` at aa16db64196e570b15bf41e85422fc159c058308 (2026-10-16): `core/objects/.../wizard/BolusWizard.kt`, `ui/.../dialogs/WizardDialog.kt`, `plugins/aps/.../openAPSSMB/DetermineBasalSMB.kt`, `plugins/aps/.../openAPSAutoISF/DetermineBasalAutoISF.kt` and `OpenAPSAutoISFPlugin.kt`, `core/keys/.../IntKey.kt`, `DoubleKey.kt`, `BooleanKey.kt`
- **DOI:** none
- **URL:** https://androidaps.readthedocs.io/en/latest/DailyLifeWithAaps/KeyAapsFeatures.html#super-micro-bolus-smb ; https://github.com/nightscout/AndroidAPS/blob/aa16db64196e570b15bf41e85422fc159c058308/plugins/aps/src/main/kotlin/app/aaps/plugins/aps/openAPSSMB/DetermineBasalSMB.kt
- **Licence:** AGPL-3.0 (docs repo and app repo, per GitHub). Docs excerpts are short and verbatim; code excerpts are short.
- **Saved:** notes from the AndroidAPS docs (GitHub markdown) and app source on 2026-10-21 for the Mellis RAG corpus. Companion to `devices/androidaps-bolus-wizard.md` in the bolus-reduction corpus (low side, negative correction, carbs required); this file covers the high side and SMB only.

## Summary in one paragraph

In AndroidAPS the manual Bolus Wizard adds a classic correction when glucose is above the profile target range, (BG - high end of target) / ISF, then subtracts insulin on board: bolus IOB (which includes every SMB, since SMBs are boluses) and basal IOB from temp basals, each with its own checkbox, so automatic insulin is netted out of the suggested correction. The "Deliver this part of bolus wizard result" percentage (default 100%, range 10-100%) multiplies the whole positive total, so a 75% setting also cuts the correction to 75%. The optional 15-minute trend term (off by default) adds 3 x the recent 5-minute delta / ISF when glucose is rising. The automatic side (oref1 SMB) computes insulinReq = (min(minPredBG, eventualBG) - target) / ISF, capped by maxIOB - IOB, and delivers half of it per loop as a super micro bolus (`insulinReq / 2`), never more than current basal x "Max minutes of basal to limit SMB to" / 60 (default 30 min, range 15-120 min; separate UAM value, default 30), at most every 3 minutes by default. Only the optional Auto ISF plugin has an adjustable "SMB delivery ratio" (default 0.5, range 0.5-1.0, optionally interpolated by glucose). Super Bolus adds the next ~2 hours of basal to a wizard bolus and sets a 2-hour zero temp.

## Bolus Wizard on the high side (BolusWizard.kt, WizardDialog.kt)

- **BG term:** above the profile target range (or the temp target range, if the TT box is ticked manually) the correction is `(bg - targetBGHigh) / sens`; inside the range it is 0. So the correction is measured to the top of the target range, not to its midpoint.
- **Trend term ("Insulin from 15 min trend"):** `shortAvgDelta x 3 / ISF`, positive when rising. Off by default (`WizardIncludeTrend` default false; `WearWizardTrend` false).
- **IOB:** `bolusIob` (all boluses incl. SMBs) and `basalIob` (temp basals and converted extended boluses) are subtracted when their boxes are ticked; the docs say that with COB and IOB ticked "all insulin that has been delivered as TBR or SMB will be taken into account", and the IOB box cannot be unticked while COB is ticked. A "positive IOB only" option treats negative total IOB as 0. In the phone wizard the COB box starts from the saved preference `WizardIncludeCob` (default off) and trend from `WizardIncludeTrend` (default off); the docs say users can deselect terms "but you normally wouldn't want to". The watch wizard defaults are BG, COB and IOB on, trend and temp target off.
- **Dynamic ISF:** the wizard uses the average of the past 24 h dynamic ISF values (docs) - not the current, possibly much stronger, dynamic ISF the loop uses at high glucose.
- **Total and percentage:** `total = BG term + trend term + carbs/IC + COB/IC - IOB + Corr + superbolus`; if total >= 0 it is multiplied by the percentage (default 100%; 10-100% via `OverviewBolusPercentage`), i.e. **the percentage reduces the correction and the carb part alike**. Docs: "If this setting is 75 % and you had to bolus 10U, the bolus wizard will propose a meal bolus of only 7.5 units." ConfigBuilder.md: "When using SMB, many people do not meal-bolus 100% of needed insulin, but only a part of it (e.g. 75 %) and let the SMB with UAM ... do the rest."
- **Second helpings:** docs advise unticking all boxes when bolusing for additional food shortly after a meal bolus, so only the new carbs are dosed (IOB will not match COB right after a bolus).
- **No forecast gate on the high side:** the wizard does not use oref's predicted curves; constraints (max bolus) apply at the end.

## Super Bolus (Preferences.md, BolusWizard.kt)

- Option "Enable Superbolus in wizard", hidden in simple mode, off unless enabled. Adds basal rate now + basal rate in 1 h (about 2 hours of basal) to the wizard total and issues a zero temp basal for the following two hours "to take back the extra insulin"; the aim is to deliver insulin sooner and reduce spikes.
- Docs warning (short quote): "Use with caution and do not enable it until you learn what it really does." AAPS looping functions are disabled: with SMB, for the time set in "Max minutes of basal to limit SMB to"; without SMB, for two hours.

## SMB: how much of the needed correction oref1 delivers automatically (DetermineBasalSMB.kt)

- **insulinReq:** `(min(minPredBG, eventualBG) - target_bg) / sens` (with Dynamic ISF the future sensitivity is used), reduced to `max_iob - iob` if it would exceed maxIOB.
- **SMB size:** `microBolus = floor(min(insulinReq / 2, maxBolus) / bolus_increment) x bolus_increment` - half of the remaining need per loop, rounded down. SMBs are only allowed when `bg > threshold` and SMB is enabled for the situation (COB, temp target, after carbs, always).
- **SMB cap ("maxBolus" inside oref):** `current basal x maxSMBBasalMinutes / 60`, or `current basal x maxUAMSMBBasalMinutes / 60` when IOB exceeds the insulin needed for the remaining COB (UAM situation). Defaults 30 minutes each; allowed 15-120 minutes (`smbmaxminutes`, `uamsmbmaxminutes`). Docs: start with 30, increase in 15-minute steps, "not ... higher than 90 minutes" because the algorithm might then be unable to compensate a falling BG with a zero temp.
- **Docs wording (KeyAapsFeatures.md):** the largest single SMB is the smallest of (a) current basal (adjusted by autosens) for the "Max minutes of basal" duration, (b) "half the amount of insulin currently required", (c) the remaining part of maxIOB. Example from the docs: where AMA would add 1.0 U via a temp basal, SMB gives e.g. 0.4, 0.3, 0.2 and 0.1 U at 5-minute intervals while setting a zero temp.
- **Frequency:** "How frequently SMBs will be given in min", default 3 minutes (range 1-10), i.e. every loop run with 5-minute CGM.
- **Zero temp after an SMB:** oref sets a low or zero temp long enough to correct back up to target in the worst case, rounded to 30 or 60 minutes and never longer than 60 minutes.
- **maxIOB:** docs suggest maxIOB = average meal bolus + 3 x max daily basal; in SMB mode maxIOB includes bolus IOB. Hard limits for maxIOB with SMB by patient type (table "Overview of hard-coded limits"): child 7 U, teenager 13 U, adult 22 U, insulin-resistant adult 30 U, pregnant 70 U; MAXBOLUS child 5 U, teenager 10 U, adult 17 U, insulin-resistant 25 U, pregnant 60 U. (The maxIOB section of the same page lists 3/7/12/25/40 U, which match the AMA row; treat the table as the SMB values.)

## Adjustable SMB delivery ratio (only in the Auto ISF plugin)

- The standard OpenAPS SMB plugin hard-codes 50% (`insulinReq / 2`). The Auto ISF plugin (DetermineBasalAutoISF.kt) replaces it by `insulinReq x smb_ratio` when Auto ISF mode is on.
- Preference keys (DoubleKey.kt): `openapsama_smb_delivery_ratio` default 0.5, range 0.5-1.0; `..._ratio_min` and `..._ratio_max` default 0.5 (0.5-1.0); `..._ratio_bg_range` default 0 (0-100 mg/dL). If the bg range is > 0 the ratio is interpolated linearly from min (at target) to max (at target + range). `openapsama_smb_max_range_extension` default 1.0, range 1.0-5.0, multiplies the "max minutes of basal" SMB cap.
- FullClosedLoop.md (full closed loop without meal boluses) suggests maxUAMSMBBasalMinutes = 120 (2 hours of basal) and mentions the 50% SMB delivery ratio being raised in dev variants. No SMB delivery ratio exists in Dynamic ISF itself.

## Docs advice on manual corrections with a closed loop

- **Objective 6 (Low Glucose Suspend only, maxIOB = 0):** "Closed loop will not correct high BG values"; users must correct highs themselves by pump or pen. From Objective 7 maxIOB is raised and the loop corrects.
- **COB warning (CobCalculation.md):** when the COB estimate is unreliable, recalculate the meal with the wizard leaving COB unticked; "If you need a correction bolus, enter it manually"; "Be careful not to overdose or insulin stacking!"
- **Dynamic ISF:** disable automations that change the profile temporarily, because they "would cause Dynamic ISF to be overly aggressive in correction bolusing and result in hypoglycemia".
- **ISF too strong (YourAapsProfile.md):** too low an ISF value causes over-corrections and roller-coaster glucose. Too short a DIA: high BG followed by over-correction and a low.
- **Partial meal bolus:** KeyAapsFeatures.md suggests a start bolus that only partly covers the carbs (e.g. 2/3) and letting SMB deliver the rest.

## Notes for Mellis

- **Relevance:** AAPS is the closest relative of Trio (both oref1). Its manual wizard does add a correction on top of the meal bolus, but subtracts all IOB including SMB and temp-basal IOB; if the user reduces the wizard to e.g. 75%, the correction is reduced too. The automatic side gives 50% of insulinReq per 5-minute cycle, capped at 30 minutes of basal per SMB by default, so the loop alone typically needs several cycles (or more, with low basal rates such as in children) to deliver a large correction.
- **Evidence level:** documentation and code of an open-source AID; no outcome data in this file.
