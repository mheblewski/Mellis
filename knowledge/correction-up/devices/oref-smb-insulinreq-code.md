---
id: oref-smb-insulinreq-code
title: "oref0/Trio SMB code: insulinReq=(min(minPredBG,eventualBG)-target)/ISF net of IOB, capped max_iob-IOB; SMB = 50% (Trio 0.3-0.7) capped at 30 min of basal, floor to 0.1 U, every >=3 min; high temp basal+2xinsulinReq capped min(max_basal,3x max daily,4x current); SMB off with high temp target >100, rise >20% or CGM >12 min old; basal 0.5: ~1.15/1.85/1.95 U of a 2 U need in 15/30/60 min"
publisher: "openaps/oref0 `lib/determine-basal/determine-basal.js`, `lib/basal-set-temp.js`, `lib/profile/index.js`, branch `master`"
url: https://github.com/nightscout/Trio/blob/0b29cd53415e7f0e668677749cad8daf81c68c2f/Trio/Sources/APS/OpenAPSSwift/DetermineBasal/DosingEngine.swift
licence: "Own text (Mellis); short code excerpts from openaps/oref0 under the MIT License"
licence_url: https://opensource.org/license/mit
mode: SUMMARY_ONLY
language: en
retrieved: 2026-10-21
topics: [correction, trio, oref, smb, limits, cgm, targets]
index: true
corpus_v7: correction-up/devices/oref-smb-insulinreq-code.md
---

*Our summary or notes (Mellis knowledge base), written in our own words with short quotes only; not the original text and not medical advice. Original: https://github.com/nightscout/Trio/blob/0b29cd53415e7f0e668677749cad8daf81c68c2f/Trio/Sources/APS/OpenAPSSwift/DetermineBasal/DosingEngine.swift.*

# oref1/Trio on the high side: insulinReq = (min(minPredBG, eventualBG) − target)/ISF, SMB = 50% of insulinReq capped at 30 min of basal every ≥3 min, high temp = basal + 2 × insulinReq capped at min(max basal, 3 × max daily, 4 × current basal), max_iob (source-code notes)

- **Type:** Source-code notes (OpenAPS reference design algorithm oref1, as used by OpenAPS rigs and, ported to Swift, by Trio)
- **Journal/year:** openaps/oref0 `lib/determine-basal/determine-basal.js`, `lib/basal-set-temp.js`, `lib/profile/index.js`, branch `master` at 88cf032aa74ff25f69464a7d9cd601ee3940c0b3 (2022-06-19), compared with branch `dev` at d219baf9559d62a8bb0bd42014192a2d7c0839ef (2026-03-10; no change in the SMB/insulinReq code). Trio (nightscout/Trio `main` 0b29cd53415e7f0e668677749cad8daf81c68c2f, v1.0.2, 2026-10-07): `Trio/Sources/APS/OpenAPSSwift/DetermineBasal/DosingEngine.swift`, `DetermineBasalGenerator.swift`, `TempBasalFunctions.swift`, `Trio/Sources/APS/OpenAPSSwift/Iob/IobGenerator.swift`, `Trio/Sources/Models/Preferences.swift`, `Trio/Sources/Models/DecimalPickerSettings.swift`, `trio-oref/lib/determine-basal/determine-basal.js`, `Trio/Sources/Config/Config.swift`, parity test `TrioTests/OpenAPSSwiftTests/Parity/goldens/high-bg-rising-smb/`
- **DOI:** none
- **URL:** https://github.com/nightscout/Trio/blob/0b29cd53415e7f0e668677749cad8daf81c68c2f/Trio/Sources/APS/OpenAPSSwift/DetermineBasal/DosingEngine.swift
- **Licence:** MIT (openaps/oref0 LICENSE; nightscout/Trio LICENSE.txt). Short code excerpts quoted; the rest is our description.
- **Saved:** notes from the GitHub source on 2026-10-21 for the Mellis RAG corpus. The low side (threshold, minGuardBG, zero temps, carbsReq, how eventualBG/minPredBG are built) is in `bolus-reduction/devices/oref-determine-basal-low-and-carbsreq.md`; the OpenAPS and Trio documentation pages on SMB are already in the corpus. This file covers what oref does when glucose is high or forecast high.

## Summary in one paragraph

