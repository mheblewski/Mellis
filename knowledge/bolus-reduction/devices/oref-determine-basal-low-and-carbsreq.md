---
id: oref-determine-basal-low-and-carbsreq
title: "oref0 determine-basal (MIT): threshold=(min_bg+40)/2 (Trio clamps 60-120, default 60), predBGs 48x5 min = 4 h, minPredBG waits 90 min, minGuardBG<threshold -> SMB off + 30-120 min zero temp, carbsReq=(threshold-naiveEventualBG-zeroTempEffect)/CSF - (COB-25% carbs), shown if >=threshold g and low within 45 min"
publisher: "openaps/oref0 `lib/determine-basal/determine-basal.js`, branch `master` at 88cf032aa74ff25f69464a7d9cd601ee3940c0b3"
url: https://github.com/openaps/oref0/blob/88cf032aa74ff25f69464a7d9cd601ee3940c0b3/lib/determine-basal/determine-basal.js
licence: "Own text (Mellis); short code excerpts from openaps/oref0 under the MIT License"
licence_url: https://opensource.org/license/mit
mode: SUMMARY_ONLY
language: en
retrieved: 2026-10-21
topics: [bolus-reduction, hypoglycaemia, rescue-carbs, trio, oref, smb, settings]
index: true
corpus_v7: bolus-reduction/devices/oref-determine-basal-low-and-carbsreq.md
---

*Our summary or notes (Mellis knowledge base), written in our own words with short quotes only; not the original text and not medical advice. Original: https://github.com/openaps/oref0/blob/88cf032aa74ff25f69464a7d9cd601ee3940c0b3/lib/determine-basal/determine-basal.js.*

# oref0/oref1 determine-basal: eventualBG, minPredBG, minGuardBG, low threshold, insulinReq and carbsReq (source-code notes)

- **Type:** Source-code notes (OpenAPS reference design algorithm, used by OpenAPS rigs and, in forked/ported form, by Trio and AndroidAPS)
- **Journal/year:** openaps/oref0 `lib/determine-basal/determine-basal.js`, branch `master` at 88cf032aa74ff25f69464a7d9cd601ee3940c0b3 (2022-06-19); cross-checked against branch `dev` at d219baf9559d62a8bb0bd42014192a2d7c0839ef (2026-03-10) and Trio's fork/port (nightscout/Trio 0b29cd5: `trio-oref/lib/determine-basal/determine-basal.js`, `Trio/Sources/APS/OpenAPSSwift/DetermineBasal/DosingEngine.swift`, `DetermineBasal+Helpers.swift`)
- **DOI:** none
- **URL:** https://github.com/openaps/oref0/blob/88cf032aa74ff25f69464a7d9cd601ee3940c0b3/lib/determine-basal/determine-basal.js
- **Licence:** MIT (openaps/oref0). Short code excerpts quoted; the rest is our description.
- **Saved:** notes from the GitHub source on 2026-10-21 for the Mellis RAG corpus. The OpenAPS docs pages on oref1, "Understanding the determine-basal logic" and IOB are already in the corpus; this file adds the exact formulas and constants from the code for the low/falling/meal-while-low case.

## Inputs used below

- `bg` = latest CGM glucose; `delta` = last 5-min change; `short_avgdelta` ≈ average 5-min change over roughly the last 15 min; `long_avgdelta` ≈ the same over roughly the last 45 min (from glucose-get-last).
- `minDelta = min(delta, short_avgdelta)`; `minAvgDelta = min(short_avgdelta, long_avgdelta)`.
- `sens` = ISF (autosens-adjusted); `min_bg`, `target_bg`, `max_bg` from the profile/temp target; `csf = sens / carb_ratio` (mg/dL per g).
- `bgi = −activity × sens × 5` = expected 5-min change from insulin alone.

## Low threshold

```js
// min_bg of 90 -> threshold of 65, 100 -> 70 110 -> 75, and 130 -> 85
var threshold = min_bg - 0.5*(min_bg-40);
```

So threshold = (min_bg + 40)/2 (mg/dL). Trio additionally clamps it: `threshold = min(max(threshold_setting, threshold, 60), 120)`, with Trio's `threshold_setting` default 60 mg/dL (user-adjustable), i.e. never below 60 and never above 120 mg/dL. (AndroidAPS has its own similar user setting; not verified here.)

