---
id: aid-systems-fat-protein-handling
title: "Device notes: how Trio, Loop, AndroidAPS, Control-IQ, MiniMed 780G and CamAPS FX handle fat/protein meals"
publisher: "compiled notes from manufacturer and open-source documentation and from the device-specific studies in this folder. Para"
url: https://loopkit.github.io/loopdocs/operation/features/carbs/
licence: "Own summary (Mellis); original: mixed. Trio, OpenAPS and AndroidAPS docs are open source (the full Trio/OpenAPS pages are already in the main corpus; AndroidAPS page saved verbatim in devices/androidaps-extended-carbs-ecarbs.md). LoopDocs has no stated"
mode: SUMMARY_ONLY
language: en
retrieved: 2026-10-21
topics: [fat-protein, trio, loop, aid]
index: true
corpus_v7: fat-protein/devices/aid-systems-fat-protein-handling.md
---

*Our summary or notes (Mellis knowledge base), written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/operation/features/carbs/.*

# How AID systems handle fat- and protein-rich meals: Trio/oref1, Loop, AndroidAPS, Control-IQ, MiniMed 780G, CamAPS FX (device documentation notes)

- **Type:** compiled notes from manufacturer and open-source documentation and from the device-specific studies in this folder. Paraphrased with short quotes. Retrieved 2026-10-20.
- **Licence:** mixed. Trio, OpenAPS and AndroidAPS docs are open source (the full Trio/OpenAPS pages are already in the main corpus; AndroidAPS page saved verbatim in devices/androidaps-extended-carbs-ecarbs.md). LoopDocs has no stated licence and Tandem/Medtronic/CamDiab pages are proprietary, so they are paraphrased here.
- **Evidence level:** device documentation and design descriptions. Not clinical evidence of benefit.

## Trio (oref1, iOS) - the system used by Mellis's patient

Sources already in the main corpus (not duplicated): `trio/configuration_settings_features_meal-settings.md`, `trio/configuration_settings_features_bolus-calculator.md`, `trio/usage_features_bolus-calculator.md`, `trio/configuration_settings_algorithm_smb-settings.md`, `openaps/Customize-Iterate_oref1.md`.

What they say:

- **Recommended Bolus Percentage:** default **80%** (range 5-150%). Trio multiplies the calculated meal bolus by this percentage *because SMBs and UAM will deliver the rest if needed*. New users are advised not to use 100% until basal, ISF and CR are verified. In other words, Trio's own default already "splits" every meal: about 80% now, the remainder left to the loop.
- **Reduced Bolus option:** optional button, default **70%** of the calculated bolus (multiplied on top of the Recommended Bolus Percentage).
- **Max Meal Absorption Time:** default **6 h** (range 4-10 h); a longer value lets the carb model keep late fat/protein effects in COB.
- **Enable Fat and Protein Entries (default OFF):** converts fat and protein into future carb equivalents using the **Warsaw method**: carb-equivalent grams = fat (g) × 90% + protein (g) × 40% (that is, kcal / 10, same as the Pańkowska FPU), then multiplied by **Fat and Protein Percentage, default 50%** (range 10-120%). These carb equivalents are logged as *future carb entries*, starting after the **Fat and Protein Delay, default 60 min** (range 15-120 min), spaced every **Spread Interval, default 30 min** (10-60 min), over at most **Maximum Duration, default 8 h** (5-12 h). The doc advises starting at 50% because the normal carb ratio may need to be weaker once fat/protein entries are used.
- **Logging options:** "Log FPU" logs FPUs without delivering insulin; the loop then doses for the future carbs via SMB as they become "due".
- **UAM:** with Unannounced Meal SMBs enabled, Trio detects and treats unexpected rises, explicitly including meals high in fat or protein.
- **oref1 safety guidance (OpenAPS docs):** do not give manual correction boluses based on insulinReq while SMB is active; if you give a manual partial correction, subtract the SMB oref1 is already delivering and round down. The loop is designed to give insulin "a little at a time" so it can stop if the rise slows.

Implication for Mellis: in Trio, a planned *second part* of a split bolus competes with SMB/UAM for the same late rise. If FPU entries are also enabled in Trio, the loop will already dose for fat/protein as future carbs, so a separate Mellis WBT/second dose for the same meal would double count.

## AndroidAPS (oref1, Android)

