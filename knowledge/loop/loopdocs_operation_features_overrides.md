---
id: loopdocs-operation-features-overrides
title: "LoopDocs: Loop Overrides: overall insulin needs and target range, future and scheduled overrides, the 10% trap, editing and remote overrides"
publisher: "LoopDocs (LoopKit)"
url: https://loopkit.github.io/loopdocs/operation/features/overrides/
licence: "Own summary (Mellis); original: LoopDocs has no licence file: paraphrased with short quotes only"
licence_url: https://github.com/LoopKit/loopdocs
mode: SUMMARY_ONLY
language: en
retrieved: 2026-11-14
topics: [loop, settings, targets, exercise, sick-day, insulin, hypoglycaemia, aid]
index: true
---

*Our summary (Mellis knowledge base) of a LoopDocs page, written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/operation/features/overrides/.*

# LoopDocs: Loop Overrides

## Loop overrides are not a pump temp basal [section "New Loopers - Please Read"]

LoopDocs asks new users not to use overrides before understanding them. Many people treat a Loop override as a replacement for the temp basal they used on a manual pump, but an override is more powerful. LoopDocs' advice for holding back basal in an automated system is to raise the correction target for a while first, and only adjust insulin needs if that is not enough. Changing Overall Insulin Needs changes basal rates, carb ratios and ISF together for the whole override. A classic mistake: a 10% Overall Insulin Needs override is not a 10% temp basal; it changes every one of those settings by a factor of 10.

## Manual Temp Basal instead of an override [section "Manual Temp Basal"]

When a reduced or raised rate has to keep running even away from the Loop phone, Loop 3 offers other routes: on Omnipod, the Manual Temp Basal setting; on Medtronic, switch to Open Loop and use the pump's own temp basal.

## What a Loop override changes [section "How Overrides Work"]

An override tells Loop that some settings are different for a while. It can change the correction range, the overall insulin needs, or both; an insulin needs change scales basal schedule, ISF and CR together. LoopDocs gives hormone cycles, steroid medicines and exercise as examples. Override presets are optional and are made and switched on or off from the workout icon, the small blue heart in the Loop toolbar.

## Features and rules of a Loop override [section "Features of an Override"]

An override sets an overall insulin needs adjustment, a correction target range, a duration in 15-minute steps (or indefinite) and a start time. It only works while the Loop gear is with the user: if Loop sets a zero temp basal because of an override and the gear is left behind, the pump goes back to scheduled delivery after half an hour.

- **Target range:** if blank, the scheduled correction range stays in force; if filled, it replaces the scheduled range for the override.
- **Overall insulin needs at 100%:** no change to basal, ISF or CR.
- **Below 100%:** tells Loop the person is more sensitive; Loop uses lower basal rates and higher ISF and CR numbers.
- **Above 100%:** tells Loop the person is less sensitive; Loop uses higher basal rates and lower ISF and CR numbers.
- While active, the adjusted values apply to every automatic and manual dose and to the future IOB calculation. Carbs and insulin entered during the override keep the override's ISF and CR for their whole absorption time or action duration.
- To be accepted, an override must change insulin needs or target range (or both). A named override (needs a name and an icon) can be saved, reused and scheduled; a Custom override is one-off. Any override can be edited while running.

## Future (scheduled) overrides act early [section "Future Override"]

A Loop override scheduled for later can affect dosing before it starts. Because each cycle plans dosing over the 6-hour insulin action time, a higher future target is already included in the calculation. LoopDocs' example: at 10 pm an override with a higher target is scheduled for 6 am; around midnight Loop starts taking that target into account, so glucose should be near the higher range on waking. The insulin needs change of that override, however, does not affect the prediction until the override actually starts.

## Overrides stop when Loop stops [section "How Overrides Do NOT Work"]

