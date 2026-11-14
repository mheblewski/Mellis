---
id: loopdocs-loop-3-therapy-settings
title: "LoopDocs: Loop 3 Therapy Settings: Glucose Safety Limit, Correction and Pre-Meal Range, CR, basal, Delivery Limits, ISF and their guardrails"
publisher: "LoopDocs (LoopKit)"
url: https://loopkit.github.io/loopdocs/loop-3/therapy-settings/
licence: "Own summary (Mellis); original: LoopDocs has no licence file: paraphrased with short quotes only"
licence_url: https://github.com/LoopKit/loopdocs
mode: SUMMARY_ONLY
language: en
retrieved: 2026-11-14
topics: [loop, settings, targets, limits, insulin, correction, bolus-calculator, hypoglycaemia, aid]
index: true
---

*Our summary (Mellis knowledge base) of a LoopDocs page, written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/loop-3/therapy-settings/.*

# LoopDocs: Loop 3 Therapy Settings and guardrails

## Where Loop Therapy Settings are set [section "Loop Therapy Settings"]

Loop therapy settings are first entered during onboarding, later changed in Loop Settings, Therapy Settings (shown only once a pump is added). When Loop 3 is built over Loop 2.2.x, the old values are carried over where possible and offered as the starting value on each screen.

## Authorization for Therapy Settings [section "Authorization Required"]

Changing any Loop Therapy Setting requires the same authorization as giving a manual bolus: Face ID, fingerprint or passcode.

## Typical values, colours and closed loop [section "Details for Therapy Settings"]

Loop 3 has guardrails for several therapy settings. A value outside the "typical" range is shown in yellow on the picker and needs a warning to be acknowledged. LoopDocs stresses that choosing a yellow or even red value is fine when being cautious, for example a higher-than-typical Correction Range while learning Loop, and adjusting it later with the healthcare team.

The Therapy Settings drive automatic insulin delivery in Closed Loop, so settings that are not well tuned before closing the loop can lead to too much or too little automated insulin. During onboarding the save button reads "Confirm Setting"; afterwards it reads "Save".

## Glucose Safety Limit [section "Glucose Safety Limit"]

In Loop's words: "Loop will deliver basal and recommend bolus insulin only if your glucose is predicted to be above the Glucose Safety Limit for the next three hours." It is set with a picker wheel; a higher limit is acceptable even if shown in yellow, and can be revisited after some time on Loop. The chosen Glucose Safety Limit is the floor for the Correction Range and the Pre-Meal Range: neither can be set lower.

## Correction Range [section "Correction Range"]

The Correction Range is the glucose value or range Loop aims for when it adjusts basal and when it helps calculate boluses. It is added with the + sign, picker wheels and "Add"; the first entry must start at midnight and further rows can be added for other times of day. A warning screen appears if a value is outside typical. A higher-than-typical range at the start is fine and can be revisited later.

## Manual vs automated dosing below the Correction Range [section "Manual vs Automated Dosing"]

Loop forecasts glucose for the next 6 hours (DIA) and, in closed loop, uses or recommends the smallest amount of insulin that reaches the target, meaning the Correction Range midpoint, across the whole forecast.

If a manual bolus recommendation is requested while current glucose is under the bottom of the Correction Range but above the Glucose Safety Limit, Loop recommends an amount meant to keep glucose above the safety limit. That applies only to a manual request: Loop will not add extra insulin automatically (high temp basal or automatic bolus) until current glucose is above the bottom of the Correction Range.

## Pre-Meal Range [section "Pre-Meal Range"]

The Loop Pre-Meal Range lowers the glucose target for a short time before eating to soften the after-meal rise. It is optional: if no Pre-Meal Range is entered, the Pre-Meal icon in the toolbar is disabled, which some users prefer. An existing entry can be removed with "Delete" then "Save". When set, tapping the icon activates it for 1 hour, or until carbs are entered, or until the user cancels it.

## Carb Ratios [section "Carb Ratios"]

The Loop Carb Ratio is how many grams of carbohydrate one unit of insulin covers. At least one is required; Loop allows 1 to 48 carb ratios per day, added the same way as Correction Range rows.

## Basal Rates [section "Basal Rates"]

The Loop basal rate is units per hour for background insulin needs. Loop allows 1 to 48 rates per day; the schedule starts at midnight and cannot consist of a single 0 U/hr rate.

## Delivery Limits screen [section "Delivery Limits"]

Loop's Delivery Limits are Maximum Basal Rate and Maximum Bolus; tapping one opens its picker. After onboarding, at least one of the two must change before `Save` becomes active, so check both values (scrolling away from the picker shows the other) before saving.

## Maximum Basal Rate [section "Maximum Basal Rate"]

