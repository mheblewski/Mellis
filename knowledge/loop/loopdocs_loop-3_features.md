---
id: loopdocs-loop-3-features
title: "LoopDocs: Features new with Loop 3: remote carbs/bolus, non-pump insulin, GBPA and IRC experiments, Favorite Foods, Live Activity"
publisher: "LoopDocs (LoopKit)"
url: https://loopkit.github.io/loopdocs/loop-3/features/
licence: "Own summary (Mellis); original: LoopDocs has no licence file: paraphrased with short quotes only"
licence_url: https://github.com/LoopKit/loopdocs
mode: SUMMARY_ONLY
language: en
retrieved: 2026-11-14
topics: [loop, aid, smb, insulin, settings, children, hypoglycaemia, nutrition]
index: true
---

*Our summary (Mellis knowledge base) of a LoopDocs page, written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/loop-3/features/.*

# LoopDocs: features new with Loop 3 (up to 3.10)

## Remote carbs and remote bolus in Loop 3 [section "Remote Carb / Bolus"]

Loop 3 lets a caregiver send carbs and boluses to the Loop phone remotely, in two ways: through the LoopFollow app, or through LoopCaregiver or Nightscout. The remote features were first built together with LoopCaregiver, with matching Nightscout changes; LoopFollow later added its own code that sends Apple push notifications straight to the Loop app.

LoopDocs warns that remote control is used at one's own risk and that the setup pages must be read carefully. Remote commands travel as Apple push notifications, which Apple limits per device: if too many are sent, iOS may start throttling them. There is no published limit, but LoopDocs suggests keeping to about 1 or 2 per hour, and cellular data may add further limits. These limits affect LoopFollow, LoopCaregiver and the Nightscout `careportal` alike.

## Remote control with LoopFollow [section "Remote Control with LoopFollow"]

LoopFollow is popular with caregivers for its overview screen and flexible alarms. It runs only on Apple devices (iPhone, iPad, Mac). Several caregivers can each have a copy on their own device and share the job, so LoopDocs asks users to be careful with it. Details are in LoopFollowDocs.

## Remote control with LoopCaregiver or Nightscout [section "Remote Control with LoopCaregiver or Nightscout"]

Loop 3's Remote Carb and Remote Bolus through LoopCaregiver or Nightscout need the Loop user to have a Nightscout site. LoopDocs covers overview, configuration, commands, errors and the LoopCaregiver app on separate pages.

## Remote control for more than one person [section "Remote Control of More than One Person"]

The same Apple push notification credentials can serve several Loop users, but each person needs their own Nightscout URL. In LoopFollow each person gets a separate app copy that can carry their name and icon; in LoopCaregiver all people are in one app and the caregiver switches between them.

## Non-pump insulin in Loop 3 [section "Non-Pump Insulin"]

Insulin given outside the pump (for example a pen injection) can be told to Loop. In Loop 2.2.x this was done by typing the dose into Apple Health for Loop to import; that still works in Loop 3, but Loop 3 adds its own entry screen where the insulin type can be chosen so the right insulin model is used, and an updated glucose prediction is shown before saving.

## Enter non-pump insulin before carbs [section "Enter non-pump insulin before carbs"]

