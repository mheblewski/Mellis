---
id: loopdocs-operation-loop-open-loop
title: "LoopDocs: Loop Open Loop: learning predictions and recommendations before closing the loop, basal/ISF/CR testing, meal entry, extended bolus by Manual Temp Basal"
publisher: "LoopDocs (LoopKit)"
url: https://loopkit.github.io/loopdocs/operation/loop/open-loop/
licence: "Own summary (Mellis); original: LoopDocs has no licence file: paraphrased with short quotes only"
licence_url: https://github.com/LoopKit/loopdocs
mode: SUMMARY_ONLY
language: en
retrieved: 2026-11-14
topics: [loop, aid, settings, education, bolus-calculator, correction, nutrition, children, pump]
index: true
---

*Our summary (Mellis knowledge base) of a LoopDocs page, written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/operation/loop/open-loop/.*

# LoopDocs: starting Loop in Open Loop

## Why start Loop in Open Loop [section "Open Loop Introduction"]

LoopDocs calls Open Loop the best starting point: run Loop with Closed Loop off, watch how it behaves, and go slowly. Loop's menus do not include every manual pump feature: Medtronic users can switch Closed Loop off and use the pump itself for such features; Omnipod users who miss a PDM feature like extended bolus can build one with Manual Temp Basal (see the extended bolus section). Loop can also be practised without hardware, with a simulated CGM and/or pump, using Dexcom Share or Nightscout as a CGM, even "dosing" the simulated pump alongside the real one to compare predictions.

## Learning the Loop glucose prediction [section "Glucose Prediction"]

In Open Loop, follow the prediction on the Glucose Chart while dosing by hand, and compare Loop's recommendation for a familiar meal with what you would give. Understand predictions and recommendations before enabling Closed Loop. Loop tries to keep predicted glucose in the Correction Range and, above all, above the Glucose Safety Limit. Because the algorithm updates predictions and dosing every 5 minutes it needs accurate settings; new users typically adjust, in this order, basal rates, then ISF, then carb ratios. Entering carbs and absorption times is a skill that takes time.

## Eventual glucose and when Loop gives or withholds insulin [section "Eventual Glucose"]

Loop predicts an eventual glucose from current glucose, momentum, carbs on board, insulin on board and retrospective trends, and bases decisions on actual, predicted and eventual glucose. The first three hours of the insulin action time weigh more than later hours when Loop decides how much to recommend or withhold.

If the forecast dips below the Glucose Safety Limit, Loop recommends no insulin even when eventual glucose is above the Correction Range:

- in Closed Loop, Loop sets a 0 U/hr temp basal until the forecast is back above the Glucose Safety Limit;
- the Bolus icon gives a recommendation only once the forecast is above the Glucose Safety Limit;
- in Closed Loop, Loop increases insulin automatically only once the forecast is above the bottom of the Correction Range.

If predictions do not match experience, settings may need adjusting. A manual temp basal is set on the pump for Medtronic, or with Manual Temp Basal for Omnipod.

## Testing basal, ISF and carb ratio in Open Loop [section "Testing"]

Open Loop shows glucose trends without temp basals or automatic boluses, useful when new to Medtronic or Omnipod sites and pumps; basal rates and carb ratios can differ a lot from other pump brands or from injections (MDI). LoopDocs' general suggestions:

- Set a good basal profile first on the pump that will be used with Loop. For an algorithm, basal must be neutral: without food or exercise glucose should stay steady, within about 35 mg/dL (2 mmol/L) during basal testing.
- If a high daytime basal used to cover meals, the carb ratio may need to become smaller once basal is neutral.
- Then test ISF, because Loop uses it every 5 minutes; the right value may differ from, probably be higher than, the correction factor used on a manual pump or MDI.
- While meals absorb, Loop uses ISF divided by CR, roughly how much one gram of carbs raises glucose. A check: when stable, eat a small fast-acting treatment. With ISF 75 mg/dL and CR 15 g/U, a 4 g glucose tablet should raise glucose about 20 mg/dL over half an hour to an hour; the real rise should be within a factor of two of ISF/CR times grams.

## Meal entry in Loop [section "Meal Entry"]

LoopDocs stresses that Loop recommends more insulin as soon as carbs are saved. Tap the plate icon to open Add Carb Entry; only Amount Consumed is required. Tapping continue does not save the carbs yet but opens the Meal Bolus screen, where carbs are saved and the recommended bolus accepted or changed. While learning, check whether the recommendation fits experience, watch the embedded prediction chart, try changing the carb time, absorption time and bolus amount to see the prediction move, and only save and bolus when confident.

## Carb absorption times in Loop [section "Carb Absorption"]

Every Loop meal entry has an absorption time; the default 3 hours works for most people, and since the prediction updates every 5 minutes Loop adjusts if amount or time is roughly right. The 30-minute (lollipop) icon suits low treatments; the 5-hour (pizza) icon can be tried for high-fat meals. The Active Carbohydrate chart shows how Loop thinks the meal is absorbing, which depends on basal, ISF and CR; if it looks wrong, check settings. Carb entries can be increased to account for some protein or fat.

## Manual or correction bolus [section "Manual (or Correction) Bolus"]

The Bolus icon (double orange triangles) is available at any time; Loop offers a recommendation when the prediction supports one, and the amount can be edited. In Open Loop, check whether Loop recommends more insulin; accept it if it looks reasonable, otherwise read the prediction chart to see why, and compare with the decision you would make.

## Troubleshooting before closing the loop [section "Troubleshooting"]

RileyLink users should learn how far the link can be from phone and pump and where to carry it; DASH users need no RileyLink but should learn how far the phone can be from the pod. Learn to troubleshoot red loops and know the bolus failure notifications.

## Caregiver training [section "Caregiver training"]

LoopDocs advises caregivers to learn the Loop app too; school staff or the child should know how to handle a site change or CGM failure at school, and an individual quick-info sheet for the child can help. Practise reading Nightscout while the child is nearby so you can compare with their phone; Nightscout can also be set up for remote bolus and carb entries.

## Apple Health in Open Loop [section "Apple Health in Open Loop"]

In Open Loop, basal delivery reaches Apple Health with a delay. Suspending and resuming the pump forces Loop to update Health; if doing so, make sure delivery really resumed.

## Extended bolus with Manual Temp Basal [section "Extended Bolus" / "Extended Bolus Equations" / "Specific Example"]

Loop has no extended bolus menu. On Omnipod one can be made with Manual Temp Basal; while a Manual Temp Basal runs, Loop makes no automatic dosing changes even with Closed Loop switched on. LoopDocs adds that this should not be needed once in Closed Loop.

Method: subtract the amount given now from the total to get the balance; the Manual Temp Basal rate is the balance divided by the hours plus the scheduled basal rate. First start the Manual Temp Basal for that many hours, then bolus the immediate part; the order matters because the pod accepts no other command until a bolus finishes, about 40 seconds per unit. Example: 3 U total, 1 U now, 1.5 hours, basal 0.5 U/hr gives a 2 U balance; 2 ÷ 1.5 = 1.333, rounded to 1.35, plus 0.5 gives 1.85 U/hr (rates go in 0.05 U/hr steps, rounding up or down).
