---
id: loopdocs-loop-3-displays-v3
title: "LoopDocs: Loop 3 displays: main screen, HUD icons and colours, charts, toolbar, Status Row messages, time zone and pump time"
publisher: "LoopDocs (LoopKit)"
url: https://loopkit.github.io/loopdocs/loop-3/displays-v3/
licence: "Own summary (Mellis); original: LoopDocs has no licence file: paraphrased with short quotes only"
licence_url: https://github.com/LoopKit/loopdocs
mode: SUMMARY_ONLY
language: en
retrieved: 2026-11-14
topics: [loop, aid, pump, cgm, insulin, education]
index: true
---

*Our summary (Mellis knowledge base) of a LoopDocs page, written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/loop-3/displays-v3/.*

# LoopDocs: Loop 3 displays

## Main Loop screen layout [section "Main Loop Screen" / "Heads-Up Display"]

The Loop 3 main screen has the Heads-Up Display (HUD) at the top, charts in the middle and a toolbar at the bottom. The HUD shows glucose status (left), Loop status (middle) and pump status (right). Under them the Status Row shows bolus progress, alerts and messages, and acts as a button. The HUD and Status Row appear only in portrait; in landscape the charts show more history (on the author's phone about 8 hours back plus 6 hours of prediction).

## Loop Glucose Chart [section "Charts" / "Glucose Chart"]

Tapping any chart opens more detail. The Glucose Chart uses the chosen unit (mg/dL or mmol/L), scales itself to fit the highest and lowest readings, and runs from now forward through DIA, backwards as far as the screen allows. The Correction Range is a blue bar (narrower for a single value such as 100-100 mg/dL); an override's range is a darker blue bar.

A high prediction after a meal bolus is expected: the forecast assumes Loop does nothing more, and the meal recommendation only keeps the near-term forecast above the Glucose Safety Limit. Loop adds insulin as glucose rises, automatically only once glucose is above the bottom of the correction range; the user can bolus earlier or use a lower-range override for a few hours. A wildly negative prediction usually comes from an override with a tiny Overall Insulin Needs percentage; it is only a forecast.

## Loop Predicted Glucose chart [section "Predicted Glucose Chart"]

Tapping the Glucose Chart shows the forecast's parts: Carbohydrates, Insulin, Glucose Momentum, Retrospective Correction (or Integral Retrospective Correction) and Suspension of Insulin Delivery (added to help judge how long a site change or pump suspension can wait). Tapping an item shows its effect as dashed lines; this changes only the drawing, not Loop's real prediction. Algorithm Experiments (Loop 3.4) include IRC; when enabled the chart shows both retrospective components, when disabled (default) only standard retrospective correction is used. LoopDocs notes IRC helps not only when "stuck on high" but also when glucose falls faster than expected.

## Loop Active Insulin chart [section "Active Insulin Chart"]

Shows IOB from temp basals and boluses; IOB is negative when scheduled basal was reduced or suspended. The number updates as soon as Loop sends a command and may be revised if the command surely failed or the user cancels a bolus or temp basal. A break at a critical moment brings up the "Unable to Reach Pump" modal, which usually clears itself. Medtronic only: with Event History as Preferred Data Source, priming insulin is not counted in IOB.

## Loop Insulin Delivery chart [section "Insulin Delivery Chart"]

Shows Loop's temp basals relative to the scheduled basal ("+0 units" means scheduled rate) and boluses as orange triangles. The daily total since midnight includes all basal and boluses and, for Medtronic, priming. Loop assumes a bolus succeeded until it can confirm; meanwhile a bolus may be drawn as a very high temp basal, which is only a drawing.

## Loop Event History, Reservoir and Non-Pump Insulin [section "Event History, Reservoir and Non-Pump Insulin" / "Event History and Details"]

Tapping either insulin chart opens history with current IOB and today's total, in three tabs. **Event History**: every pump action (Temp Basal, Bolus, Suspend, Resume; a return to scheduled basal is implied, not listed); tap for details. **Reservoir**: blank for Omnipod until under 50 U, and gone once a pod is deactivated; other pumps show 5-minute history. **Non-Pump Insulin**: log injected or inhaled insulin, possibly of another type.

In event details, `automatic: false` marks a user action, `automatic: true` one by Loop. While running, `isMutable` is true and `deliveredUnits` is `nil`; `units` is the requested bolus or the temp basal rate in U/hr. When final, `isMutable` is false and `deliveredUnits` holds the pump-reported dose that replaces Loop's estimate; a superseded temp basal gets its real end time. Earlier insulin records (e.g. a failed site) can be deleted in Apple Health, after reading LoopDocs' HealthKit FAQ.

## Loop Active Carbohydrates chart [section "Active Carbohydrates Chart" / "ICE Chart"]

Shows the carbs Loop uses, with COB at upper right. Tapping opens Carb Entries, where entries can be edited or deleted, along with the Insulin Counteraction Effects (ICE) chart.

## Loop toolbar [section "Toolbar"]

Always visible, left to right: **Meal Entry** (Loop does not read carbs from a Medtronic pump or Nightscout, so enter them here); **Pre-Meal Range** (one hour or until carbs are entered; plate turns dark green); **Bolus**; **Overrides** (choose or cancel; heart turns dark blue); **Loop Settings**.

## Loop Status Icon colours and the Loop cycle [section "HUD Details" / "Loop Status Icon" / "Loop Cycle"]

Normal HUD: glucose in the CGM's units (if wrong, quit Loop, let the CGM app update, restart; or set units in Apple Health), green Loop icon, pump showing "+0.0 U" for scheduled basal. A Loop cycle = new glucose, new prediction and any insulin change to stay above the safety threshold and in the correction range, commands and status request to the pump, pump acknowledgement. Tapping the icon shows the last cycle time.

- **Green:** closed loop, cycle within 5 minutes.
- **Yellow:** last cycle 5-15 minutes ago; a few a day are normal (distance, Bluetooth or RileyLink interference, a bolus running) and usually clear.
- **Red:** over 15 minutes; troubleshoot. The glucose or pump icon will show an alert.
- **Open circle:** Open Loop, same colours, predictions and pump status only, no automatic changes. Also shown during a Manual Temp Basal, which Loop 3 offers only for Omnipod and DASH.

The icon pulses while talking to the pump. The tap message varies with Closed Loop on or off and time since last cycle (under 20 minutes, under 4 hours, over 4 hours).

## Loop Glucose Status Icon and colour code [section "Glucose Status Icon" / "Glucose Color Code"]

A number with arrow means a CGM or fingerstick value from the last 15 minutes. Three dashes mean stale (over 15 minutes): the prediction stops, the Status Row offers a fingerstick, and in closed loop insulin is not changed; a running temp basal finishes, then scheduled basal resumes. Loop's own temp basals always last 30 minutes; manual ones can be as long as the pump allows. A plus icon means no CGM selected (with a value if one came from fingerstick or another CGM in 15 minutes).

Colours: 55 mg/dL (3.0 mmol/L) or below, value and arrow red; 56-79 mg/dL (3.1-4.4 mmol/L), normal text with yellow arrow; 80-199 mg/dL (4.4-11.0 mmol/L), normal text with blue arrow; 200 mg/dL (11.1 mmol/L) or above, normal text with yellow arrow. Normal text is black in light mode, white in dark mode.

## Loop CGM details screen [section "CGM Display"]

Tapping the CGM icon shows the last reading's details; for Dexcom G5/G6 and Share the same screen is in Loop Settings -> CGM (G6: time to the second, sensor and transmitter data, link to the Dexcom app). For Nightscout Remote CGM the icon opens the Nightscout URL and Settings -> CGM shows the credentials.

## Loop Pump Status Icon: basal and reservoir [section "Pump Status Icon"]

The left side shows the temp basal relative to schedule. With 0.45 U/hr scheduled, a 0.2 U/hr temp shows -0.25 U, 1.5 U/hr shows +1.05 U. With a 70 % override, the comparison base is 0.315 U/hr (not settable on the pump, but used for IOB), so those temps show -0.115 U and +1.185 U. The right side shows the reservoir, with a number under 50 U; pods look full until they report under 50 U. Pods get a lifecycle line in their last 24 hours. Tapping opens Pump Settings.

## Loop pump status alerts [section "Pump Status Icon"]

- Reservoir graphic orange above the user's notification level, yellow below it; a clock icon means pump and phone time zones differ.
- **No Insulin:** reservoir reports 0 U; pumps may still deliver (pods up to 4 U) but can stop any moment. A yellow 0 U means 0.5 U or less.
- **No Pod:** none paired, no insulin delivered. **Insulin Suspended:** resume from the Status Row or Pump Settings. **Manual Basal:** MTB running, Loop shows Open Loop.
- **No Data:** no pump contact for over 15 minutes; troubleshoot. **Add Pump:** none added. **Finish Setup:** pod setup incomplete; in older code (Finish Pairing) wait for priming before inserting the cannula.

## Loop time zone and pump time [section "Time Zone"]

Loop's pump may keep a different time zone from the phone, so basal, CR, ISF and correction range schedules follow pump time, including after travel, daylight saving changes and pod changes (in Trio, pump and phone time always match). Medtronic and Dana show the time on the pump; always set it through Loop. To align, tap the active row in Pump Settings: Medtronic gets phone time, Omnipod gets the basal schedule by phone time; keep phone, pump and RileyLink close. Many leave the zones different on short trips; the clock icon stays as a reminder.

## Loop and manual phone time changes [section "Other Time Changes"]

Never set the time by hand (iOS -> General -> Time & Date) on a Looping phone; an old reading "in the future" breaks predictions and may be dangerous. Loop warns repeatedly and Loop 3 shows a modal; turning on Set Automatically stops it.

## Loop HUD Status Row messages, by priority [section "HUD Status Row"]

Messages are ranked; bolus messages always win and the previous message returns only after the bolus ends or is cancelled. Keep the phone locked so a bolus is not cancelled by accident.

- **Starting Bolus:** no tap action; becomes progress once the command reaches the pump or RileyLink.
- **Bolused value of total U:** manual or automatic bolus. Tap to cancel (needs communication). The value is timer-based, so a fault can occur unseen; tap the pump icon to refresh status, which also helps silence a screaming pod.
- **Canceling Bolus:** no tap action.
- **Insulin Suspended, Tap to Resume:** resumes scheduled basal. Medtronic suspended on the pump shows it late; suspend from Loop instead.
- **No Recent Glucose, Tap to Add:** opens the bolus screen for a fingerstick. To save it without a bolus, set the Bolus row to 0 U and tap Save Without Bolusing; in closed loop Loop uses it for 15 minutes.
- **Override name and end time:** tap to edit for this session only.
- **Pre-meal Preset, until time:** no tap action. New in Loop 3, Pre-Meal can combine with an override: Pre-Meal's range wins, the override's other settings apply, both toolbar icons light up.
