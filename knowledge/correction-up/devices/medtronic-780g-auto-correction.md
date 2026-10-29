---
id: medtronic-780g-auto-correction
title: "Medtronic 780G SmartGuard (User Guide 2025, Carlson 2022): auto correction up to every 5 min to fixed 120 mg/dL once max auto basal reached (fraction undisclosed), 22% of bolus insulin (66% at night); manual correction only if BG/SG >=120, after active insulin and if basal not sufficient; High SG alert >=250 mg/dL for 3 h"
publisher: "Medtronic MiniMed, \"MiniMed 780G System User Guide\""
year: 2025
url: https://origin.medtronicdiabetes.com/sites/default/files/library/download-library/user-guides/MiniMed-780G-system-user-guide.pdf
doi: 10.1089/dia.2021.0319
licence: "Own summary (Mellis); original: Medtronic documents and PANTHER tool: proprietary, paraphrased with short quotes only. Carlson 2022: CC BY 4.0 (numbers restated). Berget 2022: © ADA, educational use with citation; short quotes only"
mode: SUMMARY_ONLY
language: en
retrieved: 2026-10-21
topics: [correction, aid, education, settings]
index: true
corpus_v7: correction-up/devices/medtronic-780g-auto-correction.md
---

*Our summary or notes (Mellis knowledge base), written in our own words with short quotes only; not the original text and not medical advice. Original: https://origin.medtronicdiabetes.com/sites/default/files/library/download-library/user-guides/MiniMed-780G-system-user-guide.pdf.*

# Medtronic MiniMed 780G (SmartGuard): auto correction boluses up to every 5 min to a fixed 120 mg/dL target once auto basal is at maximum; manual correction only if BG/SG >= 120 mg/dL and not covered by active insulin or current basal

- **Type:** Manufacturer system user guide and HCP brochure (paraphrased, short quotes) + pivotal-trial article + clinical education tool and training paper
- **Journal/year:** Medtronic MiniMed, "MiniMed 780G System User Guide" (US, mg/dL, © 2025, document M072481C001_2, dated 2025-08-29, models MMT-1884/MMT-1894; downloaded from the Medtronic Diabetes download library); Medtronic "MiniMed 780G System" HCP brochure (EMEA, 2022, eMeA-GDB-2100082); Carlson AL et al., Diabetes Technol Ther 2022;24(3):178-189 (pivotal trial, adolescents and adults); PANTHER Program "PANTHERTOOL for MiniMed 780G" (October 2023); Berget C et al., Clin Diabetes 2022;40(2):168-184.
- **DOI:** Carlson 2022: 10.1089/dia.2021.0319; Berget 2022: 10.2337/cd21-0083 (others: none)
- **URL:** https://origin.medtronicdiabetes.com/sites/default/files/library/download-library/user-guides/MiniMed-780G-system-user-guide.pdf ; https://resources.cloud.medtronic-diabetes.com/sites/prd/files/documents/2022-10/hcp_brochure_mgdl_new_brand.pdf ; https://pmc.ncbi.nlm.nih.gov/articles/PMC8971997/ ; https://cdn.baptistjax.com/image/upload/v1711641999/WolfsonChildrens/Services/Endo/MiniMed-780G_TOOL_102023.pdf
- **Licence:** Medtronic documents and PANTHER tool: proprietary, paraphrased with short quotes only. Carlson 2022: CC BY 4.0 (numbers restated). Berget 2022: © ADA, educational use with citation; short quotes only.
- **Saved:** notes on 2026-10-21 for the Mellis RAG corpus. Page numbers refer to the 2025 US user guide (SmartGuard chapter pp. 185-201; alerts appendix pp. 316-335).

## Summary in one paragraph

In SmartGuard (780G advanced hybrid closed loop) the pump gives Auto Basal every 5 minutes toward a user-selected target of 100 (default), 110 or 120 mg/dL and, with Auto Correction on (default On), automatic correction boluses "as frequently as every 5 minutes" toward a fixed 120 mg/dL target. Medtronic's HCP material says auto corrections are given when maximum auto basal delivery has been reached and sensor glucose is above 120 mg/dL; a DreaMed meal-detection module can make auto corrections more aggressive after an unannounced rise. The fraction of the computed correction delivered per auto bolus is not published. Corrections use the algorithm's own sensitivity (Berget 2022: in auto mode the system determines the correction factor itself; a German AGDT fact sheet says the parameters come from the total daily insulin of the past 2-6 days [unverified]), not the programmed sensitivity factor, and the shorter the Active Insulin Time (recommended 2-3 h in the guide, 2 h for highest TIR per PANTHER), the more insulin corrections deliver. In SmartGuard the user cannot edit the calculated bolus; a correction is recommended only if BG or SG is at least 120 mg/dL, the dose is still above zero after active insulin, and the algorithm does not judge current basal delivery sufficient. Active insulin counts bolus insulin only (manual and auto-correction boluses), not auto basal. In the pivotal trial auto corrections were about 22% of all bolus insulin (66% at night). High SG alert: SG >= 250 mg/dL for 3 hours -> check infusion set and ketones.

## Auto Correction (User Guide 2025, pp. 185-190; HCP brochure 2022)