- Extended boluses are discouraged in a closed loop because they act like a fixed high temp basal, which conflicts with the loop's dynamic basal and removes its ability to prevent lows. With Dana/Insight pumps an extended bolus switches the loop to open loop while it runs.
- Recommended alternative: **eCarbs** (carbs spread over several hours) with SMB and "Enable SMB with COB" on. Example in the docs for pizza: a (partial) bolus up front via the calculator, then the remaining carbs as eCarbs over **4-6 h, starting after 1 or 2 h**. For low-carb, high-fat/protein meals eCarbs alone, without a manual bolus, may be enough.
- Full text: devices/androidaps-extended-carbs-ecarbs.md.

## Loop (iOS)

Source: LoopDocs "Carbs" page (https://loopkit.github.io/loopdocs/operation/features/carbs/; raw markdown in the LoopKit/loopdocs GitHub repo), read 2026-10-20.

- Loop has no fat/protein calculator. LoopDocs says many users **increase the carbohydrate amount** they enter to cover the expected effect of protein and fat, and that lower-carb eaters especially should consider the whole meal.
- **Absorption time** icons in Loop 3: lollipop 30 min, taco 3 h (default), pizza 5 h; the picker allows other values. Loop models absorption over **150% of the entered time**. The upfront insulin recommendation is similar up to 3 h absorption and **decreases as absorption time is made longer**, so a longer absorption time works as a built-in way of deferring part of the dose.
- Some foods "like pizza" may need entries that **start later** with a longer absorption time; entries can be placed up to 12 h back or 1 h ahead. The doc author's own example: using a separate fat-protein entry timed to **4 h after dinner**.
- Warning: using the fast (lollipop) absorption for a large complex meal can make Loop predict an unexpected low when the fast rise does not happen.

## Tandem Control-IQ / Control-IQ+

- Algorithm (as described in Marigliano 2026, articles/PMC13538753.md): model-predictive control, target about 112.5-160 mg/dL; increases basal when 30-min predicted glucose > 160 mg/dL; automatic correction boluses when predicted > 180 mg/dL, sized at **60% of the calculated correction**, at most **one per hour**. Meal composition is not an input.
- **Extended bolus:** with original Control-IQ the extended bolus is limited to **2 h** (Tandem quick-reference material, per web search; user guide not read). Tandem's support page states that **Control-IQ+** allows an extended bolus of **up to 8 h** while the algorithm is on, and lists high-fat/high-protein meals as a use case.
- Clinical data: Marigliano 2026 (adolescents, Control-IQ, carbohydrate-only bolus): 6-h TIR 84.3% standard vs **65.2% high-fat** vs **49.9% high-protein** meal despite the algorithm adding +26% and +55% insulin over 6 h, without more hypoglycaemia.

## Medtronic MiniMed 780G (SmartGuard)

- Per the Medtronic-authored review (Edd 2026, articles/PMC12805926.md): **no dual-wave bolus in SmartGuard**; Medtronic considers it obsolete because auto-corrections are given every 5 min. "Safe Meal Bolus" reduces manual boluses if postprandial hypoglycaemia is predicted over 4 h.
- Study cited there (Hirsch et al., 13 adults, high-fat/high-protein dinners): 5-h TIR similar for open-loop dual-wave + 30% extra insulin (76.2%), closed loop with carb counting (83.6%) and closed loop with a fixed predefined bolus (74.6%); over **10 h** TIR was higher in closed loop (85.5% and 78.2%) than open loop (64.6%), and **73% of open-loop meals needed a manual night-time correction**.
- Registered trials (not yet reported, ClinicalTrials.gov NCT06848933 and NCT07786064) test pizza meals with 780G; one closed-loop arm adds a supplementary bolus 1 h after the meal start equal to 50% of the declared carbs (per trial registration, via web search).

## CamAPS FX (Cambridge)

- Has a meal option **"slowly absorbed meal"** that delivers part of the meal bolus upfront and the rest over a period (as described in NHS patient materials and in Scaramuzza 2026; manufacturer manual not read).
- Scaramuzza 2026 (abstracts/scaramuzza-2026-dom-camaps-complex-meals.md, *unverified*): adolescents at camp; 50/50 split reported best for complex meals versus 100% standard bolus and 70/30 "slowly absorbed meal".

## Cross-system observations

- Every system either removes the classic extended bolus in closed loop (780G, AndroidAPS) or limits it (Control-IQ 2 h), and replaces it with **future carbs / absorption time** (Trio FPU, AndroidAPS eCarbs, Loop absorption time) or with automatic corrections.
- No published trial was found that tests a *planned second manual bolus* or FPU future carbs in **Trio/oref1** specifically. Evidence for AID users comes from Control-IQ, 780G, CamAPS and research algorithms.