## eventualBG ("bolus-calculator math" plus 30 min of deviation)

```js
var naive_eventualBG = round( bg - (iob_data.iob * sens) );   // if IOB > 0
var eventualBG = naive_eventualBG + deviation;
```

- `naive_eventualBG` is exactly the bolus-calculator idea: current BG minus what all IOB will still lower it (when IOB is negative, the lower of autosens ISF and profile ISF is used, to be conservative).
- `deviation = 6 × (minDelta − bgi)`, i.e. the current difference between observed and insulin-expected change, projected for 30 min; if negative, the code uses `minAvgDelta` and then `long_avgdelta` to avoid over-reacting to one big drop.
- Later, if there are COB and carb absorption, `eventualBG = max(eventualBG, last COBpredBG)`, and with UAM enabled `max(eventualBG, last UAMpredBG)`. So eventualBG is the end of the forecast (when insulin and carbs have acted), not the minimum.
- `expectedDelta = bgi + (target_bg − eventualBG)/24`: the 5-min change that would bring eventualBG to target over 2 h.

## Prediction curves and horizon

- Four curves are built in 5-min steps from the IOB array: IOB (insulin + deviation decaying linearly to 0 over 60 min), COB (insulin + modelled carb absorption, including "remaining carbs" assumed to absorb in a /\ shape over `remainingCATime`, minimum 3 h, longer for large/late meals), UAM (deviation decaying at the observed slope, at most over 3 h) and ZT (zero-temp: insulin effect if basal were stopped now, no deviations).
- Every curve is truncated at 48 points: `if ( IOBpredBGs.length < 48) { IOBpredBGs.push(IOBpredBG); }` → 48 × 5 min = 4 h. Values are clipped to 39–401 mg/dL.
- Carb absorption assumptions in the COB curve: when no carb impact is observed, at most 30 g/h is assumed for the current impact (`maxCarbAbsorptionRate = 30`), remaining carbs are assumed to absorb at 20 g/h ("<= 90g is assumed to take 3h, and 120g=4h"), remaining carbs are capped at 90 g (`remainingCarbsCap`).

## minGuardBG vs minPredBG

- **minGuardBG** = the lowest point of the relevant curve from now on, with no waiting: minCOBGuardBG/minUAMGuardBG blended by the fraction of carbs left when there are COB, otherwise minIOBGuardBG. It is the "will we go low at any time in the next 4 h" number and is what triggers low-glucose suspend.
- **minPredBG** = the lowest point of the curves only after insulin activity would peak, used for dosing more insulin. The code waits: minIOBPredBG only after 90 min (`insulinPeakTime = 90`, i.e. 60 min + 30 min for delivery), COB minimum also after 90 min, UAM minimum after 60 min (12 points). It is then blended (COB vs UAM vs ZT), floored at 39, and never allowed above avgPredBG: `minPredBG = Math.min( minPredBG, avgPredBG );`. If the COB curve "falls off a cliff", `minPredBG = min(minPredBG, maxCOBPredBG)` when maxCOBPredBG > bg.
- Both appear in the reason string ("minPredBG …, minGuardBG …, IOBpredBG …, COBpredBG …, UAMpredBG …"); Trio's bolus calculator parses minPredBG from that string.

## What oref does when BG is low or a low is predicted

In order of the code:

1. **SMB disabled** if `minGuardBG < threshold` ("projected below … - disabling SMB"), and SMBs are anyway only allowed when `bg > threshold`. SMB is also disabled if `maxDelta > 20%` of BG (sudden rise, default `maxDelta_bg_threshold = 0.2`, capped at 0.3).
2. **carbsReq** (see below) is computed and reported if large enough.
3. **Predictive low-glucose suspend:** if `bg < threshold || minGuardBG < threshold` → zero temp basal for 30–120 min:

   ```js
   bgUndershoot = target_bg - minGuardBG;
   var worstCaseInsulinReq = bgUndershoot / sens;
   var durationReq = round(60*worstCaseInsulinReq / profile.current_basal);
   // always set a 30-120m zero temp
   ```

   Exception: no suspend if BG < threshold but IOB is already very negative (`iob < −basal × 20/60`) and BG is rising faster than expected.
