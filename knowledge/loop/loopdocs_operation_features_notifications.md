---
id: loopdocs-operation-features-notifications
title: "LoopDocs: Loop notifications: Unable to Reach Pump, app expiration, Omnipod beeps, iPhone settings, Loop failure, bolus failure, reservoir and battery alerts, remote following"
publisher: "LoopDocs (LoopKit)"
url: https://loopkit.github.io/loopdocs/operation/features/notifications/
licence: "Own summary (Mellis); original: LoopDocs has no licence file: paraphrased with short quotes only"
licence_url: https://github.com/LoopKit/loopdocs
mode: SUMMARY_ONLY
language: en
retrieved: 2026-11-14
topics: [loop, aid, pump, children, education]
index: true
---

*Our summary (Mellis knowledge base) of a LoopDocs page, written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/operation/features/notifications/.*

# LoopDocs: Loop notifications and alerts

## Loop notifications in general [section "Loop Notifications"]

Loop's notifications appear on the iPhone and Apple Watch lock screen and vibrate, as set in the phone's notification settings for Loop.

## Loop alert: Unable to Reach Pump [section "Loop Alert - Unable to Reach Pump"]

New in Loop 3: if pump communication breaks at a critical moment, Loop cannot trust its IOB and halts everything behind this modal until communication returns. **Learn More** offers only two choices: go Back and keep waiting, or discard the pump or pod, which marks the last command as uncertain and allows adding a new pod, a new Medtronic pump or another insulin device. Discard only after bringing phone and pump close, waiting a few minutes and trying the Reset Loop-to-Pump Communications steps.

## Loop app expiration notice [section "Loop App Expiration Notification"]

The app's expiry date is at the bottom of Loop's Settings screen. With fewer than 20 days left Loop alerts on opening, at most every 2 days; with fewer than 24 hours left, at most hourly. **More Info** links to rebuild instructions. Available from version 2.2.5 (Mac builds) and 3.3 (browser builds); free 7-day builds follow the same pattern.

## Loop and Omnipod beeps [section "Omnipod Beeps"]

Loop silences most pod beeps. The ones kept (some configurable in Omnipod Notification Settings): pod filled enough during pairing; expiration advisory (48-72 hours); low reservoir; deactivation; and the fault alarm ("screamer") at the 80-hour maximum pod life, when out of insulin, or on a fault or occlusion. After reporting 0 U the pod keeps delivering until empty or 4 U more, whichever comes first. Silence a screamer with Deactivate Pod; if pod communication is lost for good, discard it in Loop and silence it by hand.

## iPhone notification settings for Loop [section "Notification settings for Loop"]

In iPhone Settings for Loop 3, LoopDocs advises turning on **Immediate Delivery** and **Time Sensitive Notifications**. Notification Delivery shows only if Scheduled Summary was enabled; Announce Notifications only if Siri announcements were enabled. In every Focus mode, allow Loop and turn on Time Sensitive Notifications.

## Taking a break from Loop [section "Taking a Loop Break"]

When pausing Loop with the app still installed (or testing with a simulated pump), turn Loop notifications off, or Loop Failure messages keep coming. On return the main screen reminds you to turn them back on.

## Loop Failure and Bolus Failure notifications [section "Loop Failure" / "Bolus Failure"]

Loop Failure notifications come at 20, 40, 60 and 120 minutes without a completed loop, usually after a long loss of connection to the CGM or RileyLink. Bolus Failure notifications come when a bolus could not be delivered or was only partly delivered, usually because of stale pump data (fetching recent history from the RileyLink menu can help). Carbs saved with the meal stay saved even if the bolus fails.

## Loop reservoir and battery alerts [section "Low Reservoir" / "Empty Reservoir" / "Low Battery (Medtronic)"]

- Medtronic: low reservoir at 20 % and 10 % remaining; low battery with about 8-10 hours left.
- Omnipod: the user sets the low reservoir level.
- Empty: Loop 2 sends a notification; Loop 3 shows No Insulin on the HUD pump icon.
- Omnipod after 0 U: the pod alarms and must be changed after 4 U more, or sooner if it runs dry, and then reports out of insulin.

## Remote alerts for caregivers [section "Remote Notifications" / "LoopFollow"]

Loop sends no notifications to other devices. Remote parents are pointed to Pushover alerts via Nightscout, or to LoopFollow, an app written by a Looper's parent for remote viewing and extra wake-up alarms from several data sources.
