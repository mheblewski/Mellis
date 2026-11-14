---
id: loopdocs-operation-algorithm-auto-adjust
title: "LoopDocs: Automatic dosing adjustments: Loop's four actions, temp basal and automatic bolus sizing in closed loop"
publisher: "LoopDocs (LoopKit)"
url: https://loopkit.github.io/loopdocs/operation/algorithm/auto-adjust/
licence: "Own summary (Mellis); original: LoopDocs has no licence file: paraphrased with short quotes only"
licence_url: https://github.com/LoopKit/loopdocs
mode: SUMMARY_ONLY
language: en
retrieved: 2026-11-14
topics: [loop, aid, limits, targets, correction, smb, settings]
index: true
---

*Our summary (Mellis knowledge base) of a LoopDocs page, written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/operation/algorithm/auto-adjust/.*

# LoopDocs: automatic dosing adjustments in Loop

## How Loop calculates an automatic dose [section "Calculated Dose"]

In Closed Loop mode, Loop first works out a recommended dose, which may be positive or negative, with all its safety checks applied. It then delivers that adjustment according to the chosen Dosing Strategy, always within the Maximum Basal Rate and Maximum Bolus from Therapy Settings. This repeats with every CGM value, typically every 5 minutes. A recommended decrease is always delivered as a temp basal below the scheduled rate.

Every Loop temp basal is set for 30 minutes. If the phone loses contact with the pump, the last temp runs for at most 30 minutes and the pump then returns to the scheduled basal. Loop may set a new temp every 5 minutes.

- **Temp Basal Only** dosing strategy: a recommended increase becomes a temp basal above the scheduled rate.
- **Automatic Bolus** dosing strategy: a recommended increase is given promptly as an automatic bolus that is smaller than the full recommendation.

## When Loop gives no automatic insulin increase [section "No Automatic Dosing"]

If the whole forecast sits below the correction range but above the Glucose Safety Limit, Loop does not raise insulin automatically. The user can still open the bolus tool and get a manual recommendation, but there is no automatic bolus or high temp until glucose is above the bottom of the correction range. Using the Pre-Meal button or a named override with a lower correction range can help Loop start delivering automatically after meals.

## Loop's four possible actions [section "Four Possible Actions"]

On each new glucose reading Loop does one of four things: decrease basal, increase basal (or give an automatic bolus), set basal to zero, or resume scheduled basal. With the Automatic Bolus strategy, an increase is given as a share of the recommended bolus rather than a higher temp; the default share is 40 %. With the Algorithm Experiments option Glucose Based Partial Application, the share runs from 20 % at lower glucose to 80 % at higher glucose.

## Loop decreases basal [section "Decrease Basal Rate"]

When eventual glucose is below the correction range and every predicted value stays above the suspend threshold, Loop sets a temp basal below the scheduled rate to bring eventual glucose back up to the correction target.

## Loop increases basal or gives an automatic bolus [sections "Increase Basal Rate", "Deliver Automatic Bolus with Scheduled Basal"]

When eventual glucose is above the correction range and every predicted value is both above the suspend threshold and at or above the correction range, Loop acts to bring eventual glucose down to the correction target. With Temp Basal Only it sets a temp above the current basal. With Automatic Bolus it cancels any running temp (back to scheduled basal) and gives an automatic bolus.

## Loop sets a zero temp basal [section "Zero the Basal Rate"]

If the minimum predicted glucose falls below the suspend threshold (Glucose Safety Limit), Loop sets a 0 U/hr temp basal regardless of the eventual glucose.

## Loop resumes scheduled basal [section "Resume Basal Rate"]

Loop returns to the scheduled basal in three cases:

1. Eventual glucose is within the correction range and all predicted values are above the suspend threshold.
2. Eventual glucose is above the correction range, but the forecast dips temporarily below the correction range while staying above the suspend threshold.
3. Loop lacks some of the data it needs for a prediction. It then lets the running temp finish (at most 30 minutes) and the pump falls back to scheduled basal, the same as ordinary pump therapy.

## How Loop sizes the dose [section "Determine the Recommended Bolus"]

When Loop is going to raise basal or give an automatic bolus, it sizes the dose with the usual correction arithmetic: the gap between eventual predicted glucose and the correction target, divided by ISF. The difference from classic pump therapy is that Loop works from predicted eventual and minimum glucose rather than only current glucose, and repeats the calculation every 5 minutes. With Temp Basal Only the dose becomes a temp basal (next section); with Automatic Bolus the delivered amount is a reduced share of the dose.

## How Loop turns the dose into a temp basal [section "Determine the Temporary Basal Rate"]

With Temp Basal Only, Loop delivers the dose over its 30-minute temp duration, so the extra rate is twice the dose per hour. That extra is added to the scheduled basal, and the result is capped at the Maximum Basal Rate and never set below 0 U/hr. If a suitable temp is already running with at least 10 minutes left, Loop does not reissue it; if the new rate differs from the running temp (or from scheduled basal when no temp runs), Loop replaces it. The check repeats every 5 minutes.

## Loop temp basal worked examples [sections "Temporary Basal Rate Calculation Example", "More Temporary Basal Examples"]

Example on the page: eventual glucose 200 mg/dL, target 100 mg/dL, ISF 50 mg/dL/U, scheduled basal 1 U/hr, Maximum Basal Rate 6 U/hr. The dose is (200 - 100) ÷ 50 = 2 U, which is 4 U/hr extra over 30 minutes, so the required rate is 5 U/hr. That is under the 6 U/hr maximum, so Loop runs 5 U/hr for 30 minutes.

With the same settings at other eventual glucose values:

- 300 mg/dL: dose 4 U, required 9 U/hr, capped to 6 U/hr.
- 100 mg/dL: dose 0, Loop keeps 1 U/hr (scheduled).
- 90 mg/dL: dose -0.2 U, temp 0.6 U/hr.
- 75 mg/dL: dose -0.5 U, temp 0 U/hr.
- 50 mg/dL: dose -1 U, required rate would be negative, so the temp is 0 U/hr.

The temp rate is never negative and never above the Maximum Basal Rate.