Override adjustments live only in the Loop app; they are never written to the Medtronic pump or the Omnipod. If Loop stops working (phone or RileyLink out of reach, glucose data stale), the current temp basal runs out the rest of its 30 minutes and the pump returns to the scheduled basal from Therapy Settings; the override's reduced needs do not continue. LoopDocs' example: a 50% override does not keep basal halved during a long swim without the phone and RileyLink. For long reductions away from the gear, change the scheduled basal or use a Manual Temp Basal.

## Avoid extreme insulin needs such as 10% [section "Avoid Extreme Insulin Needs Setting"]

Some users pick 10% overall insulin needs. Unlike a 10% temp basal on a PDM, this makes Loop's basal, ISF and CR 10 times different. LoopDocs' scenario: carbs are entered during such an override and Loop suggests a tiny bolus.

- If the tiny bolus is accepted, glucose goes high (CR is effectively 10 times weaker) and stays high (ISF also 10 times weaker, automatic corrections and basal only 10% of normal).
- If instead the user boluses what the food really needs, glucose may be fine, but Loop forecasts a negative eventual glucose (only a prediction) and holds back all basal until the forecast recovers.

LoopDocs suggests raising the correction range with a moderate needs change instead; Loop then tends to cut delivery with temp basals from the next CGM reading. Loop 3 shows a warning on the meal entry screen when an override with insulin needs other than 100% is active, and the user decides whether to continue. To stop insulin at once, LoopDocs points to a Manual Temp Basal or a pump suspend; after suspending, heed the reminder to resume. Some athletes doing extreme or prolonged exercise do use such large changes knowingly.

## Creating a Loop override preset [section "Create an Override Preset" / "Select 1% Insulin Needs"]

Tap the workout (heart) icon, then + at the top right. Pick an emoji, give a name, and change insulin needs (default 100%, no change) and/or enter a target range (blank keeps the scheduled range); choose indefinite or a set duration and tap "Save". In Loop 3 insulin needs is not limited to the picker's 10% steps: press and hold the orange bar and slide to move in 1% steps.

## Activating and scheduling a Loop override [section "Activate an Override" / "Schedule an Override"]

Tap the heart icon and pick a saved preset, make a new one, or use the custom one-off override. While active, the heart sits in a blue square, the HUD status row shows the override name, and the glucose chart shows a darker blue bar for the override's target and duration. To start a saved override later, tap the calendar icon beside it, set "Start time" and tap "Enable". LoopDocs suggests scheduling an exercise override the night before a morning workout, so the person wakes with less insulin on board and already near the exercise target.

## Turning a Loop override off [section "Deactivating an Override"]

Tapping the heart icon ends the override immediately, with no confirmation, so LoopDocs suggests locking the phone while an override runs to avoid switching it off by accident. Overrides with a set duration end on their own. On the Apple Watch, saved overrides are switched on and off with the blue heart icon [section "Apple Watch"].

## Editing a running Loop override [section "Editing an Active Override"]

With the phone upright, tap the active override in the HUD status row to edit it. Changes apply only to this run and are not saved to the named preset; the duration, needs or target can be changed. Editing Overall Insulin Needs makes Loop recalculate some effects such as IOB over the override's duration; quitting and restarting the app recalculates all effects.

The edit is blocked while the HUD row shows a higher-priority message: a bolus starting, running or being cancelled, pump suspended, or no recent glucose. Cancelling an active bolus allows editing straight away; the edit takes effect from the next cycle or manual recommendation.

## Recalculating after a needs change [section "Recalculate When Needs Change"]

Editing the needs percent of a running override, and then quitting and restarting Loop, forces recalculation from the override's start; IOB can change at once, and the carb absorption (ICE) chart only changes after the restart. A user's example from LoopDocs: a cycling override at 65% is set longer than the ride; afterwards it is edited back to 100%, which typically doubles the negative IOB, then the override is ended and that negative IOB is given as a bolus to head off the after-exercise rise. With no carbs active, no restart is needed.

## Remote overrides via Nightscout [section "Remote Overrides"]

Loop override presets can also be turned on and off from Nightscout. This needs the remote setup described in LoopDocs and a paid Apple developer account, because it relies on the Apple Push Notification service.
