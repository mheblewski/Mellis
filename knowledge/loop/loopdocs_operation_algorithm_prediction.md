---
id: loopdocs-operation-algorithm-prediction
title: "LoopDocs: Glucose prediction: how Loop builds its forecast from insulin, carbs, retrospective correction and momentum"
publisher: "LoopDocs (LoopKit)"
url: https://loopkit.github.io/loopdocs/operation/algorithm/prediction/
licence: "Own summary (Mellis); original: LoopDocs has no licence file: paraphrased with short quotes only"
licence_url: https://github.com/LoopKit/loopdocs
mode: SUMMARY_ONLY
language: en
retrieved: 2026-11-14
topics: [loop, aid, insulin, nutrition, settings, education]
index: true
---

*Our summary (Mellis knowledge base) of a LoopDocs page, written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/operation/algorithm/prediction/.*

# LoopDocs: how Loop predicts glucose

## Four effects behind the Loop forecast [section "Glucose Prediction"]

Loop is a model predictive control (MPC) system. Its predicted glucose curve is built from four separate effects: insulin, carbohydrates, retrospective correction and glucose momentum. Insulin, carbs and retrospective correction are added together; momentum is not simply added but blended into the first minutes of the forecast (see the momentum section). Loop recalculates the prediction every five minutes, once a new CGM value has arrived and the pump status has been refreshed. Tapping the glucose chart on the Loop main screen opens the Predicted Glucose chart, which shows each effect's contribution. LoopDocs calls the page fairly technical; the overview, bolus and temp basal pages are enough for a general understanding.

## What each effect does to the Loop prediction [section "Overview"]

- Insulin (boluses and temp basals) pulls the prediction down.
- Carbohydrates push it up.
- Momentum can push either way, depending on the trend of the latest CGM readings, and only for a short time.
- Retrospective correction lowers the prediction when glucose recently rose less than Loop had expected (and raises it in the opposite case).

## Insulin effect and insulin models in Loop [section "Insulin Effect"]

Insulin acts with a delay, peaks about one hour after delivery and then fades. Loop uses an exponential insulin model with an insulin activity duration of 6 hours. The rapid-acting (Humalog, Novolog, Apidra type) and ultra-rapid (Fiasp, Lyumjev type) curves are exponential shapes chosen to roughly match label data and observations in adults and children. Afrezza is available as a non-pump insulin. The insulin type is chosen in the Pump Settings screen; every type is just a different set of parameters in the same exponential model. The old Walsh model is no longer used, and the separate child model for rapid-acting insulin is no longer offered by default (it can only be restored with a build-time flag).

## Insulin remaining, active insulin and expected drop in Loop [sections "Insulin Effect Remaining", "Active Insulin", "Expected Change in Glucose for Each Loop Interval", "Insulin Effect on Glucose Over Time"]

The share of a dose still active falls along an exponential decay curve. Example from the page: with an ISF of 50 mg/dL (2.7 mmol/L) per unit, 2 U is expected to lower glucose by 100 mg/dL (5.4 mmol/L) spread over the following 6 hours. Active insulin (IOB) at any moment is the dose multiplied by the fraction of activity remaining. From the cumulative drop Loop derives how much glucose should fall in each 5-minute step; the change per step equals the ISF in force at the time of the dose times the insulin activity in that step. The page's illustration starts from 205 mg/dL with 2 U given at 12 pm.

ISF can vary by time of day and with overrides. Loop applies the ISF that was valid when each dose was given and sums the effects of all doses still active. Insulin activity explicitly counts temp basals and boluses; scheduled basal is treated as balancing the body's own glucose production (EGP).

## How Loop treats scheduled basal rates [section "Treatment of Scheduled Basal Rates"]

Loop assumes the user's scheduled basal rates are correct and measures every insulin effect relative to them. If basal is not quite right, retrospective correction and momentum can compensate somewhat; wrong carb amounts or absorption times are handled in a similar way by the carb model. The insulin delivery chart shows temp basals relative to schedule: "+0" means the scheduled rate is running, positive bars mean more than scheduled, negative bars mean less.

Examples given: with 1 U/hr scheduled, a 3 U/hr temp is counted as +2 U/hr of extra insulin. A 0 U/hr temp for 1 hour is counted as -1 U/hr, so with an ISF of 50 mg/dL Loop predicts a rise of 50 mg/dL over the 6-hour activity duration.

## Total active insulin and total insulin effect in Loop [sections "Total Active Insulin", "Total Insulin Effect"]

Loop stacks the active insulin of every bolus and temp basal from the past 6 hours to project IOB over the next 6 hours, and shows this on its insulin charts. The total insulin effect at a given time is the sum of the effects of all active doses; it appears as the "Insulin" curve on the predicted glucose screen.

## Carbohydrate effect in Loop [section "Carbohydrate Effect"]

