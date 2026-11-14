---
id: loopdocs-troubleshooting-red-loop
title: "LoopDocs: Red loop troubleshooting: what a red Loop icon means, resetting pump/RileyLink communication, CGM, Apple Health, background refresh, Nightscout, storage, Medtronic fixes"
publisher: "LoopDocs (LoopKit)"
url: https://loopkit.github.io/loopdocs/troubleshooting/red-loop/
licence: "Own summary (Mellis); original: LoopDocs has no licence file: paraphrased with short quotes only"
licence_url: https://github.com/LoopKit/loopdocs
mode: SUMMARY_ONLY
language: en
retrieved: 2026-11-14
topics: [loop, aid, pump, cgm, education]
index: true
---

*Our summary (Mellis knowledge base) of a LoopDocs page, written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/troubleshooting/red-loop/.*

# LoopDocs: troubleshooting a red Loop icon

## What a red Loop icon means [section "Red Loop Overview"]

- Red means Loop has not completed a cycle for 15 minutes or more, usually a communication breakdown.
- Tapping the Loop icon shows the last completed time; the Pump Status Icon and Glucose Status Icon say more. Glucose older than 15 minutes shows "- - -"; pump communication trouble shows a No Signal icon.
- Omnipod: do not pull a pod for a red loop; the cause is usually Bluetooth/RileyLink, which a new pod will not fix.
- Medtronic: after updating Loop 2 to Loop 3 and onboarding, select Insulin Type on the pump settings screen; without it closed loop does not work.

## Typical causes of a red loop [sections "Typical Causes for Red Loop", "Lost Pod Information"]

Loop-to-pump communication, CGM, Apple Health, Background App Refresh off (phone, Loop and/or CGM app), Nightscout, full phone storage, lost pod information. Some keep Loop red until fixed; others cause on-and-off red loops. Lost pod/CGM information after a phone reboot affected Loop before 3.0 (and iAPS; fixed in Trio); with Loop 3.x reboots are not a worry.

## Resetting Loop-to-pump communication (Bluetooth and RileyLink) [section "Reset Loop-to-Pump Communications"]

For messages like "pump history is too old", "no rileylink could be found", "pod cannot be reached" or `Unable to Reach Pump`. DASH uses Bluetooth only; Eros and Medtronic use Bluetooth plus the RileyLink-type device. Try in order:

1. Phone Bluetooth off and on.
2. Close Loop (swipe up in the app switcher) and reopen.
3. Eros/Medtronic: switch the RileyLink off and on with its side switch (a paperclip reaches the recessed switch; know how to power-cycle OrangeLink/EmaLink).

Green should return within 5 minutes. To test sooner, Medtronic users can suspend/resume the pump (Omnipod: Play Beeps). Last resort: restart the phone (last only because of an old pre-Loop-3 issue).

## CGM values not reaching Loop: transmitter ID and Dexcom Share [section "CGM Values Are Not Being Collected by Loop"]

After a transmitter change: Loop settings, CGM, `Delete CGM` (bottom), then `Add CGM` with the new ID. With Share credentials left in Loop and an old ID, errors like `Failed to decode SGV` appear when Share is unreachable. LoopDocs recommends deleting Share credentials (row reads `Tap to Set`): local transmitter reading is preferred, missing data then reminds you to update the ID, and Loop does not become internet-dependent.

## Apple Health [section "Apple Health"]

Loop and the Dexcom app both need write permission to Apple Health. A very slow or unresponsive Health app may mean a corrupted database (seen in early iOS 14) that must be cleared; switch to Open Loop meanwhile and get help.

## Background App Refresh, Screen Time and Focus for Loop [section "Background App Refresh"]

Without Background App Refresh Loop tends to stop when the phone locks: Phone Settings -> General -> Background App Refresh, on, with Loop's (and the CGM app's) slider on. From iOS 15 add Dexcom and Loop to Screen Time -> Always Allowed. With Focus modes (iOS 15-17) allow Loop notifications in Sleep, Personal and Do Not Disturb.

## Nightscout and full phone storage [sections "Nightscout", "Phone Storage is Full"]

- Loop buffers Nightscout uploads during outages, but a large backlog can slow Loop and turn it red. Check internet, check the Nightscout database is not full (add `dbsize` to ENABLE; clean a free DIY site once or twice a year), and test by removing the Nightscout URL from Loop.
- Nearly full phone storage gave `Sqlite Error: A Sqlite Error Occurred: (13) Database or Disk is Full` in Loop (Dexcom G6 app said to reinstall). Fix: free space.

## Medtronic pump not responding [section "Pump is Not Responding"]

First make sure phone and RileyLink-type device are close enough to the pump. (Omnipod: a screaming pod can still talk; the reset steps almost always work.) For Medtronic "decoding" or other pump-response errors:

1. Change the pump battery; low battery makes radio fail.
2. Use `Change Time` in Loop's pump menu to resync the pump clock if it was changed on the pump or drifted.
3. x23/x54 pumps: delete all IDs under "Other Devices" in the pump's "Connect Devices" menu, then run the MySentry pairing command in the RileyLink menu for a fresh ID; this can stop recurring red loops, especially after a Loop update.
4. On the pump: not suspended (resume), and temp basal type in the Basal menu set to units/hour, not percent.

## Frequent red loops [section "Resolving Frequent Red Loops"]

- Test without Nightscout in Loop; if it helps, fix the site (usually database cleanup).
- Reseat the RileyLink battery plug; charge it an hour or two (red light on), try another charger or cable.
- Some found turning off Siri integration for Loop and Dexcom helped (maybe coincidence).
- Look for wireless interference: many Medtronic Loopers in one room cause "cross-talk"; move routers or baby monitors away from the sleeping area.
- Rarely, clean Apple Health or factory-reset the phone and rebuild Loop; ask for help first.

## Posting for help [section "Posting for Help"]

Reset RileyLink and phone and check Nightscout database size first. Post two screenshots of Loop's main screen (with the red-loop message and plain) and list what you tried (e.g. transmitter ID checked, Share removed).

## Broken RileyLink, failed battery, OrangeLink FW 2.6 [section "What Else?"]

- RileyLink lights: red = charging; green = Bluetooth to phone, should stay on; blue = flashes during pump talk, must not be always on. Stuck blue suggests board damage or debris: clean with rubbing alcohol with the battery unplugged; otherwise contact GetRileyLink or replace.
- RileyLink/EmaLink LiPo batteries that hold charge for less time or swell (case bowing) must be replaced; OrangeLink uses ordinary batteries.
- OrangeLink or OrangeLink Pro on FW 2.6: upgrade to FW 3.2 as soon as possible.
