---
id: loopdocs-faqs-algorithm-faqs
title: "LoopDocs: Algorithm FAQs: does Loop learn, negative IOB, how IOB is counted, how delivery limits cap automatic dosing"
publisher: "LoopDocs (LoopKit)"
url: https://loopkit.github.io/loopdocs/faqs/algorithm-faqs/
licence: "Own summary (Mellis); original: LoopDocs has no licence file: paraphrased with short quotes only"
licence_url: https://github.com/LoopKit/loopdocs
mode: SUMMARY_ONLY
language: en
retrieved: 2026-11-14
topics: [loop, aid, limits, settings, insulin, smb, bolus-calculator]
index: true
---

*Our summary (Mellis knowledge base) of a LoopDocs page, written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/faqs/algorithm-faqs/.*

# LoopDocs: algorithm FAQs

## Does Loop learn changes in insulin needs? [section "Does Loop "learn" or detect changes in your insulin needs?"]

Partly. Loop has a short-term retrospective correction that applies a weighted adjustment based on the last 60 minutes of glucose changes, and its dynamic carb absorption (via insulin counteraction effect) makes it fairly forgiving of rough carb and absorption-time entries. But Loop does not learn or change the Therapy Settings themselves: it assumes they are correct and keeps them fixed under user control. When hormones, illness, exercise, medication and similar factors change the underlying needs, the user has to adjust the settings, and Overrides are useful for short-term changes. LoopDocs mentions that automatic settings adjustment or machine learning might come in later versions.

## What negative Active Insulin means in Loop [section "What does negative Active Insulin mean?"]

When Loop withholds or suspends scheduled basal, an insulin deficit builds up and IOB goes negative, much as a kinked cannula would leave someone short of insulin. Negative IOB shows Loop has been working to prevent a low. LoopDocs says regular, large negative IOB suggests the settings need testing, and glucose that keeps falling away from meals while IOB is negative usually points to a scheduled basal that is too high. Loop models the body's own glucose production as a fixed rate covered by scheduled basal, which is a simplification.

## How Loop calculates IOB [section "How is IOB calculated?"]

IOB comes from insulin delivered above or below the scheduled basal. For each dose, the insulin model gives how much is still active over time, and Loop adds these up over the full duration of insulin action, which is 6 hours for most rapid insulins in Loop's models. IOB is plotted on the Active Insulin chart on the Loop main screen.

## How Loop delivery limits affect automatic dosing [section "How do Delivery Limits Affect Automatic Dosing?"]

Each cycle Loop forecasts glucose and computes a dose (positive or negative) towards the correction range. The nearest 3 hours of the forecast weigh more than the later 3 hours, but all 6 hours count. A negative dose is answered by lowering basal, typically to zero. A positive dose depends on the Dosing Strategy and is limited by the Delivery Limits (Maximum Bolus and Maximum Basal Rate).

## Loop manual bolus and Maximum Bolus [section "Manual Dose"]

When the user asks for a recommendation in the bolus tool (the double orange triangles in the bottom toolbar), only Maximum Bolus applies: Loop recommends the computed dose, or Maximum Bolus if the dose is larger.

## Loop automatic dose cap of twice Maximum Bolus in IOB [section "Automatic Dose"]

For automatic insulin above scheduled basal, Loop will not dose so that IOB would exceed 2 × Maximum Bolus: the automatic dose is the smaller of the computed dose and (2 × Maximum Bolus minus current IOB). A manual bolus can push IOB past that level with no warning, but then no further automatic dosing happens until IOB drops below 2 × Maximum Bolus. As long as the forecast is above the correction range, scheduled basal keeps running whatever the IOB.

## Loop Automatic Bolus with constant 40 % [section "Automatic Bolus: Constant Partial Application Factor"]

With Glucose Based Partial Application off (the default), the partial application factor is a fixed 40 %: Loop boluses 40 % of the automatic dose, or 40 % of Maximum Bolus if the automatic dose exceeds Maximum Bolus. At the time of writing, LoopDocs described the glucose-based option as coming with the next release and available through customization or the development version.

## Loop Automatic Bolus with Glucose Based Partial Application [section "Automatic Bolus: Glucose Based Partial Application Factor"]

With Glucose Based Partial Application on, the factor varies with current glucose from 20 % at lower glucose to 80 % at higher glucose, applied to the automatic dose or to Maximum Bolus, whichever is smaller.

## Loop Temp Basal Only and both limits [section "Temp Basal Only"]

Temp Basal Only uses both limits. Maximum Bolus first caps the automatic dose as above. That dose is doubled to an hourly rate, added to scheduled basal for a 30-minute temp, and the resulting rate is capped at Maximum Basal Rate.