- SmartGuard target for Auto Basal: 100, 110 or 120 mg/dL (default 100). "Target for Auto correction bolus based on SG: 120 mg/dL". The pump "may deliver a bolus automatically, as frequently as every 5 minutes, if the SmartGuard feature determines that a correction bolus is necessary"; Auto correction default On.
- HCP brochure: bolus delivered automatically up to every 5 minutes if (1) maximum auto basal delivery is reached and (2) sensor glucose is above 120 mg/dL. "The auto correction target is set at 120 mg/dL."
- Temp Target 150 mg/dL (for exercise, 2-12 h per Berget): auto correction boluses are not delivered while a temp target is active.
- Auto corrections are given without user acknowledgment and use SG values; the guide warns that SG may differ from BG (first 12 hours of a sensor; acetaminophen/paracetamol falsely raises some sensors - use a temp target and BG values for up to 8 hours).
- **Size of each auto correction: not disclosed** in the user guide, HCP brochure or the training paper. Phillip 2023 (in corpus) and Berget 2022 state only that corrections are based on control-algorithm parameters, not on programmed sensitivity factors; PANTHER: the user "cannot adjust sensitivity factor or correction bolus target (fixed at 120 mg/dL ... when using SmartGuard)". Meal Detection (DreaMed): "auto-correction boluses may be stronger" when the rate of rise suggests a meal (PANTHER; Carlson 2022: "a more aggressive auto-correction bolus when appropriate").
- **Active Insulin Time:** "In SmartGuard, auto correction boluses are delivered up to every 5 minutes. A shorter Active Insulin Time setting may result in more insulin being delivered in correction boluses." Recommended initial AIT with SmartGuard 2-3 hours (guide); PANTHER suggests target 100 mg/dL + AIT 2 hours for highest TIR if TBR < 4%. HCP brochure: users with target 100 + AIT 2 h ("optimized settings") had 80.7% TIR vs 75.8% overall (real-world, 12,870 users).
- **Safety limits:** SmartGuard exits after 7 hours at maximum auto basal ("SmartGuard max delivery" alert, enter BG) or after 3-6 hours at minimum delivery. Total daily insulin must be 8-250 U/day.

## Manual bolus in SmartGuard and how auto insulin is counted (User Guide pp. 96-97, 197-201)

- **Active insulin definition:** "Active insulin is bolus insulin delivered by the insulin pump that continues to lower BG levels." The Home screen amount "includes only the bolus insulin received" - auto basal is not included; auto correction boluses are boluses delivered by the pump and are therefore counted (own reading of the definition).
- **Correction in the SmartGuard bolus:** "If the BG or SG is under 120 mg/dL, or if the bolus is zero after the pump accounts for active insulin, or if the SmartGuard feature estimates current basal delivery is sufficient, no correction is recommended." The correction is included in the "Adjustment" line; SG is used if no meter BG in the last 12 minutes; a BG must not be used if more than 12 minutes old.
- "In the Bolus Wizard and SmartGuard Bolus feature, the Active Insulin Time setting is used to calculate a correction bolus by subtracting the estimated active insulin from each bolus."
- **Bolus amount cannot be modified** when delivering a bolus in SmartGuard. The algorithm may adjust a meal bolus down (even to 0.0 U) if it predicts post-meal hypoglycaemia; the carbs are kept for later adjustments.
- **Manual injections** (pen/syringe) are not counted in active insulin; do not use the Bolus Wizard or SmartGuard for a period after an injection (time set by the healthcare professional).

## When to give a manual correction / high glucose

- **Alerts:** High SG alert fixed at SG >= 250 mg/dL for 3 hours (cannot be changed or silenced); guide action "Check infusion set. Check ketones. Monitor glucose." General precaution: "If BG is too high, check the pump and the infusion set"; occlusion alarm: check BG and ketones, inject if necessary, change the set.
- **PANTHER 780G tool (2023):** check ketones if there is persistent hyperglycaemia; > 300 mg/dL (16.7 mmol/L) for 2 hours -> check ketones first; if >= 1.0 mmol/L (moderate/large urine), give a syringe injection and replace the infusion set. "Do not enter fake carb boluses to give more insulin than the pump recommends - this may cause hypoglycemia." Educate users to give correction boluses via the bolus calculator, following its recommendation, and to give carb boluses only for meals and snacks. If bolusing after a meal, "reduce bolus or skip the bolus as system has already been increasing insulin for hyperglycemia". "Avoid overthinking the automated insulin delivery."
- **Pivotal trial (Carlson 2022, n = 157, 14,134 days of AHCL):** Auto Correction made up 22.0% of total bolus insulin over 24 h (18.8% daytime) and 66.1% at night (adolescents 69.9%, adults 64.9%); user-initiated boluses were 78% of bolus insulin vs 99.8% in run-in. No severe hypoglycaemia or DKA with Auto Basal + Auto Correction.

## Notes for Mellis

- **Relevance:** the 780G shows the opposite design to Control-IQ: small automatic corrections every 5 minutes to 120 mg/dL instead of one 60% bolus per hour, and the manual correction is suppressed whenever active insulin or current basal is judged sufficient. Manufacturer and clinical guidance discourage extra manual insulin (fake carbs, overrides) but still allow pump-recommended corrections; after a late meal bolus PANTHER advises reducing or skipping it.
- **Evidence level:** manufacturer labelling and marketing (design description), one industry-funded pivotal trial, clinical education tools.
