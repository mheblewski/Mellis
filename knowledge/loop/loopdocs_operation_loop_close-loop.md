---
id: loopdocs-operation-loop-close-loop
title: "LoopDocs: Loop Closed Loop: starting conservatively, Temp Basal Only vs Automatic Bolus, reading IOB, meals, and when Loop does not add insulin"
publisher: "LoopDocs (LoopKit)"
url: https://loopkit.github.io/loopdocs/operation/loop/close-loop/
licence: "Own summary (Mellis); original: LoopDocs has no licence file: paraphrased with short quotes only"
licence_url: https://github.com/LoopKit/loopdocs
mode: SUMMARY_ONLY
language: en
retrieved: 2026-11-14
topics: [loop, aid, smb, limits, settings, targets, bolus-calculator, hypoglycaemia, education]
index: true
---

*Our summary (Mellis knowledge base) of a LoopDocs page, written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/operation/loop/close-loop/.*

# LoopDocs: moving Loop to Closed Loop

## Timing the switch to Loop Closed Loop [section "Closed-Loop" / "Timing"]

After Open Loop, LoopDocs suggests moving to closed loop in steps, at a calm time such as a weekend, possibly at a time without food, such as overnight.

## Start Closed Loop with a limited Maximum Basal Rate [section "Maximum Basal Rate"]

Start conservatively: Temp Basal Only and a limited maximum basal rate cap the harm if meal entries or basal, CR or ISF are wrong. Experienced users usually set the closed-loop maximum basal at no more than 3-4 times their average basal rate. Move to Automatic Bolus only after getting comfortable with the slower corrections of Temp Basal Only.

Both strategies recompute the prediction and a recommended bolus or restriction with each reading (normally every 5 minutes). Temp Basal Only delivers at most about 17% of that recommended bolus per 5-minute interval through temp basal; Automatic Bolus gives 40% of it as an immediate bolus. When Loop wants less insulin, both use temp basals below scheduled basal, often 0 U/hr.

## Correction Range at the start of Closed Loop [section "Glucose Correction Range"]

If basal, ISF or carb ratios are off, Loop may give more insulin than needed to reach the chosen correction range. LoopDocs suggests a slightly higher correction range at first to help avoid unexpected lows while settings are being tuned.

## Watching IOB to check basal and ISF [section "Watch the IOB"]

With no food, consistently positive or negative IOB while Loop holds glucose steady suggests reviewing basal or ISF; glucose should level off as IOB returns to zero. Glucose falling below the correction range and still dropping while IOB goes negative may mean basal is too high; glucose staying above range while IOB stays positive may mean basal is too low. ISF matters too, but basal should be checked first.

## Meals in Closed Loop and avoiding double carb entries [section "Meals"]

In Loop, carbs are saved the moment `Save and Bolus` or `Save without Bolusing` is tapped on the Meal Bolus screen, even if the bolus then fails to reach the pump. If a notification appears after saving carbs, check the carb entries in Loop rather than entering them again.

Start with well-known meals. If Loop's meal recommendation is lower or higher than expected:

- falling glucose may mean Loop is trying to prevent a low;
- rising glucose may mean Loop is adding a correction to the meal dose;
- the carb amount and absorption time can be changed to see the effect, and the suggestion can be overridden;
- Loop may suspend basal right away;
- after the first meal recommendation, Loop waits to see glucose rise before deciding more insulin is needed;
- Loop gives no more insulin automatically until glucose is above the lower end of the correction range, though it will recommend a manual bolus.

## Loop automated dosing: two examples [section "Automated Dosing" / "Bolus with No Carbs" / "Carbs with No Bolus"]

Usually carbs are entered with Loop's recommended bolus; LoopDocs explains two other cases.

- **Bolus without carbs:** the forecast goes low (Loop computes a negative recommended bolus), so Loop sets a temp basal below scheduled basal, typically 0.0 U/hr, to prevent the low. COB is the carbs Loop still expects to absorb; IOB is active insulin above or below scheduled basal.
- **Carbs saved without bolus (`Save without bolusing`):** there is COB but no matching IOB, so Loop predicts a rise and computes a recommended bolus that respects the Glucose Safety Limit, Correction Range and Maximum Bolus. If positive, Loop may give part of it automatically, how much and how fast depending on the Dosing Strategy. Each cycle it recalculates; if glucose does not rise as expected, it scales the recommendation back.

## When Loop does not automatically increase insulin [section "When does Automatic Dosing Happen"]

Loop doses automatically only with Closed Loop on. It forecasts 6 hours ahead (the insulin action time) and compares the forecast with the scheduled Correction Range over the whole period, giving nearer predictions more weight. Even when the forecast at the end of DIA is well above the Correction Range, Loop does not automatically add insulin when:

- glucose is predicted below the Glucose Safety Limit at any point in the next 3 hours: temp basal goes straight to 0.0 U/hr and recommended bolus to 0 U;
- the forecast dips below the low end of the Correction Range: no automatic increase over scheduled basal;
- current glucose is below the low end of the Correction Range: no automatic increase;
- current IOB is at or above twice the Maximum Bolus: no automatic increase.

In these cases a positive recommendation may still appear when the Bolus icon is tapped manually (except in the safety-limit case, where it is 0 U).
