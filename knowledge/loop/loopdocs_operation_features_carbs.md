---
id: loopdocs-operation-features-carbs
title: "LoopDocs: Meal entry: entering carbs, time and absorption time, food types, warnings, Automatic Bolus after carbs, editing meals and dynamic carb absorption"
publisher: "LoopDocs (LoopKit)"
url: https://loopkit.github.io/loopdocs/operation/features/carbs/
licence: "Own summary (Mellis); original: LoopDocs has no licence file: paraphrased with short quotes only"
licence_url: https://github.com/LoopKit/loopdocs
mode: SUMMARY_ONLY
language: en
retrieved: 2026-11-14
topics: [loop, nutrition, bolus-calculator, bolus-timing, smb, education]
index: true
---

*Our summary (Mellis knowledge base) of a LoopDocs page, written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/operation/features/carbs/.*

# LoopDocs: Meal entry in Loop

## Loop Favorite Foods (Loop 3.4) [section "New with Version 3.4.x"]

Loop 3.4.x added Favorite Foods, the fastest way to enter a meal. The LoopDocs author's own routine: favourites named Lunch and Dinner; pick one, save, accept the bolus; edit the carbs down before saving when eating less; when eating more, accept the usual amount at prebolus and add carbs in 15 g steps at the table; for dinner, use the fat-protein option moved to 4 hours after the meal.

## Loop meal entry: quick steps [section "Meal Entry - Fast Version" / "Meal Entry"]

The green plate icon opens **Add Carb Entry**: type grams in Amount Consumed, tap **Continue**, then **Save Carbs & Deliver** on the Meal Bolus screen (or **Save without Bolusing**, shown with a No Bolus Recommended reason). Loop assumes all saved carbs will be absorbed, adjusts recommended and (in Closed Loop) automatic insulin for them, and revises the estimate from glucose while the meal is active. A rough count is fine; LoopDocs prefers underestimating to overestimating. Beginners should check the recommended dose is not more than expected and, if it is, lower the carbs or review settings.

Carbs are saved only when the Meal Bolus button is tapped, and then stay saved even if the bolus fails. After a notification, check the entries before re-entering. Edit past entries by tapping the Active Carbohydrates chart.

## Loop Amount Consumed [section "Amount Consumed"]

A value is required to continue. Many Loopers add to the carb amount to cover fat and protein, more so on lower-carb meals; mostly-carb meals may work better with carbs alone.

## Loop meal time [section "Time"]

Default is now; minus and plus move the time 15 minutes per tap (also on the watch), or tap the time for a picker. Set a planned start time for a meal more than 15 minutes away (prebolus); in Closed Loop Loop doses for it while keeping the Glucose Safety Limit. Enter a forgotten meal at the time it was eaten: entering it as now makes Loop expect all carbs ahead and can give too much insulin. Slow foods such as pizza may suit a later start with longer absorption. Allowed range: 12 hours back to 1 hour ahead (for edits, counted from the entry's saved time).

## Loop Food Type icons [section "Food Type"]

Optional. The first icon tapped (Lollipop, Taco, Pizza, or a food emoji under the plate icon) sets the absorption time; later taps change nothing. Emojis are grouped Fast, Medium, Slow; those under Other neither change the time nor count as the first tap. The Absorption Time picker always overrides.

Loop 3 times are Lollipop 30 minutes, Taco 3 hours, Pizza 5 hours (changed from Loop 2.2.x). A Lollipop on a big mixed meal makes Loop expect a fast rise; when it does not come, Loop may predict an unexpected low. Fix it by editing to a longer absorption time. The Lollipop is meant for simple foods like low treatments.

## Loop Absorption Time [section "Absorption Time"]

Default 3 hours. Loop uses absorption time with glucose, ISF and CR to recommend insulin and track absorbed versus expected carbs, spreading absorption over 150 % of the chosen time. Up-front insulin stays roughly the same up to 3 hours and shrinks with longer times. LoopDocs suggests comparing Loop's recommendation with carbs divided by CR at different times (flat, falling, rising) by changing the absorption time via **< Carb Entry** and reading the new recommendation.

## Loop large meal and override warnings [section "Continue" / "Large Meal Warning" / "Override Active Warning"]

Nothing is saved on Add Carb Entry. Over 99 g at Continue shows a Large Meal Warning to confirm or correct. An active override with insulin sensitivity other than 100 % shows a warning at the top of the screen.

## Loop carb entry with the Automatic Bolus strategy [section "Automatic Bolus"]

With Automatic Bolus, still prebolus or bolus for meals. The Recommended amount is the full dose, not the 40 % automatic part. Delivering less, or Save Without Bolusing, tells Loop to give the rest later, 40 % of the current recommendation each cycle. With Temp Basal the same catch-up happens more slowly, leaving more time to spot a wrong entry; Automatic Bolus reacts faster to rising glucose.

## Loop editing and deleting meals [section "Edit Meals"]

Edit when the meal was not finished, eaten at another time, larger, or glucose suggests a wrong count. Open the Carbohydrates screen from the Active Carbohydrates chart. Tap an entry to change time, grams or absorption time (even mid-meal). To delete, tap `Edit`, then the red circle: `Edit` deletes rather than edits.

## Loop: reviewing carb absorption and COB [section "Review Carb Absorption" / "Check COB Before Adding More" / "Avoid Double Meal Entries"]

Check how Loop reports absorption for new meals or activities. If COB does not match reality, causes can be the carb or fat/protein count, absorption time, settings, activity, stress, hormones or exercise; editing the entry lets Loop fix its forecast and can head off a low or high. With lots of COB left, wait (half an hour to an hour) before entering more, because Loop doses for all expected carbs; take care at parties and when accepting doses from the watch. Delete duplicate entries via `Edit`; insulin already given stays, but future dosing adjusts.

## Loop dynamic carb absorption and the Carbohydrates screen [section "Dynamic Carb Absorption"]

Within the 150 % window Loop estimates carbs actually absorbed from glucose, whatever was entered, and shows it with the ICE chart. Each entry's top line is what was entered; the bottom line, updated every CGM reading, shows grams absorbed and when the entry should finish. Colours inside the window: green if absorbed is less than 10 % above the entered amount, yellow if more than 10 % above. After the window: grey if within 10 % of entered, yellow if more than 10 % above or below. Details vanish after 12 hours, so screenshot them to keep.

## Loop with Medtronic and Nightscout carbs [section "Medtronic Warning" / "Nightscout Entries"]

Never enter carbs in a Medtronic pump: the pump gives insulin Loop cannot match to carbs, predictions go wrong and Loop will likely set 0.0 U/hr at its next history read. In Loop 3 caregivers can send carbs and boluses through Nightscout only with the Remote Carb and Remote Bolus Careportal entries after setup; ordinary Careportal carbs are not read by Loop or counted in COB (sometimes used on purpose for a low treatment). Loop's carb model is explained on the algorithm prediction page.
