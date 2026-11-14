---
id: loopdocs-operation-algorithm-overview
title: "LoopDocs: Algorithm overview: how Loop's prediction drives dosing, and the terms correction range, eventual glucose, IOB"
publisher: "LoopDocs (LoopKit)"
url: https://loopkit.github.io/loopdocs/operation/algorithm/overview/
licence: "Own summary (Mellis); original: LoopDocs has no licence file: paraphrased with short quotes only"
licence_url: https://github.com/LoopKit/loopdocs
mode: SUMMARY_ONLY
language: en
retrieved: 2026-11-14
topics: [loop, aid, targets, insulin, time-in-range, education]
index: true
---

*Our summary (Mellis knowledge base) of a LoopDocs page, written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/operation/algorithm/overview/.*

# LoopDocs: overview of the Loop algorithm

## What the Loop algorithm aims for [section "The Loop Algorithm"]

Loop forecasts glucose and adjusts insulin so the forecast lands in the target range without dropping under the Glucose Safety Limit. Each new glucose reading, about every five minutes, triggers a fresh forecast, and both bolus recommendations and temp basal changes are based on it. The forecast uses current and past glucose, past insulin delivery and entered carbs, with the user's therapy settings as modified by any active override.

The predicted curve shown in Loop assumes insulin delivery will not change, yet Loop will in fact keep adjusting delivery as real glucose comes in. The displayed forecast mainly explains why Loop is dosing as it is right now. LoopDocs stresses that with very low or very high forecasts Loop will change dosing to try to stop that future from happening, while keeping glucose above the Glucose Safety Limit.

## Loop algorithm terms [section "Algorithm Terminology"]

- **Insulin activity duration:** how long a dose keeps affecting glucose; 6 hours for Loop's rapid-acting and ultra-rapid models.
- **Correction range:** the user-set glucose range Loop uses for corrective action (the page's example is 90-120 mg/dL). It is not the same as the 70-180 mg/dL target range typically used for time in range.
- **Correction minimum / maximum:** the bottom and top of the correction range (90 and 120 mg/dL in the example).
- **Correction target:** the middle of the correction range (105 mg/dL in the example).
- **Predicted glucose:** the forecast, which runs for the insulin activity duration and is the basis of all Loop dosing.
- **Eventual glucose:** the last point of the forecast, at the end of the insulin activity duration (85 mg/dL in the example).
- **Minimum predicted glucose:** the lowest point anywhere in the forecast (77 mg/dL in the example).
- **Delta:** eventual glucose minus the correction target (85 - 105 = -20 mg/dL in the example).
- **Glucose Safety Limit (formerly Suspend Threshold):** if any predicted value is below it, Loop sets a 0 U/hr temp basal.
- **CGM data:** readings from a continuous glucose monitor.
- **Insulin sensitivity factor:** the estimated glucose drop per unit of insulin.
- **Active insulin (IOB):** insulin still acting from boluses and temp basals, counted relative to scheduled basal over the insulin activity duration. Because withheld basal (suspensions, low temps) counts as a deficit, IOB can be negative, and negative IOB raises the forecast. The IOB shown on the Loop main screen does not include the temp basal currently running, since it may be cancelled or changed within its 30 minutes; only confirmed delivery is counted.
