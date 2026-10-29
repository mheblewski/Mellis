---
id: trio-oref-manual-bolus-while-smb-active
title: "Manual/remote bolus while SMB active (Trio 0b29cd5 + oref0): IOB up -> insulinReq down -> SMB stops, only 3 min SMB pause, zero temp can undo at most basal rate x time; Trio remote bolus rejected if > Max Bolus, IOB+amount > Max IOB, or SMBs/boluses >=20% of amount since command; OpenAPS docs: never bolus full insulinReq"
publisher: "nightscout/Trio `main` at 0b29cd53415e7f0e668677749cad8daf81c68c2f"
url: https://github.com/nightscout/Trio/blob/0b29cd53415e7f0e668677749cad8daf81c68c2f/Trio/Sources/Services/BolusSafety/BolusSafetyValidator.swift
licence: "Own text (Mellis); short code excerpts from nightscout/Trio and openaps/oref0 under the MIT License"
licence_url: https://opensource.org/license/mit
mode: SUMMARY_ONLY
language: en
retrieved: 2026-10-21
topics: [correction, trio, oref, smb, limits, settings]
index: true
corpus_v7: correction-up/devices/trio-oref-manual-bolus-while-smb-active.md
---

*Our summary or notes (Mellis knowledge base), written in our own words with short quotes only; not the original text and not medical advice. Original: https://github.com/nightscout/Trio/blob/0b29cd53415e7f0e668677749cad8daf81c68c2f/Trio/Sources/Services/BolusSafety/BolusSafetyValidator.swift.*

# Manual or remote bolus while Trio/oref SMB is active: what the loop does next (IOB up → insulinReq down → SMB stops, zero temp at most = basal rate), the 3-min SMB pause, Max IOB, and Trio's remote-bolus checks (Max Bolus, Max IOB, ≥20% of the amount bolused since the command → rejected) (source-code notes)

- **Type:** Source-code notes plus pointers to documentation already in the corpus (open-source AID: OpenAPS oref1 and Trio)
- **Journal/year:** nightscout/Trio `main` at 0b29cd53415e7f0e668677749cad8daf81c68c2f (2026-10-07, v1.0.2): `Trio/Sources/Services/BolusSafety/BolusSafetyValidator.swift`, `Trio/Sources/Services/RemoteControl/TrioRemoteControl+Bolus.swift`, `Trio/Sources/APS/Storage/PumpHistoryStorage.swift`, `Trio/Sources/APS/OpenAPSSwift/Iob/IobGenerator.swift`, `Trio/Sources/APS/OpenAPSSwift/DetermineBasal/DosingEngine.swift`; openaps/oref0 `lib/determine-basal/determine-basal.js` (master 88cf032aa74ff25f69464a7d9cd601ee3940c0b3)
- **DOI:** none
- **URL:** https://github.com/nightscout/Trio/blob/0b29cd53415e7f0e668677749cad8daf81c68c2f/Trio/Sources/Services/BolusSafety/BolusSafetyValidator.swift
- **Licence:** MIT (nightscout/Trio, openaps/oref0). Short code excerpts quoted; the rest is our description. The documentation statements below are short paraphrases of pages already in the corpus, cited by file name.
- **Saved:** notes from the GitHub source on 2026-10-21 for the Mellis RAG corpus. Companion files: `devices/oref-smb-insulinreq-code.md` (SMB sizing) and `devices/trio-bolus-calculator-correction-code.md` (calculator).

## Summary in one paragraph

oref has no special "manual bolus" mode. A manual or remote bolus simply raises IOB. At the next loop (each CGM reading, about 5 min), eventualBG and minPredBG drop by about bolus × ISF, so insulinReq drops by about the bolus amount. SMBs and high temps stop as soon as insulinReq ≤ 0, and when the forecast falls below target oref sets low or zero temps. A bolus also blocks SMBs for only 3 minutes (`SMBInterval`). So if a correction is too large, oref can take back at most the scheduled basal: with basal 0.5 U/h, a zero temp offsets only 0.5 U per hour, while the extra bolus insulin acts mostly within 1–2 hours. Excess manual insulin can therefore only be partly compensated, and only slowly. The OpenAPS oref1 docs therefore say not to do correction boluses based on insulinReq, and never the full insulinReq, because SMB is already delivering part of it. For remote boluses (what Mellis sends), Trio rejects the command if the amount is above Max Bolus, if IOB + amount would exceed Max IOB, or if boluses (including SMBs) totalling ≥ 20% of the requested amount were delivered after the command was sent.

## What the loop does after a manual bolus (code path)

1. **IOB:** the bolus enters pump history as a bolus with `isSMB = false` (PumpHistoryStorage line 324). It counts fully in IOB and in `lastBolusTime` (IobGenerator lines 22–24).
2. **SMB pause:** `lastBolusAge` (minutes since the last bolus of any kind) must exceed `SMBInterval`, default 3 min (range 1–10), before another SMB (DosingEngine lines 820–848; oref0 lines 1072, 1133–1150). There is no longer pause after a big manual bolus.
3. **insulinReq falls:** `naive_eventualBG = BG − IOB × ISF`. With ISF 50, a 2 U bolus lowers eventualBG by about 100 mg/dL, and `insulinReq = (min(minPredBG, eventualBG) − target)/ISF` falls by about 2 U. If it becomes ≤ 0, no SMB is given (half of a negative number rounds to nothing).
4. **Basal goes down:**
   - eventualBG < min_bg → low temp `basal + 2 × insulinReq` (negative insulinReq), possibly a zero temp of up to 120 min.
   - minGuardBG < threshold → predictive suspend, a 30–120 min zero temp.
   - If oref still gives an SMB but IOB alone would take BG below target, it pairs it with a 30–60 min low temp.
   (Details in `bolus-reduction/devices/oref-determine-basal-low-and-carbsreq.md`.)
