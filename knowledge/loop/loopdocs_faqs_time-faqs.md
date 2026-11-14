---
id: loopdocs-faqs-time-faqs
title: "LoopDocs: Time FAQs: Loop phone must stay on automatic time, locking it with Screen Time, removing future glucose, time zones and daylight saving, travel and airplane mode"
publisher: "LoopDocs (LoopKit)"
url: https://loopkit.github.io/loopdocs/faqs/time-faqs/
licence: "Own summary (Mellis); original: LoopDocs has no licence file: paraphrased with short quotes only"
licence_url: https://github.com/LoopKit/loopdocs
mode: SUMMARY_ONLY
language: en
retrieved: 2026-11-14
topics: [loop, aid, pump, cgm, insulin, children, education]
index: true
---

*Our summary (Mellis knowledge base) of a LoopDocs page, written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/faqs/time-faqs/.*

# LoopDocs: Time and time zones in Loop

## The Loop phone must be on automatic time [section "The Loop Phone Must be on Automatic Time"]

Loop calculates active insulin from phone time, so setting the clock by hand (for screen-time limits or games) can corrupt IOB and lead Loop to give insulin when much is already active. Loop detects this only when Automatic Time is off; it then stops all automatic dosing except scheduled basal and warns repeatedly. Some manual changes crash the app so it will not reopen.

## What can go wrong without automatic time [section "Not on Automatic Time"]

After a manual clock change, restoring the time and deleting wrong values in Apple Health sometimes fixes it; sometimes the app must be deleted and reinstalled, which means a new pod and re-entering all settings. LoopDocs' worst case: the clock was set back during a bolus, the bolus ended before it started, and the app crashed. Time zone changes when travelling are not the problem; automatic time handles them.

## Locking automatic time on the Loop iPhone [section "Force Automatic Time" / "Test the Configuration"]

In iOS Settings -> Screen Time, set a passcode under Lock Screen Time Settings; while it is set, only automatic time is allowed (time zones still update). Parents can use this on a child's phone. Check under Settings > General > Date & Time that "Set Automatically" is greyed out.

## Automatic time on family-managed phones [section "Automatic Time for Managed Phones" / "Troubleshooting"]

On a family-managed phone, also turn off Setting Time Zone under Settings > Screen Time > Content & Privacy Restrictions > Location Services > System Services, and set Location Services to "Don't Allow Changes"; then test. If the time can still be changed, switch Content and Privacy Restrictions or Screen Time off and on. Different iOS versions on parent and child phones can break this; update both.

## Removing future glucose values for Loop [section "Remove Future Glucose"]

Glucose stamped in the future must be deleted in Apple Health, because Loop stops looping when it sees it: red loop within 15 minutes, "not Looping" notifications from 20 minutes, a bolus-screen message about invalid future glucose, and a CGM app showing a different value from Loop. If Loop uploads to Nightscout, also remove future entries and treatments with Nightscout Admin Tools.

## Loop's time change warning [section "Loop Warning about Time Change"]

Loop alerts loudly, even inside other apps, when automatic time is off and the clock is changed; at least one future reading may already exist and should be removed. Time zone changes are safe, since Loop stores records in UTC.

## Loop, time zones and daylight saving time [section "Time Zones, Daylight Savings Time, Summer Time"]

The phone updates its clock itself, but the user chooses when Loop's "pump time" zone changes. Pump time drives the basal, CR, ISF and correction range schedules. Change it in Pump Settings (tap the HUD pump icon, or Loop -> Settings -> Pump). On short trips many leave it unchanged; after a daylight saving change most update it right away. A clock icon on the HUD pump status shows the zones differ. Medtronic users must not change the clock from the pump's own menus while Looping.

## Loop iPhone time setting [section "iPhone"]

Loop warns if iOS Settings -> General -> Time & Date is not automatic. Everyone using the phone should know it is a critical medical device and the time must never be set by hand.

## Loop with Minimed pumps and Dexcom CGM [section "Minimed Pump and CGM" / "Dexcom CGM"]

A Minimed pump has no time zone, so Loop assumes a fixed offset from UTC, saved when the pump is first set and at each Change Time Zone. Dexcom times are UTC and need nothing; receiver users may set the receiver clock for display only.

## Travel: airports and airplane mode with Loop [section "Airports" / "Airplane Mode"]

RileyLinks, pumps and CGMs can go through airport security, X-ray and the cabin. Before a trip, switch airplane mode on, make sure Bluetooth is still on (turn it on if not), then switch it off; the phone remembers Bluetooth for next time, so CGM and Loop keep working in flight.