How fast carbs raise glucose depends on the food. High-glycaemic foods such as candy, juice and fruit act fast and briefly; lower-glycaemic foods such as pizza, burritos and quesadillas act slowly over longer. Gastroparesis can change absorption, and adjunct drugs (Metformin, GLP-1, SGLT2i, Pramlintide) may call for longer absorption times and shorter prebolus times. The user enters a rough absorption time; Loop treats it as a middle estimate and shortens or lengthens it according to the glucose change it observes. Every carb entry is assumed to start absorbing only after 10 minutes.

## Minimum absorption rate in Loop (linear explanation) [section "Linear Carbohydrate Absorption"]

LoopDocs explains carb handling with a linear model for simplicity, but Loop has actually used a non-linear absorption model since Loop 2.0. Because under-dosing is safer for long meals, Loop starts from a conservative minimum absorption rate: the carb grams spread over 150 % of the entered absorption time. Example: 72 g with 4 hours entered gives 12 g/hr over 6 hours.

## Dynamic carb absorption and insulin counteraction effect (ICE) in Loop [section "Dynamic Carbohydrate Absorption"]

Loop compares the glucose change it actually observes with the change it expected from insulin alone. The difference is the insulin counteraction effect (ICE, in mg/dL per 5 min). ICE can come from more than carbs (exercise, sensitivity changes, wrong basal or ISF), but after recorded meals Loop assumes the rise is mainly carb absorption. ICE is converted into grams absorbed using the carb ratio and ISF in force at the time of the meal entry (grams per 5 min = ICE × CR ÷ ISF).

When several entries are still absorbing, the observed absorption is shared between them in proportion to each entry's minimum absorption rate. Worked example: at 4 pm, with ICE of +15 mg/dL per 5 min, CR 10 g/U and ISF 50 mg/dL/U, Loop estimates 3 g absorbed in that 5-minute step. With one meal of 72 g over 4 h (12 g/hr) and another of 72 g over 2 h (24 g/hr), the 3 g is split one third to the first meal (1 g) and two thirds to the second (2 g). The page shows the non-linear model, which Loop really uses, differs only slightly in shape.

## Minimum absorption rate as a floor in Loop [section "Minimum Carbohydrate Absorption Rate"]

If the absorption Loop has observed for a meal so far is less than the minimum rate would have produced, Loop uses the minimum rate instead. This makes sure carb entries run out within a reasonable time.

## Remaining active carbohydrates in Loop [section "Modeling Remaining Active Carbohydrates"]

After subtracting the grams already counted as absorbed, Loop assumes each entry's remaining carbs will absorb at its minimum absorption rate. That projection is turned into the future carb effect on glucose by multiplying by ISF ÷ CR from the time of the meal.

## Retrospective correction (RC) in Loop [section "Retrospective Correction Effect"]

Retrospective correction covers effects that the insulin and carb models do not capture, such as exercise, stress or hormones, by looking at Loop's own recent prediction error and assuming it continues briefly. Loop reruns a prediction starting 30 minutes ago and compares where it ends with the actual current glucose. The gap, averaged per 5-minute step over those 30 minutes, becomes a velocity term. It is applied in full to the first forecast point (5 minutes ahead), fades linearly to about half at 30 minutes, and is zero from 60 minutes onward. Example: a velocity of -10 mg/dL per 5 min gives about -10 at 5 minutes, -5.5 at 30 minutes, -0.9 at 55 minutes and 0 at 60 minutes.

## Integral retrospective correction (IRC) in Loop [section "Integral Retrospective Correction Effect"]

Integral Retrospective Correction is an option under Algorithm Experiments in Loop settings. When it is on, it replaces standard retrospective correction in the forecast and is meant to capture longer-lasting unmodelled effects by comparing past predictions with actual glucose. With IRC on, the retrospective section of the Predicted Glucose chart also shows an "Integral effect", the difference between the IRC and RC results.

## Glucose momentum in Loop [section "Glucose Momentum Effect"]

Momentum assumes recent trends continue for a short while. Loop fits a straight line by linear regression to the last 3 continuous CGM readings (15 minutes) and expresses the slope per 5 minutes. This slope is blended into the first 20 minutes of the forecast: it dominates the 5-minute point and fades out by 20 minutes, while the other effects are phased in by the same weighting. Example: readings of 100, 103 and 106 mg/dL give a slope of 3 mg/dL per 5 min, applied at roughly 100 %, 66 %, 33 % and 0 % at 5, 10, 15 and 20 minutes. If the other effects together add a steady 6 mg/dL per 5 min, the forecast from 106 would read about 109, 113, 118 and 124 mg/dL at those times.

Loop skips momentum when CGM data is not continuous (it needs at least three consecutive readings) or when any of the last three readings is a calibration.

## How Loop combines the effects into predicted glucose [section "Predicting Glucose"]

For each future 5-minute step, Loop takes the momentum effect plus the sum of the insulin, carb and retrospective correction effects, the latter scaled up from zero to full weight over the first 20 minutes. Predicted glucose at any future time is current glucose plus all these step changes added up to that time. In the page's example, a slight upward trend lets momentum lift the near-term forecast, while retrospective correction pulls it down because the recent rise was smaller than Loop had expected.
