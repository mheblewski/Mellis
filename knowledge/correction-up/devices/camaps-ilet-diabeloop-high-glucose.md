---
id: camaps-ilet-diabeloop-high-glucose
title: "CamAPS FX, iLet, Diabeloop: CamAPS no auto boluses (Boost 10 min-12 h 59 min), calculator IOB excludes algorithm insulin so meal boluses without glucose term and corrections 'not too often'; iLet no manual bolus, corrects automatically; Diabeloop automatic correction boluses, meal bolus +/-10%"
publisher: "mylife Diabetes Care"
url: https://a.storyblok.com/f/287658439214273/x/819bd5f859/lop_bro_stepbystep_uk-en.pdf
doi: 10.1210/endrev/bnac022
licence: "Own summary (Mellis); original: manufacturer documents: proprietary, paraphrased with short quotes only. FDA summary: US government work"
mode: SUMMARY_ONLY
language: en
retrieved: 2026-10-21
topics: [correction, bolus-calculator, aid, insulin]
index: true
corpus_v7: correction-up/devices/camaps-ilet-diabeloop-high-glucose.md
---

*Our summary or notes (Mellis knowledge base), written in our own words with short quotes only; not the original text and not medical advice. Original: https://a.storyblok.com/f/287658439214273/x/819bd5f859/lop_bro_stepbystep_uk-en.pdf.*

# CamAPS FX, iLet Bionic Pancreas and Diabeloop DBLG1: high glucose without (CamAPS) or with automatic corrections, manual corrections discouraged (CamAPS calculator IOB excludes algorithm insulin) or impossible (iLet)

- **Type:** Manufacturer/distributor user guides and manufacturer web pages (paraphrased, short quotes) + FDA 510(k) decision summary + consensus table already in corpus
- **Journal/year:** mylife Diabetes Care (Ypsomed), "Step by Step to myLoop - Starting the CamAPS FX app for automated insulin delivery with myLoop" (UK English, document 10360414_UK-en/V03, about 2025; CamAPS FX with YpsoPump); Beta Bionics, "Meal Announcements" article (K. Hynes, 2025-03-13, modified 2026-01-22); FDA 510(k) decision summary K223846 (iLet ACE Pump and iLet Dosing Decision Software, 2023); Diabeloop "DBLG1 System" web page (dbl-diabetes.com, accessed 2026-10-21); Phillip M et al., Endocr Rev 2023;44(2):254-280, Tables 1 and 8 (already saved in the bolus-reduction corpus as articles/PMC9985411-excerpt.md; cited, not re-saved).
- **DOI:** Phillip 2023: 10.1210/endrev/bnac022 (others: none)
- **URL:** https://a.storyblok.com/f/287658439214273/x/819bd5f859/lop_bro_stepbystep_uk-en.pdf ; https://www.betabionics.com/articles/meal-announcements ; https://www.accessdata.fda.gov/cdrh_docs/reviews/K223846.pdf ; https://www.dbl-diabetes.com/dblg1-system
- **Licence:** manufacturer documents: proprietary, paraphrased with short quotes only. FDA summary: US government work.
- **Saved:** notes on 2026-10-21 for the Mellis RAG corpus.

## Summary in one paragraph

These three systems sit at the ends of the spectrum. CamAPS FX (Cambridge model-predictive control on a phone, with YpsoPump or Dana pumps) gives no automatic correction boluses at all; it raises basal delivery aggressively and offers "Boost" (10 min to 12 h 59 min, typically 2-4 h) for illness, site failure, missed boluses or miscounted carbs. Its bolus calculator's active insulin "excludes algorithm-driven insulin", and the user guide recommends leaving the glucose value out of (grey in) the calculator when bolusing for a meal and giving extra manual corrections "with caution and not too often". The iLet Bionic Pancreas has no manual bolus or correction at all: users only announce meals (usual/more/less) and the iLet "will correct for you automatically"; announcing a meal to fix a high is discouraged. Diabeloop DBLG1 delivers automatic correction boluses itself and computes meal boluses from announced carbs (user can modulate a meal bolus in 10% steps per Phillip 2023), so there is no user correction calculator in the classic sense.