4. **eventualBG < min_bg:** low temp. If BG is already rising faster than expected and no carbs are required, it just keeps basal (or 30-min zero temp if naive_eventualBG < 40). Otherwise `insulinReq = 2 × min(0, (eventualBG − target_bg)/sens)` (negative), scaled down if only barely falling, and converted to a 30-min rate `basal + 2 × insulinReq`; if that is ≤ 0 a zero temp of up to 120 min is set.
5. **Falling faster than expected** (`minDelta < expectedDelta`) with eventualBG ≥ min_bg: keep scheduled basal (unless SMB mode).
6. **Only if none of the above:** `insulinReq = (min(minPredBG, eventualBG) − target_bg) / sens`, limited by `max_iob − IOB`; SMB = half of insulinReq (oref0; Trio has a configurable SMB delivery ratio) up to maxSMBBasalMinutes/maxUAMSMBBasalMinutes of basal (default 30 min), only if `bg > threshold`.

Note: in upstream oref0 the returned `rT.insulinReq` is initialised to 0 and is only set on path 6; the negative low-temp insulinReq of path 4 is used for the temp rate, not returned. (Trio's Swift port follows the same structure; Trio treats any non-positive insulinReq as "no bolus".)

## carbsReq ("carbs required to avoid a hypo")

```js
var carbsReqBG = naive_eventualBG;
if ( carbsReqBG < 40 ) { carbsReqBG = Math.min( minGuardBG, carbsReqBG ); }
var bgUndershoot = threshold - carbsReqBG;
var zeroTempEffect = profile.current_basal*sens*zeroTempDuration/60;
var COBforCarbsReq = Math.max(0, meal_data.mealCOB - 0.25*meal_data.carbs);
var carbsReq = (bgUndershoot - zeroTempEffect) / csf - COBforCarbsReq;
```

- In words: carbs needed = (how far naive eventual BG ends below the low threshold − how much a zero temp until the curve crosses the threshold would raise BG) ÷ (mg/dL per gram), minus COB not yet absorbed (the last 25% of the entered carbs is not counted as protection).
- `zeroTempDuration = minutesAboveThreshold` = time until the COB curve (if carbs are absorbing) or the IOB curve first drops below the threshold, max 240 min.
- Reported only if `carbsReq >= profile.carbsReqThreshold && minutesAboveThreshold <= 45` (reason text "N add'l carbs req w/in M m"). Default carbsReqThreshold is 1 g in Trio (other oref implementations' defaults were not checked).
- Because it is based on naive_eventualBG (BG − IOB × ISF), carbsReq is mainly driven by IOB that BG cannot "afford"; a meal entered as COB reduces it.

## Meal entered while BG is low or falling (what oref does by itself)

- The meal's carbs enter COB and the COB curve, which raises eventualBG and later minPredBG, but low-glucose protection is based on minGuardBG (the minimum at any time, including the next minutes before the carbs act). If BG or minGuardBG is below the threshold, oref keeps a 30–120 min zero temp and gives no SMB, even with COB.
- oref itself never gives a meal bolus; it only adds SMB/temp basal once BG > threshold, minGuardBG ≥ threshold and min(minPredBG, eventualBG) > target. The pre-bolus at a meal is the user's (bolus calculator) decision.

## Notes for Mellis

- **Relevance:** These are the exact quantities Trio exposes (eventualBG, minPredBG, minGuardBG, carbsReq, predBGs IOB/COB/UAM/ZT up to 4 h) and that Mellis reads from Nightscout devicestatus. For a "reduce the meal bolus" rule: minGuardBG < threshold means oref is already suspending and wants no extra insulin now; carbsReq > 0 means IOB alone is expected to push BG below the threshold within 45 min even with a zero temp, i.e. the current IOB already exceeds what BG can absorb — a meal bolus at that moment should at least subtract that deficit (carbsReq × CR as insulin) or the meal should partly serve as the hypo treatment.
- Threshold defaults: (min_bg + 40)/2 in oref0 (e.g. min_bg 100 → 70 mg/dL); Trio clamps to 60–120 mg/dL with user setting default 60.
- minPredBG ignores the first 60–90 min of the forecast; for "low in the next hour" questions use minGuardBG or the predBG curves, not minPredBG. (Trio's calculator gate uses minPredBG < 54.)
- **Evidence level:** documentation/code of an open-source algorithm; constants are design choices, not trial-derived.