When the forecast is above target, oref computes `insulinReq = (min(minPredBG, eventualBG) − target)/ISF`. Because eventualBG and minPredBG are computed after subtracting the effect of all insulin on board, insulinReq is already net of IOB (manual boluses, earlier SMBs and temp basals). It is limited so that IOB never exceeds `max_iob`. If SMB is enabled and glucose is above the low threshold, oref gives one microbolus of `insulinReq × smb_delivery_ratio` (0.5 in oref0 and by default in Trio; Trio allows 0.3–0.7). The microbolus is capped at 30 minutes of the current scheduled basal (`maxSMBBasalMinutes`/`maxUAMSMBBasalMinutes`, default 30) and rounded down to the bolus increment. There must be at least 3 minutes since the last bolus of any kind (`SMBInterval`). In the same cycle it can also set a 30-minute high temp of `basal + 2 × insulinReq`, capped at `min(max_basal, 3 × max daily basal, 4 × current basal)`. Everything is recomputed at every loop (each CGM reading, at most every 3 min in Trio), so insulin is delivered in steps and stops as soon as IOB catches up or the rise slows. With basal 0.5 U/h and a constant 2 U need, oref delivers about 1.15 U in 15 min, 1.85 U in 30 min and 1.95 U in 60 min. If the need keeps rising, delivery is about 1.15 U per 15 min (4.6 U/h) until max_iob is reached.

## insulinReq (oref0 lines 1045–1069; Trio DosingEngine.calculateInsulinRequired, lines 674–696)

```js
insulinReq = round( (Math.min(minPredBG,eventualBG) - target_bg) / sens, 2);
if (insulinReq > max_iob-iob_data.iob) { insulinReq = max_iob-iob_data.iob; }
```

- `eventualBG = BG − IOB × ISF + deviation` (plus COB/UAM forecasts). So IOB is already subtracted before insulinReq is formed. A unit of insulin given by any route lowers eventualBG by about ISF mg/dL and insulinReq by about 1 U at the next loop.
- `min(minPredBG, eventualBG)` uses the more conservative of the two. minPredBG is the forecast minimum after insulin peak (it ignores the first 60–90 min), so a high that is expected to come down by itself gives a small insulinReq.
- This path runs only if none of the earlier branches returned: not low (BG and minGuardBG above threshold), eventualBG ≥ min_bg, and not "falling faster than expected" when SMB is off. Also, when SMB is off and min(eventualBG, minPredBG) < max_bg, oref just keeps scheduled basal. In Trio max_bg equals the single target.
- **IOB above max_iob:** if `iob > max_iob`, oref sets the scheduled basal as a temp and returns: no SMB, no high temp (oref0 lines 1045–1053; Trio `iobGreaterThanMax`, lines 635–667). `max_iob` counts IOB from all sources, including manual boluses (OpenAPS docs `openaps/While_You_Wait_For_Gear_preferences-and-safety-settings.md`; Trio docs `trio/configuration_settings_therapy_units-limits.md`). Defaults: oref0 profile `max_iob: 0`, Trio `max_iob` 0 (range 0–30 U).
- `rT.insulinReq` is reported in the determination (Nightscout devicestatus `openaps.suggested/enacted.insulinReq`) and in the reason string as "insulinReq X".

## When SMBs are allowed (oref0 `enable_smb`, lines 51–125; Trio `isProfileSmbEnabled`/`makeSMBDosingDecision`, DosingEngine lines 18–138)

Disabled first (any one is enough):
- Trio: SMB turned off by an active override ("Disable SMBs") or by the override's SMB schedule (`smbIsOff`, `smbIsScheduledOff`).
- High temp target: `temptargetSet && target > 100 mg/dL` unless `allowSMB_with_high_temptarget` (default OFF).
- oref0 only: Medtronic Bolus Wizard used in the last 6 h (`bwFound`) unless `A52_risk_enable` (default false). This is not in Trio's Swift port.

Then enabled if any one of these is on and true (all default OFF in both oref0 and Trio):
- `enableSMB_always`;
- `enableSMB_with_COB` while COB > 0;
- `enableSMB_after_carbs` for 6 h after any carb entry;
- `enableSMB_with_temptarget` with a temp target < 100 mg/dL;
- `enableSMB_high_bg` when BG ≥ `enableSMB_high_bg_target` (default 110 mg/dL, Trio range 70–200).

