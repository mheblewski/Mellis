---
id: omnipod5-smartadjust-smartbolus-high-glucose
title: "Omnipod 5 (Insulet guides, Berget 2022): no automatic correction bolus, 5-min microboluses up to 400% of adaptive basal (e.g. 4 U/h at TDI 48), target 110-150 mg/dL; SmartBolus subtracts IOB incl. AID insulin; >250 mg/dL -> ketones, Pod change if ketones or no fall 2 h after correction"
publisher: "Insulet, \"Omnipod 5 Automated Insulin Delivery System User Guide for Insulet-provided Controller and Android smartphones"
year: 2022
url: https://www.omnipod.com/sites/default/files/omnipod-5_fsl3-lmr_user-guide_us-english.pdf
doi: 10.2337/cd21-0083
licence: "Own summary (Mellis); original: Insulet documents: proprietary, paraphrased with short quotes only. FDA summaries: US government work. Berget 2022: © American Diabetes Association, educational non-profit use with citation, unaltered; short quotes only"
mode: SUMMARY_ONLY
language: en
retrieved: 2026-10-21
topics: [correction, aid, sick-day, ketones, education, targets, settings]
index: true
corpus_v7: correction-up/devices/omnipod5-smartadjust-smartbolus-high-glucose.md
---

*Our summary or notes (Mellis knowledge base), written in our own words with short quotes only; not the original text and not medical advice. Original: https://www.omnipod.com/sites/default/files/omnipod-5_fsl3-lmr_user-guide_us-english.pdf.*

# Omnipod 5 (SmartAdjust): no separate automatic correction bolus - microboluses every 5 min up to 400% of the adaptive basal rate; SmartBolus Calculator subtracts IOB that includes algorithm-delivered insulin; >250 mg/dL -> check ketones

- **Type:** Manufacturer user guide, caregiver guide and HCP materials (paraphrased, short quotes) + FDA 510(k) summaries + peer-reviewed training paper
- **Journal/year:** Insulet, "Omnipod 5 Automated Insulin Delivery System User Guide for Insulet-provided Controller and Android smartphones" (US English, FreeStyle Libre 3 Plus edition, omnipod.com, accessed 2026-10-21); Insulet "Omnipod 5 Caregiver Guide" (R10, US); Insulet HCP education brochure "Omnipod 5 and SmartAdjust technology" (INS-OHS-07-2024-00123 v1.0, 2024) and "HCP Quick Glance Guide, Omnipod 5, age 2+" (INS-OHS-05-2024-00038 v2.0, 2024); FDA 510(k) decision summaries K203772 and K231824 (SmartBolus Calculator); Berget C, Sherr JL, DeSalvo DJ, et al., "Clinical Implementation of the Omnipod 5 Automated Insulin Delivery System: Key Considerations for Training and Onboarding People With Diabetes", Clin Diabetes 2022;40(2):168-184.
- **DOI:** Berget 2022: 10.2337/cd21-0083 (others: none)
- **URL:** https://www.omnipod.com/sites/default/files/omnipod-5_fsl3-lmr_user-guide_us-english.pdf ; https://www.omnipod.com/sites/default/files/Omnipod-5_Caregiver_Guide_R10.pdf ; https://www.omnipod.com/sites/default/files/HCP_education_brochure.pdf ; https://www.accessdata.fda.gov/cdrh_docs/reviews/K203772.pdf ; https://pmc.ncbi.nlm.nih.gov/articles/PMC9160549/
- **Licence:** Insulet documents: proprietary, paraphrased with short quotes only. FDA summaries: US government work. Berget 2022: © American Diabetes Association, educational non-profit use with citation, unaltered; short quotes only.
- **Saved:** notes on 2026-10-21 for the Mellis RAG corpus.

## Summary in one paragraph

Omnipod 5 has no discrete automatic correction bolus. Its SmartAdjust algorithm (on the Pod) predicts glucose 60 minutes ahead and every 5 minutes delivers a microbolus that raises or lowers insulin around an adaptive basal rate derived from total daily insulin (TDI, updated at every Pod change); Insulet's HCP brochure says that when high glucose is predicted it can deliver "up to 400%" of the adaptive basal rate (example: TDI 48 U -> adaptive basal 24 U/day -> maximum correction 4 U per hour). Target Glucose (110-150 mg/dL in 10 mg/dL steps, up to 8 segments) is the only setting that changes automation and is also the correction target of the SmartBolus Calculator. The calculator uses the programmed correction factor, a "Correct Above" threshold (target to 200 mg/dL), the CGM value and trend, and IOB; in Automated Mode the insulin the algorithm adds in response to hyperglycaemia is part of IOB and is subtracted from user-initiated boluses, so manual corrections are often smaller than users expect. Clinical guidance (Berget 2022, caregiver guide) is to follow the calculator, not override corrections upward, and to treat glucose > 250 mg/dL by checking ketones and changing the Pod if ketones are present or a correction fails within about 2 hours.

## Automated delivery (SmartAdjust) on the high side

