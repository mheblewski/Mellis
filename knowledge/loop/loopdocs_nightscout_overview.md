---
id: loopdocs-nightscout-overview
title: "LoopDocs: Nightscout with Loop: what caregivers can see and do remotely, uploads and the 7-day buffer, dashboard elements and Loop pill symbols"
publisher: "LoopDocs (LoopKit)"
url: https://loopkit.github.io/loopdocs/nightscout/overview/
licence: "Own summary (Mellis); original: LoopDocs has no licence file: paraphrased with short quotes only"
licence_url: https://github.com/LoopKit/loopdocs
mode: SUMMARY_ONLY
language: en
retrieved: 2026-11-14
topics: [loop, aid, cgm, children, education]
index: true
---

*Our summary (Mellis knowledge base) of a LoopDocs page, written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/nightscout/overview/.*

# LoopDocs: Nightscout with Loop

## What Nightscout does for Loop users and caregivers [section "Overview"]

- Nightscout shows Loop activity remotely: history of glucose, carbs, boluses, temp basals and overrides, help with troubleshooting, and reports for spotting trends when Therapy Settings need adjusting or for the clinic.
- For caregivers it enables remote monitoring and, when Loop and Nightscout are configured for it, remote commands: start and stop overrides, enter carbs, command boluses. The LoopCaregiver app (iOS only, in development) can monitor Loop and send carbs, bolus and override commands from the caregiver's phone.
- Nightscout stores Loop configurations; with Loop 3 the saved Nightscout profiles can be downloaded into a new Loop install or new phone for quick onboarding.
- A Nightscout viewer app alone is not enough: you need your own configured Nightscout site and URL. LoopDocs highly recommends Nightscout, especially for caregivers.

## Nightscout documentation vs LoopDocs [section "Nightscout Documentation"]

General Nightscout setup lives in the official Nightscout documentation; LoopDocs keeps only Loop-specific information.

## Loop uploads to Nightscout, stale pill and 7-day buffer [sections "Nightscout with Loop", "Loop Uploads to Nightscout"]

- The page describes Loop 3 with Nightscout 14.2.6 or later; older versions show Loop data differently.
- Nightscout updates only while the Loop phone has WiFi or cell internet. If uploads stop, the Loop pill goes stale (cannot be opened) after 15 minutes.
- Pills are the small info boxes; they are Nightscout plugins enabled by config vars and can be shown or hidden.
- During an outage Loop 3 keeps up to 7 days of Nightscout data on the phone and uploads it when the connection returns; a stale Loop pill may need 15 minutes more to open.
- The COB (carb) pill can lag the Loop pill by one cycle and drops to 0 COB within 5 to 10 minutes if uploads stop. If the COB pill unexpectedly shows 0 while the Loop pill is active, trust the Loop pill.

## Glucose on the Nightscout dashboard and alarm thresholds [sections "Nightscout Dashboard", "Blood Glucose"]

CGM readings appear coloured green, yellow or red (with Colors enabled). High and low alarm thresholds are optional Nightscout config vars with defaults; they set the colours and, if enabled, audible and visible alarms. They do not affect Loop, which uses only the correction ranges in Loop settings. The top area shows the chosen time span (e.g. 12 hours); the bottom strip shows the last 48 hours and can be dragged back to review Loop actions.

## SAGE, CAGE and BAGE pills [section "SAGE, CAGE, BAGE"]

Optional pills for sensor age, cannula age and pump battery age, with optional reminder alerts. With Loop, sensor and cannula changes should update SAGE and CAGE automatically; otherwise enter them in the Careportal.

## Carbs and boluses in Nightscout from Loop [sections "Carbs", "Boluses"]

- Loop uploads carbs automatically; COB is in the Loop pill. A white dot's size matches the carb amount. Loop never reads carbs from Nightscout for its calculations; it only uploads carbs entered in Loop.
- Boluses upload automatically as soon as they start, shown as a dot with a filled blue lower half and the amount; IOB in the Loop pill updates. A pre-bolus may sit apart from its carb dot. If a bolus is interrupted, Nightscout updates when Loop next uploads.

## Temp basals and Loop's predicted glucose in Nightscout [sections "Temp Basals", "Predicted Glucose"]

- The dashed blue line is the scheduled basal; solid blue lines are the basal actually set by Loop's temp basals. If the graph and the Loop pill disagree, trust the pill.
- The purple line after the latest glucose is Loop's forecast, which explains high or low temps. If it is missing, open the menu (three dots next to the hours setting) and tick the Loop prediction instead of AR2.

## Loop pill and its status symbols in Nightscout [section "Loop Pill"]

Hovering or tapping the Loop pill shows when Loop last ran, the temp basal set, IOB, COB and recent status messages; newer Nightscout also shows minimum, maximum, eventual and predicted glucose. It is the quickest check that Loop is running. Symbols:

- X: an error in Loop.
- ϕ: Loop is recommending basal or bolus but not enacting it (open loop or pump suspended).
- ⌁: Loop enacted a new temp basal.
- ↻: Loop continues the last temp basal, no change.
- ⚠: Loop is red or has not uploaded to Nightscout for a longer time.