Then disabled again in the main function:
- `minGuardBG < threshold` (forecast low at any time);
- `maxDelta > maxDelta_bg_threshold × BG`, where maxDelta is the largest of the last 5-min delta and the ~15- and ~45-min average deltas. The default threshold is 20%; oref0 caps it at 30%, Trio allows 10–40%. Example: BG 100 → 120 in one reading is +20%, still allowed; +28% disables SMB. A very fast rise therefore falls back to temp basal only.
- An SMB is actually given only if `bg > threshold` (DosingEngine line 757; oref0 line 1076).

`enableUAM` (oref0 profile default true, Trio default OFF) affects the forecast (UAM curve, and which SMB minutes cap applies), not the enable decision. Trio's docs say UAM should be ON when SMBs are enabled.

## No SMB without fresh CGM (oref0 lines 170–222; Trio `handleTempBasalCases`, DetermineBasalGenerator lines 585–660)

If the last glucose is older than 12 min (or more than 5 min in the future), BG ≤ 10, BG = 38 (sensor error) or noise ≥ 3, oref does not dose. A running high temp is replaced by a 30-min neutral temp at scheduled basal, and a long zero temp is shortened to 30 min. No SMB is given. oref0 also treats "too flat" CGM (|deltas| < 1 mg/dL for 45 min) as an error; Trio only reports it. Trio's loop runs on each new CGM value, at most every 3 minutes (`Config.loopInterval = 3 min`), and always passes `microBolusAllowed: true`.

## SMB size (oref0 lines 1076–1100; Trio DosingEngine `determineMaxBolus` lines 699–730 and `determineSMBDelivery` lines 737–857)

```swift
let microBolusWithoutRounding = min(insulinRequired * smbDeliveryRatio, maxBolus)
let microBolus = (microBolusWithoutRounding * roundSmbTo).floor() / roundSmbTo
```

- **Delivery ratio:** oref0 hard-codes `insulinReq/2` (50%). Trio uses `smb_delivery_ratio`: default 0.5, picker 0.3–0.7 in steps of 0.05, code limit `min(ratio, 1)`. The reason string shows "SMB Ratio" when it is not 0.5.
- **Cap (maxBolus):** 30 min of the current scheduled basal by default. If `IOB > COB/CR` and IOB > 0 (insulin already covers the carbs, a typical correction or UAM situation), the cap is `current_basal × maxUAMSMBBasalMinutes/60`; otherwise it is `current_basal × maxSMBBasalMinutes/60`. Both default to 30 min. Trio's picker allows 15–180 min, while Trio docs say 30–180 and warn above 90 min. The cap is rounded to 0.1 U (0.25 → 0.3). In Trio the basal is multiplied by the active override percentage, and an override can set its own SMB/UAM minutes. Examples: basal 0.3 U/h → max SMB 0.2 U; 0.5 U/h → 0.3 U; 1.0 U/h → 0.5 U; 2.0 U/h → 1.0 U.
- **Rounding:** always down to the bolus increment (`bolus_increment`, Trio default 0.1 U, range 0.05–1). If half of insulinReq is below one increment, no SMB is given.
- **Interval:** `lastBolusAge` is the number of minutes since the last bolus of any kind, manual or SMB (Trio `IobGenerator` lines 22–24 takes the newest non-temp bolus). An SMB is given only if `lastBolusAge > SMBInterval` (default 3 min, range 1–10). Otherwise the reason says "Waiting Xm Ys to microbolus again". So a manual bolus blocks SMB for only 3 minutes. After that, the loop doses on the new, higher IOB.
- **SMB low temp:** `worstCaseInsulinReq = (target − (naive_eventualBG + minIOBPredBG)/2)/ISF`. If this is positive (IOB alone would take BG below target), oref pairs the SMB with a low or zero temp of 30–60 min ("setting 30m low temp of X U/h"). That temp pays back the front-loaded insulin from basal. Trio's FAQ (`trio/help_faq.md`) calls this normal: SMBs "borrow insulin from the future".

## High temp basal (oref0 lines 1162–1186; Trio `determineHighTempBasal`, lines 862–924; `getMaxSafeBasal`)