- User guide: Automated Mode "adjusts every 5 minutes" and adapts TDI with every Pod change; "insulin is delivered and adjusted automatically based on sensor glucose values and 60-minute prediction". The Auto Events history shows the automated insulin per 5 minutes, i.e. baseline adaptive basal plus adjustments for sensor value, trend and 60-minute prediction.
- HCP brochure (2024): "When SmartAdjust predicts high glucose values, it will deliver a microbolus up to 400% of the patient's adaptive basal rate, every 5 minutes." Example (TDI 48 U, about 50/50 basal-bolus split, adaptive basal 24 U/day): "Max correction: 4 units per hour"; about 10.35 U was delivered between 9:00 and 12:30 after predicted hyperglycaemia, followed by a proactive decrease. A footnoted real-world poster (Ekhlaspour, ATTD 2024, 500 adults, 1,370 missed meal boluses) reports a mean 15.6% of TDI delivered automatically in the 4 hours after a missed meal bolus. [poster data seen only in the brochure: unverified]
- First Pod: TDI estimated from the programmed basal program and maximum delivery more constrained; full adaptivity from the second Pod (Berget 2022; Phillip 2023 Table 8).
- Activity feature: target 150 mg/dL and reduced automated insulin for 1-24 h (Berget). Phillip 2023 Table 8 (in corpus) lists HypoProtect/Activity as 50% reduction.
- "Automated Mode: Limited" (no sensor values for > 20 minutes) and exits for prolonged maximum delivery: troubleshoot the Pod site and ketones; if no problem, "a correction bolus should be delivered, and automated mode should be immediately restarted" (Berget 2022).

## SmartBolus Calculator and automated insulin

- Inputs (FDA K203772/K231824 and user guide indications): user-entered carbohydrates, most recent sensor glucose (or meter BG), rate of change of sensor glucose (if applicable), IOB, correction factor, insulin-to-carb ratio and target glucose. With CGM data the trend can increase or decrease the suggested bolus ("rising" -> more, "falling" -> less); with a manually entered BG the calculation equals the earlier Omnipod DASH calculator. [exact trend percentages not found in the documents read: unverified]
- **IOB includes automated insulin (Berget 2022, Table 2):** "When the algorithm increases insulin delivery in response to hyperglycemia, this insulin will factor into IOB and be subtracted from user-initiated boluses, in addition to the IOB from user-given boluses. As a result, correction boluses may be smaller than expected due to the additional IOB being taken into account from AID." The programmed Duration of Insulin Action (2-6 h, 30-min steps) is used only for IOB from user boluses; the algorithm uses its own method for automated IOB.
- **Correct Above:** target up to 200 mg/dL; the glucose level above which the calculator adds a correction; no effect on automation. **Reverse correction:** on/off; when on, a below-target glucose reduces the meal bolus; Insulet suggests turning it off when users are often below target at meals with post-meal highs. **Minimum Glucose for Calc:** 50-70 mg/dL.
- **Programmed correction factor:** used only for user-initiated corrections, in both Automated and Manual Mode (Berget; same for Control-IQ, unlike 780G).
- Insulet HCP advice for more bolus insulin under AID: strengthen ICR (up to 10-25%) and correction factors, adjust Correct Above when lowering the target, turn reverse correction off, shorten DIA "to subtract less insulin from user-initiated boluses".
- Caregiver guide tip: for snacks or second helpings, enter only the carbs and do not re-enter the glucose value, to avoid adding too much insulin at once; if glucose is still high a few hours later, give a correction then.

## When to give a manual correction / high glucose

- **Caregiver guide (R10):** high glucose "usually over 250 mg/dL". Steps: (1) check glucose; if BG > 250 mg/dL check ketones; (2) if ketones present, give a bolus per the provider's guidance and change the Pod, recheck BG in 2 hours, contact the provider if still high; (3) if no ketones, give a correction bolus from the Pod and recheck in 2 hours; if BG is the same or higher, follow step 2 even without ketones. The system cannot track insulin given outside it.
- **User guide:** change the Pod "if you have glucose of 250 mg/dL or more and ketones are present", or if you experience elevated glucose.
- **Berget 2022:** if hyperglycaemia (e.g. > 250 mg/dL) persists for > 90-120 minutes after a user-initiated correction, suspect a Pod site problem, check ketones and replace the Pod; with elevated ketones give rapid-acting insulin by pen/syringe before replacing the Pod and monitor glucose and ketones every 1-2 hours. Because the algorithm does not see injected insulin, clinicians might suggest Manual Mode for 2-4 hours after the injection. Users must learn "when to intervene with manual boluses" but also "to trust the system". Vignette 2: a parent overriding calculator corrections to her pre-AID amounts caused hypoglycaemia 1-2 h later; the advice was to follow the calculator, because AID-added insulin is in IOB.

## Notes for Mellis

- **Relevance:** Omnipod 5 treats highs only through 5-minute microboluses (no automatic correction bolus) and leaves the manual correction to the calculator, which subtracts the automated insulin. A meal card that adds a correction is consistent with Omnipod 5 practice if all IOB, including algorithm insulin, is subtracted and the card does not exceed the calculator.
- **Evidence level:** manufacturer labelling/marketing and a clinician training paper (expert opinion); no trial of correction strategies in this file.