## CamAPS FX (mylife Loop step-by-step guide, sections 7, 9, 10, 14, 18.4)

- **Automatic corrections:** none as boluses. Phillip 2023 Table 1: "Automated correction boluses via more aggressive basal rate adjustments; Optional use of 'Boost' mode"; Table 8: autocorrection "None (algorithm tuned not to need bolus autocorrection)". Default personal glucose target 5.8 mmol/L (104 mg/dL), adjustable 4.4-11.0 mmol/L (80-200 mg/dL).
- **Calculator IOB excludes loop insulin:** the home-screen information shows "Active insulin from bolus calculator (excludes algorithm-driven insulin)". The calculator's own target, correction factor and duration of insulin action are used only "when a manual correction is requested via the bolus calculator" and do not influence the algorithm. A "Maximum bolus suggestion" and "Minimum glucose for calculation" are set by the user.
- **Manual corrections (section 9.1):** the user can change the suggested bolus. "It is recommended that the glucose value in the bolus calculator is left grey and not included in the dose calculation for the carbohydrates about to be consumed. The algorithm is working hard in the background..." and "Additional manual corrections should be given with caution and not too often, as they may increase the risk of low glucose levels."
- **Boost (section 10):** makes the algorithm more responsive and increases insulin when glucose is high; for infusion set failure, illness, forgotten meal bolus, miscounted carbs or period due. Duration 10 min to 12 h 59 min (programmable up to 24 h ahead); recommended 2-4 h and re-assess. Once glucose is predicted to reach target, Boost stops being more responsive and may stop insulin. Overusing Boost "can hamper the algorithm's ability to learn"; do not use it to "drive the algorithm". Consider changing the set, cannula and reservoir if Boost is not bringing glucose down.
- **High glucose/ketones:** if unwell, with persistent high glucose or positive ketones, contact the diabetes team immediately; "Do not rely solely on the AID system to correct high glucose or clear the ketones"; check insulin delivery and use backup injections if needed; any interruption can lead to ketosis and DKA quickly "even if glucose readings are not very high".
- **Add meal:** carbs logged without a bolus (e.g. hypo treatment, activity); the algorithm may not prevent highs if more than 20 g is entered this way - give a meal bolus via the calculator for large amounts.

## iLet Bionic Pancreas (Beta Bionics)

- **No manual insulin:** FDA K223846 lists the iLet control mode as "iAGC closed-loop control only" (no open-loop basal/bolus mode, unlike the predicate). Clinical education material (ADCES PANTHER iLet, Texas Children's) states users cannot give a manual bolus or adjust doses. [secondary for the "no manual bolus" wording]
- **Meal announcements only:** the user announces breakfast/lunch/dinner as usual, more or less than usual. Beta Bionics: "Don't use a meal announcement to try to correct a high glucose level" (risk of lows and slower learning); "Your iLet will correct for you automatically." If more than 30 minutes have passed since starting to eat, do not announce (correction insulin is already being given).
- Fraction or cap of the iLet's automatic corrections: not published in the documents read. [unverified]

## Diabeloop DBLG1

- Manufacturer page: the algorithm, using glucose every 5 minutes, can "deliver a bolus to correct a high"; set-up needs only weight, total daily insulin, typical meals and a safety basal profile; users can adjust target, aggressiveness and hypo/hyper thresholds, and use "Zen Mode" (temporarily higher target).
- Phillip 2023 Table 1: Diabeloop gives automated correction boluses; default target 110 mg/dL (adjustable 100-130); Zen mode 20-40 mg/dL higher; "A bolus for a given meal can be modulate[d] by +/- 10% increment"; alert for rescue carbohydrates. Size, frequency and cap of the automatic corrections: not published in these sources. [unverified]

## Notes for Mellis

- **Relevance:** CamAPS FX is the one commercial system whose calculator ignores algorithm insulin, and its manufacturer answers that by recommending the meal bolus be calculated without the glucose term (carbs only) and corrections be given sparingly. iLet removes manual correction entirely. Both support a conservative default for a meal card: dose the carbs, and treat any added correction as optional and net of all insulin the loop has already given.
- **Evidence level:** manufacturer instructions and web pages; no outcome data on correction strategies.