- `rate = basal + 2 × insulinReq` for 30 min, i.e. a temp that would deliver insulinReq over 30 min if it ran to the end. If no SMB low temp was needed, it is set in the same loop as the SMB (the Trio parity example below shows both).
- Capped at `maxSafeBasal = min(max_basal, max_daily_safety_multiplier × max_daily_basal, current_basal_safety_multiplier × current_basal)`, with defaults 3 and 4 (Trio picker 1–5 for both; Trio fresh-install max_basal 2 U/h, picker default 10). Example: flat basal 0.5 U/h, max_basal 2 → min(2, 1.5, 2.0) = 1.5 U/h, i.e. at most +1.0 U/h above basal.
- If the running temp would deliver more than 2 × insulinReq, it is lowered; if it is already ≥ the required rate, it is left alone.

## Real example from Trio's parity tests (goldens/high-bg-rising-smb)

Profile: basal 0.9 U/h, ISF 55, target 95, max_iob 6, ratio 0.5, SMB/UAM minutes 30, SMB always + UAM on. State: BG 210 and rising (deviation +73), IOB 2.18 U, COB 0. oref output: eventualBG 163, minPredBG 148, minGuardBG 107 → `insulinReq = (148 − 95)/55 = 0.96 U`. Reason: "Microbolusing 0.4U. temp 0.75<2.8U/hr" — an SMB of 0.4 U (0.48 floored; cap 0.5) plus a 30-min temp of 2.8 U/h (0.9 + 2 × 0.96). A simple "(BG − target)/ISF" would be (210 − 95)/55 = 2.1 U, which is almost exactly the 2.18 U already on board. oref's 0.96 U comes from the ongoing rise, not from the current BG.

## How fast oref delivers a given need (worked example, our arithmetic)

Assumptions: 5-min CGM and loop; SMB enabled; ratio 0.5; 30-min caps; increment 0.1 U; flat basal 0.5 U/h, so max SMB 0.3 U and maxSafeBasal 1.5 U/h (+1.0 U/h). "Static need": insulinReq starts at 2.0 U and each delivered unit lowers it by 1 U, with no new rise. "Sustained need": glucose keeps rising so insulinReq stays ≥ 0.6 U every loop.

| Situation | by 15 min | by 30 min | by 60 min |
|---|---|---|---|
| Static 2.0 U, basal 0.5 U/h | ≈1.15 U (3 SMBs of 0.3 + 0.25 U temp) | ≈1.85 U | ≈1.95 U |
| Sustained, basal 0.5 U/h | ≈1.15 U | ≈2.3 U | ≈4.6 U (until max_iob) |
| Static 2.0 U, basal 1.0 U/h (max SMB 0.5, temp ≤ 3 U/h) | ≈1.75 U | ≈1.9 U | ≈2.0 U |
| Static 1.0 U, basal 0.3 U/h (max SMB 0.2, temp ≤ 0.9–1.2 U/h) | ≈0.75–0.85 U | ≈0.9 U | ≈0.97 U |

In words: SMB plus high temp hands out a static correction need over about 20–30 minutes, not at once. Half of the need is given at the first loop only if that half fits under the 30-min-basal cap; with low basal rates, as in children, the cap is what limits the first 15 minutes. A manual bolus delivers the same amount within about a minute, but insulin action peaks around 60–90 min (Trio rapid-acting curve peak 75 min, ultra-rapid 55 min), so the glucose effect of the two routes differs less than the delivery times suggest. If BG keeps rising, oref keeps dosing at about 4–8 U/h depending on basal. The limit is max_iob, not time.

## Notes for Mellis

- **Relevance:** Trio already corrects highs by itself when SMB is enabled (or by high temps when it is not, up to maxSafeBasal), as long as Max IOB > 0, the dosing mode is Closed Loop, CGM is fresh and no high temp target or SMB-off override is active. The correction it is still planning is exactly `insulinReq`, which is already net of IOB. oref itself gives only about 50% of it per step (Trio 0.3–0.7), capped at 30 min of basal, and re-decides every loop. Trio's calculator shows 80% of it as "Trio would give".
- Detecting whether the loop corrects highs: look in devicestatus for `units` > 0 / "Microbolusing" and for SMB treatments (Trio uploads them as boluses with automatic/SMB flags). A high temp at maxSafeBasal ("adj. req. rate … to maxSafeBasal") or "IOB … > max_iob" means the loop has hit its limits. "SMB disabled" text appears only for the maxDelta rule; other SMB-off reasons are not in the reason string.
- **Evidence level:** open-source algorithm code; constants are design choices, not trial-derived. Worked-example numbers are our own idealized arithmetic (constant deviation, 5-min loops) and real delivery depends on the forecast at each loop.
