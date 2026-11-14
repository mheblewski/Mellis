---
id: loopdocs-operation-features-bolus
title: "LoopDocs: Bolus screens: meal bolus, manual or correction bolus, when Loop recommends a bolus, bolus status line and failed or uncertain boluses"
publisher: "LoopDocs (LoopKit)"
url: https://loopkit.github.io/loopdocs/operation/features/bolus/
licence: "Own summary (Mellis); original: LoopDocs has no licence file: paraphrased with short quotes only"
licence_url: https://github.com/LoopKit/loopdocs
mode: SUMMARY_ONLY
language: en
retrieved: 2026-11-14
topics: [loop, bolus-calculator, correction, smb, limits, pump]
index: true
---

*Our summary (Mellis knowledge base) of a LoopDocs page, written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/operation/features/bolus/.*

# LoopDocs: Bolus in Loop

## Loop Meal Bolus screen [section "Meal Bolus"]

Loop shows the Meal Bolus screen after carbs are added or edited. Its button is **Save Carbs & Deliver**, or **Save without Bolusing** when no bolus is recommended. Tapping either saves the carb entry (and, in Loop 3, a fingerstick typed there), even if the bolus then never reaches the pump. If a notification appears after saving, check Loop's carb entries before entering the meal again.

## Loop Meal Bolus: accepting the recommendation [section "Accept Recommendation"]

Active Carbs and Active Insulin above the Glucose prediction graph are the values from when the screen opened. Below the graph: **Carb Entry** (grams, time, absorption time; change via **< Carb Entry** at upper left), **Recommended Bolus**, and **Bolus**, which starts at the recommendation and can be edited. On small phones you may need to scroll to see the last two rows. A new CGM value while the screen is open brings up **Bolus Recommendation Updated**, which must be acknowledged.

## Loop Meal Bolus: changing the amount [section "Modify Bolus"]

Editing the Bolus redraws the prediction, which shows what happens if Loop makes no further changes; at the next cycle Loop adjusts delivery from the saved data.

- **Less than recommended:** Loop adds no automatic insulin until current glucose is above the bottom of the Correction Range. Below the range, extra insulin is only offered manually, limited to what keeps the forecast above the safety threshold.
- **More than recommended:** Loop will probably set a 0 U/hr temp basal, the common "super-bolus" that borrows basal to limit the spike after the meal.

## Loop manual or correction bolus [section "Manual (or Correction) Bolus"]

The double orange triangles in the toolbar open the Bolus screen (like Meal Bolus, without the Carb Entry row). The recommendation respects the Glucose Safety Limit and the prediction. When glucose is below the Correction Range, Loop allows a dip below the range but keeps the recommendation within the safety limit; it will likely recommend more once glucose starts rising. Buttons: **Enter Bolus** (nothing recommended; type an amount, then **Deliver**), **Deliver** (value on the Bolus row), **Cancel** at upper left. The first tap on the Bolus value resets it to 0 U and opens the keyboard.

## When Loop recommends a bolus, and Dosing Strategy [section "Recommended Bolus"]

Loop updates its prediction with each glucose reading, usually every 5 minutes. It recommends a bolus when glucose is predicted above the top of the Correction Range at the end of DIA and the prediction stays above the Glucose Safety Threshold. Loop does not alert about a recommendation; open the bolus tool to see it (the Loop pill in Nightscout also shows it).

- **Temp Basal (default):** Loop raises temp basals, within the Delivery Limits, until enough insulin is given to bring the prediction into range.
- **Automatic Bolus:** every 5-minute cycle Loop recalculates the correction and gives 40 % of it automatically, each dose within the Delivery Limits.

## Loop bolus status line and cancelling [section "Bolus Status Line"]

In portrait mode a line under the Heads-Up Display shows "starting bolus" while Loop talks to the RileyLink, then "bolused xx of yy" once the command is sent, even without a pump reply yet. The amount is timer-based and reconciled with the pump when the bolus ends. Tapping the line cancels the bolus (newer versions say "Tap to Stop"), so lock the phone during a bolus. If a pump-suspended notice appears after cancelling, tap it to resume.

## Loop bolus failure and uncertain delivery [section "Bolus Failure Notifications"]

A "bolus may have failed" notification can also follow an automatic bolus, and sometimes the bolus was in fact delivered. Before giving it again, Medtronic users should check the pump screen; Omnipod users may hear the pod click. The "bolused xx of yy" display may keep counting after an uncertain message because it is a phone timer, not a pump reading. For a large uncertain bolus LoopDocs suggests stopping it, checking status and starting a fresh one. Loop resolves the status at its next pump contact; Event History (tap the Active Insulin or Insulin Delivery chart, phone in landscape) marks each bolus "Certain" or "Uncertain".

If it stays uncertain: check the RileyLink-type device, toggle Bluetooth off and on, or fully quit and reopen Loop (not a phone restart). If still unresolved, send an Issue Report from Loop Settings and ask for help in the Loop community (Facebook, Zulipchat).