5. **Max IOB:** if IOB (bolus + SMB + net basal) exceeds `max_iob`, oref stops all extra insulin and runs scheduled basal (DosingEngine `iobGreaterThanMax`). A large manual meal bolus can therefore switch SMB off until IOB decays below Max IOB.
6. **High temp already running:** a high temp set before the bolus keeps running until the next loop (≤ 5 min with 5-min CGM). Then oref lowers it because "temp > 2 × insulinReq".

**How much the loop can undo:** a zero temp removes only scheduled basal, i.e. at most basal rate × hours. Example: basal 0.5 U/h, extra 1.5 U given manually on top of what oref was already dosing. Even a continuous zero temp needs 3 h to withhold 1.5 U, while the bolus acts mostly within 1–2 h (Trio rapid-acting peak 75 min). The early part of the overdose reaches the patient before the zero temp can balance it. For children with basal 0.2–0.4 U/h the margin is even smaller.

## Trio checks on a remote bolus (BolusSafetyValidator.swift lines 43–60; TrioRemoteControl+Bolus.swift lines 5–22)

Applied to "any bolus command originating outside the main bolus UI (remote notifications, Shortcuts, etc.)":

- amount > Max Bolus → rejected ("exceeds the maximum allowed");
- IOB unknown → rejected;
- current IOB + amount > Max IOB → rejected ("would exceed max IOB … Current IOB …"). This is stricter than the bolus screen: Trio docs (`trio/configuration_settings_therapy_units-limits.md`) say the user can still bolus manually above Max IOB from the app, but a remote command cannot;
- boluses delivered since the command's timestamp total ≥ 20% of the requested amount → rejected (`recentBolusThreshold = 0.2`; the window is 6 min when no timestamp is given). SMBs are stored as bolus events (`isSMB = true`, PumpHistoryStorage line 158), so they count. Example: a remote 1.5 U command fails if SMBs of ≥ 0.3 U were delivered after it was sent. One SMB of 0.3 U (30 min of a 0.6 U/h basal) is enough.
- If accepted, it is delivered as a manual bolus (`isSMB: false`), and the loop then reacts as described above.

## Documentation statements that matter (already in the corpus; not re-saved)

- `openaps/Customize-Iterate_oref1.md`:
  - With SMB/UAM, "do not do correction boluses based on insulinReq"; use temp targets to nudge the loop instead, because manual dosing on top of SMB is "very likely to overshoot".
  - On insulinReq alerts: never bolus the full insulinReq, because SMB is already delivering part of it. SMB gives insulinReq "a little at a time" so it can react if the rise slows. If the user still gives a partial manual correction, subtract the SMB just delivered and round down.
- `openaps/Customize-Iterate_optimize-your-settings.md`: lows caused by "rage bolusing" or bolusing too much when high are a behaviour problem, not a settings problem. A low temp target is the safer way to ask for "more".
- `openaps/While_You_Wait_For_Gear_preferences-and-safety-settings.md`:
  - `max_iob` counts insulin from all sources, including boluses.
  - A52 risk: with SMB, enter carbs and give an up-front bolus that is "generally less than the full amount" the bolus wizard would suggest, and let SMB fill in the rest.
- `trio/help_faq.md`:
  - Recommended Bolus Percentage: Trio delivers the remaining insulin "via Temp Basals and/or SMBs as the blood sugar rises".
  - Long low or zero temps after SMBs are expected ("borrow insulin from the future").
- `trio/configuration_transition-qa.md`: with UAM and SMB properly configured, Trio makes the corrections itself; no need for manual corrections or "fake carbs".
- `trio/configuration_settings_algorithm_smb-settings.md`:
  - all SMB toggles default OFF and are inclusive (any one enables SMB);
  - a high temp target > 100 mg/dL disables SMB;
  - "Max Allowed Glucose Rise for SMB" is 20% (10–40%);
  - Max SMB/UAM Basal Minutes default 30.
- `trio/configuration_settings_features_bolus-calculator.md`: Recommended Bolus Percentage is 80% (5–150%) because SMB/UAM add the rest.

## Notes for Mellis

- **Relevance:** Mellis's meal card can be sent to Trio as a remote bolus. While Trio is running SMBs for a high, these are the risks:
  - (a) Double counting, if the card's correction does not subtract the IOB that SMBs and high temps already added.
  - (b) Rejection, if SMBs ≥ 20% of the card amount land between sending and delivery.
  - (c) Rejection, if IOB + card > Max IOB.
  - (d) After delivery, the loop can only withhold basal, at most basal rate × time, to undo an over-correction.
- A meal bolus without a correction is not "unsafe" for the high. oref sees the remaining high in eventualBG and keeps giving SMBs (about 50% of insulinReq per loop, capped at 30 min of basal) after the meal bolus, as long as SMB is on and Max IOB allows it.
- **Evidence level:** code and project documentation for specific open-source versions; not clinical trials.
