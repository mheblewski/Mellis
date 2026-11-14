---
id: loopdocs-operation-features-ice
title: "LoopDocs: Insulin counteraction effects (ICE): the Carbohydrates details page and reviewing how a meal absorbed in Loop"
publisher: "LoopDocs (LoopKit)"
url: https://loopkit.github.io/loopdocs/operation/features/ice/
licence: "Own summary (Mellis); original: LoopDocs has no licence file: paraphrased with short quotes only"
licence_url: https://github.com/LoopKit/loopdocs
mode: SUMMARY_ONLY
language: en
retrieved: 2026-11-14
topics: [loop, nutrition, aid, bolus-timing, children, education]
index: true
---

*Our summary (Mellis knowledge base) of a LoopDocs page, written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/operation/features/ice/.*

# LoopDocs: insulin counteraction effects and the Loop Carbohydrates page

## Opening the Loop Carbohydrates details page [page introduction]

Tapping the Active Carbohydrates chart on the Loop main screen opens the Carbohydrates details page. It lists the carb entries of the last 12 hours and how they absorbed, which helps when checking settings, troubleshooting past meals and planning future ones.

## What insulin counteraction effects (ICE) are in Loop [section "Insulin Counteraction Effects"]

ICE is anything that works against insulin and pushes glucose up: food, stress, illness, a failing site, basal set too low, and more. On a normal day (settings about right, no illness, good site) food is the main one, and Loop relies on dynamic carb absorption and its other prediction effects to keep glucose in range.

Whenever carbs are on board, Loop attributes all positive ICE to those carbs, not only on normal days. So if something else is raising glucose, such as insulin resistance, while carbs are active, Loop counts it all as carb absorption until the entered carbs are considered fully absorbed; after that, the remaining ICE starts driving retrospective correction upward. ICE is a core part of both carb absorption and the Loop forecast.

## Reading the Loop Glucose Change chart [section "Glucose Change Display"]

At the top of the Carbohydrates page, the Glucose Change chart (units mg/dL per 5 min or mmol/L per 5 min) compares two things:

- **Grey bars:** the carb effect Loop is currently modelling, a mix of dynamically estimated absorption (when the meal absorbs faster than Loop's conservative estimate) and static absorption at the conservative minimum rate.
- **Green bars:** the observed glucose change compared with what insulin alone would have done, that is, ICE.

Besides ICE, Loop uses the entered carb amount and absorption speed. When a meal's total ICE so far is below the minimum absorption rate, Loop falls back to its default model: early in a meal, when green bars are below grey ones, Loop uses minimum absorption rather than the observed change. If carbs were overestimated, the meal absorbs more slowly than entered, or exercise lowers insulin needs, the grey bars from the start of the meal may be what Loop uses throughout.

LoopDocs advises not to use this chart to judge meal absorption when sickness, exercise or other non-carb factors are strongly changing insulin sensitivity, because the carb information will be skewed.

## Ways people use Loop for meals [section "Practical use"]

LoopDocs notes there are many workable styles: some plan carb entries carefully so they need not watch glucose afterwards, some enter their usual values for a meal and let Loop handle the rest, and some guess and then "carb surf" if glucose goes higher than they like. The rest of the page was written by Katie DiSimone before the non-linear carb model (2019); much still applies, though some details have changed.

## Loop observed absorption time [section "Practical use", worked example]

When a carb entry is saved, Loop keeps it as entered and, on the line below, tracks the same entry assuming 1.5 times the entered absorption time. As the meal progresses Loop updates this observed absorption time and the grams absorbed.

## Worked meal example with Loop ICE [section "Practical use", worked example]

A family meal of General Tso's chicken with rice (fast sauce carbs plus slower carbs, rice acting fast with a long tail) was estimated by eye. Around 3:30 pm the parent entered 70 g at 5 hours and bolused; about 10 minutes later added 10 g at 1 hour for the sauce. As glucose rose quickly, the 70 g entry was edited to 80 g (hence a 2 U bolus around 4:20 pm), and 10 g was added around 5:40 pm for nibbling leftovers. Glucose peaked around 180, and a 2 U correction was given at the peak ahead of a later dessert.

Looking at the Glucose Change chart afterwards, early green peaks showed the fast sauce carbs had been underestimated: the observed slow-to-fast split was about 7:2 rather than the guessed 8:1, while total carbs matched well (90 g entered versus 89 g observed). Next time the parent planned to enter it as 70 g at 5 hours plus 20 g at 2 hours.

## Using the Loop Carbohydrates page well [section "Practical use", closing tips]

Check the Carbohydrates page once a meal has finished absorbing; the observed behaviour is a good starting point for fine-tuning how to split an unfamiliar meal. This assumes basal is roughly right and the person is not ill. Bad sites, illness or basal that needs changing can be counted as ICE although they are not food; fix the cause first and use the page again once things are back to normal.
