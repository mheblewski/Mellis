---
id: loopdocs-operation-algorithm-bolus
title: "LoopDocs: Bolus recommendations: when Loop recommends a bolus, slow meals, maximum bolus and the Glucose Safety Limit"
publisher: "LoopDocs (LoopKit)"
url: https://loopkit.github.io/loopdocs/operation/algorithm/bolus/
licence: "Own summary (Mellis); original: LoopDocs has no licence file: paraphrased with short quotes only"
licence_url: https://github.com/LoopKit/loopdocs
mode: SUMMARY_ONLY
language: en
retrieved: 2026-11-14
topics: [loop, bolus-calculator, correction, limits, hypoglycaemia, smb]
index: true
---

*Our summary (Mellis knowledge base) of a LoopDocs page, written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/operation/algorithm/bolus/.*

# LoopDocs: how Loop recommends a bolus

## When Loop recommends a bolus [section "Recommended Bolus"]

Loop suggests a bolus when eventual predicted glucose is above the correction target and the active insulin plus any running 30-minute temp basal will not cover the predicted rise. Loop does not announce recommendations by notification or banner; they appear only when the user opens the bolus tool. With the default Temp Basal Only dosing strategy Loop never boluses by itself; every bolus is started by the user. With the Automatic Bolus strategy, each automatic bolus is limited to 40 % of the recommendation or to the Maximum Bolus, whichever is smaller.

The manual recommendation uses the same arithmetic as automatic dosing, with two differences: the insulin from the temp basal Loop is currently running is subtracted, and the excess is measured to the top of the correction range instead of its middle.

## Loop and slow-absorbing meals [section "Slow Absorption Time (Extended Bolus)"]

For recently entered carbs with a long absorption time (for example pizza or pasta), Loop's first meal bolus is smaller than grams divided by carb ratio. Loop sizes it so the forecast does not drop below the Glucose Safety Limit, accepting that glucose may be predicted above the correction range later, in order to avoid a low soon after the meal. As the meal absorbs, Loop adjusts: reductions always come as a lower temp basal; increases come as a higher temp (Temp Basal Only) or as 40 % automatic boluses (Automatic Bolus). LoopDocs likens this to an "extended" or "dual wave" bolus that also learns from actual absorption.

Finally Loop checks the result against the user's Maximum Bolus; a recommendation within that limit is shown in the bolus tool.

## Loop bolus safety rule [admonition "Bolusing safety feature"]

If current glucose or any predicted value is below the Glucose Safety Limit, Loop gives no bolus recommendation. Once the minimum predicted glucose is back above the limit, the bolus tool again shows a recommendation.