If a pen dose is meant to cover a meal and Loop should not start adding insulin for the carb entry, LoopDocs warns to log the non-pump insulin first and the carbs second. To see what Loop would recommend without dosing through it: wait for a fresh CGM (or fingerstick) value, enter the carbs and go on to the bolus screen without saving, note the recommendation, go back and `Cancel`; then log the chosen pen dose (with the insulin model if it differs from the pump's), actually inject it, and finally save the carbs without bolusing.

How to log it:

- Tap either insulin chart (Active Insulin or Insulin Delivery) on the main screen to open the Insulin Delivery screen, which has three tabs: Event History (pump delivery events, not including returns to scheduled basal), Reservoir (pump-reported level; pods only report once they are at 50 U or less, and old pod levels can show after a change) and Non-Pump Insulin.
- In Non-Pump Insulin tap +, which opens `Log Dose` with the current prediction. The insulin type defaults to the pump's; tapping it allows other types, some of which (such as Afrezza) exist only for non-pump entries.
- Tap the `Bolus` row and type the dose; the prediction updates as you type. LoopDocs' tip: add 0.001 to the dose so it is easy to spot in Apple Health. After `Done`, the `Log Dose` button turns blue; tap it to save, or `Cancel`.

## Algorithm Experiments in Loop 3.4 [section "Algorithm Experiments"]

Loop 3.4.0 added two optional algorithm experiments, shown in Loop Settings under Therapy Settings and Usage Data Sharing: Glucose Based Partial Application (GBPA) and Integral Retrospective Correction (IRC).

## Glucose Based Partial Application (GBPA) [section "Glucose Based Partial Application (GBPA)"]

GBPA works only when the Dosing Strategy is Automatic Bolus, and it does not change the recommended dose, only how fast Loop delivers it. It replaces an older customization (the "switcher" patch from CustomTypeOne LoopPatches, which moved between Automatic Bolus at high glucose and Temp Basal Only at low glucose using a threshold set outside the app); that patch is no longer compatible.

Without GBPA, Automatic Bolus gives a fixed 40% of the recommended dose each cycle. With GBPA the share depends on glucose:

- 20% when glucose is at or below the lower end of the correction range (including an override's range) plus 10 mg/dL (0.6 mmol/L);
- rising linearly from 20% to 80% up to 200 mg/dL (11.1 mmol/L);
- 80% above 200 mg/dL (11.1 mmol/L).

## How fast GBPA delivers a dose [section "Insulin Delivery Using GBPA"]

LoopDocs illustrates with a simplified case: Loop recommends 1 U, glucose then follows the prediction, and the pump's smallest bolus step is 0.05 U, so over half an hour Loop should add about 1 U above scheduled basal. Higher application factors start with bigger boluses and finish sooner. In the example, an 80% factor gives 0.80 U at once and reaches the full 1 U by 10 minutes; 60% reaches 1 U by 15 minutes (helped by rounding tiny doses up to 0.05 U); 40% gets to 0.95 U by about 20 minutes; 20% has given about 0.80 U after 30 minutes. The 20% and 40% cases stop short of 1 U because the remaining amount is below what the pump can deliver.

With Temp Basal Only, Loop gives roughly 17% of the recommended bolus per 5-minute interval; GBPA's 20% minimum was picked to be close to that at lower glucose. 20% is faster at first, but by 30 minutes the pump's temp basal program has delivered the whole 1 U in this example.

## Integral Retrospective Correction (IRC) [section "Integral Retrospective Correction (IRC)"]

IRC changes Loop's prediction model, so it can change the recommended dose, and it applies with both Temp Basal Only and Automatic Bolus. Normally (IRC off, the default) Loop's forecast combines insulin effect, carb effect, retrospective correction and momentum; with IRC on, the retrospective correction term is replaced by an integral retrospective correction that looks at longer-lasting gaps between predicted and actual glucose. Momentum does not simply add on top; its role is more complex. With IRC on, the Retrospective Correction part of the Predicted Glucose Chart also shows an `Integral effect`, the difference between IRC and standard RC.

## IRC: risks, where it helps, how to judge it [section "Important points about IRC"]

- **Risks:** with IRC on, Loop will likely increase corrections when glucose keeps differing from the forecast, which can raise the risk of hypoglycaemia, and it can cause more glucose swings ("roller-coaster"). Both risks are higher if ISF is set too low; raising ISF tends to reduce them, without guarantees.
- **Where IRC tends to help more than standard RC:** glucose staying high or falling more slowly than expected (temporary resistance, poor site absorption); glucose dropping faster than expected (temporarily higher sensitivity); spikes from unannounced meals; long meal tails when carbs were under- or over-estimated; lasting rises from unannounced protein and fat; glucose sitting above or below range because basal is set too low or too high.
- **Where it makes no difference:** while announced carbs are absorbing faster than the minimum absorption rate, neither RC nor IRC adds to the forecast, whatever the glucose. Neither depends on the glucose level itself, only on the gap between forecast and reality.
- **Judging it:** LoopDocs says not to expect quick or large improvements and that one good day proves nothing. Signs IRC may be safe and useful: somewhat lower spikes after unannounced meals without lows afterwards, and over a few weeks fewer night highs and lows, with wake-up glucose closer to the correction range.

## Favorite Foods [section "Favorite Foods"]

Loop's Favorite Foods saves meal entries for reuse. They are created and edited in a Favorite Foods row in Loop Settings. During a carb entry, tap the Favorite Food row at the bottom, pick a saved food, adjust the time or other rows if needed, and tap Continue. Saving a favorite from the Carb Entry screen requires choosing a specific food emoji via the plate icon; the top-level Lollipop, Taco and Pizza icons alone do not enable Save as Favorite.

## Live Activity (Loop 3.10.0) [section "Live Activity"]

Live Activity, long used as a customization, became part of Loop in version 3.10.0. People who built with the `live_activity` customization must remove it from their customization list or the build fails.

**Requirements:** the Dynamic Island needs an iPhone 14 Pro or newer; the Lock Screen Live Activity works on older phones with iOS 16 or later; the Apple Watch Smart Stack needs iOS 18 and watchOS 10 or later; CarPlay needs iOS 26 or later. On phones with a Dynamic Island, enabling Live Activity also enables the Island; there is no separate switch.

**Turning it on:** in Loop, Settings, Notifications, Live Activity, and also in the iPhone's settings under Loop, Live Activities, enabling both Allow Live Activities and More Frequent Updates. Then lock the screen. If it does not appear, quit and restart Loop; after a phone reboot Loop may need opening first, or Live Activity may need switching off and on.

## Configuring the Loop Live Activity [section "Configure Live Activity"]

For the Lock Screen (and CarPlay where supported) the user can choose Large mode (with a chart) or Small `Mode`, show or hide the prediction line in Large mode, set the glucose values that count as high and low, and choose single-colour glucose (Loop blue) or `Use BG coloring` with different colours per level. The `Bottom row configuration` sets the items in the bottom row: at most 4 at once. Remove items with the minus sign, reorder by dragging, and tap plus (active only with 3 or fewer selected) to add; touching items adds them, and reaching 4 returns to the previous screen automatically.