Maximum Basal Rate is the highest automatic temp basal Loop may set to reach the correction range. Some users pick 2, 3 or 4 times their highest scheduled basal rate; LoopDocs says to choose, with the healthcare provider, a value above the highest scheduled rate that is as cautious or aggressive as feels comfortable. With the Temp Basal Only dosing strategy, Maximum Basal Rate is the setting that limits how much extra insulin Loop can give automatically.

## Maximum Bolus and Maximum Automatic IOB [section "Maximum Bolus"]

Maximum Bolus is the largest single bolus Loop will recommend or let the user give in one action, for carbs or for high glucose. It also sets a cap for automated dosing:

- Maximum Automatic IOB is twice the Maximum Bolus. Loop will not automatically dose anything that would push IOB above it.
- A manual bolus can take IOB above Maximum Automatic IOB, but the recommended manual bolus is limited by Maximum Bolus.
- Typing a manual amount above Maximum Bolus and pressing `Deliver` gives a warning and Loop refuses to deliver it.
- With Automatic Bolus, a single automatic bolus is at most 40% of Maximum Bolus, but it can repeat every 5 minutes, always keeping IOB below 2 × Maximum Bolus.

LoopDocs suggests not setting it above the usual large-meal bolus; many people choose just under 10 U (for example 9 or 9.9 U) so that typing 10 instead of 1.0 is blocked.

## Insulin Sensitivities (ISF) [section "Insulin Sensitivities"]

Loop's Insulin Sensitivity is the glucose drop expected from one unit of insulin over the full insulin action time; it is the same thing as Correction Factor or Insulin Sensitivity Factor (ISF). At least one is required; Loop allows 1 to 48 per day.

## Loop guardrail colours [section "Guardrails for Settings"]

Each Loop guardrail has a hard lower limit, a recommended minimum, a recommended maximum and a hard upper limit; some are also bounded by other settings. Picker font colours: black means inside Loop's recommended range, yellow means outside what is typical (still allowed and sometimes a good choice for a new user), red means the allowed minimum or maximum. Experienced users can change guardrails with code customization.

## Guardrails: Glucose Safety Limit [section "Guardrails for Glucose Safety Limit"]

Loop allows a Glucose Safety Limit from 67 to 110 mg/dL (3.7 to 6.0 mmol/L); the recommended band is 74 to 80 mg/dL (4.2 to 4.4 mmol/L). The highest value offered is also capped by the lowest of the code limit, the Correction Range and the Pre-Meal Range.

## Guardrails: Correction Range [section "Guardrails for Correction Range"]

Loop allows a Correction Range from 87 to 180 mg/dL (4.8 to 10.0 mmol/L), recommended 100 to 115 mg/dL (5.6 to 6.3 mmol/L). The lowest value offered is the higher of the code limit and the Glucose Safety Limit.

## Guardrails: Pre-Meal Range [section "Guardrails for Pre-Meal Range"]

The Loop Pre-Meal Range has no separate lower code limit: its floor is the Glucose Safety Limit. Recommended maximum 106 mg/dL (5.9 mmol/L), absolute maximum 130 mg/dL (7.2 mmol/L).

## Guardrails: Basal Rates and Maximum Basal Rate [section "Guardrails for Basal Rates" / "Guardrails for Maximum Basal Rate"]

Loop basal rates are bounded by the chosen pump; without a pump, generic limits of 0.05 to 30 U/hr in 0.05 steps apply. Once Maximum Basal Rate is set, it is the top of the basal picker.

For Maximum Basal Rate, values up to 6.4 times the highest scheduled basal rate are recommended; higher values, where offered, show in yellow. The absolute maximum is whichever is higher: 70 divided by the smallest carb ratio in the schedule, or the pump's maximum rate. So depending on basal and CR schedules, the picker may go above 6.4 times the highest basal.

## Guardrails: Maximum Bolus [section "Guardrails for Maximum Bolus"]

Loop's Maximum Bolus is bounded by the pump; LoopDocs recommends keeping it at the usual "big" meal dose. The 2 × Maximum Bolus automatic IOB cap applies with both Temp Basal Only and Automatic Bolus.

## Guardrails: Carb Ratios and Insulin Sensitivities [section "Guardrails for Carb Ratios" / "Guardrails for Insulin Sensitivities"]

Both CR and ISF are divisors in the dose calculation, so a lower number is stronger and a higher number weaker.

- Loop Carb Ratio: allowed 2.0 to 150.0 g/U, recommended 4.0 to 28.0 g/U.
- Loop Insulin Sensitivity: allowed 10 to 500 mg/dL/U (0.6 to 27.8 mmol/L/U), recommended 16 to 399 mg/dL/U (0.9 to 22.1 mmol/L/U).
