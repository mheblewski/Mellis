---
id: loopdocs-faqs-cgm-faqs
title: "LoopDocs: CGM FAQs: supported CGMs (Dexcom, Libre, Eversense, remote), warm-up and stale glucose, G7 15-day and sensor overlap, transmitter change, Libre connection and LibreLinkUp"
publisher: "LoopDocs (LoopKit)"
url: https://loopkit.github.io/loopdocs/faqs/cgm-faqs/
licence: "Own summary (Mellis); original: LoopDocs has no licence file: paraphrased with short quotes only"
licence_url: https://github.com/LoopKit/loopdocs
mode: SUMMARY_ONLY
language: en
retrieved: 2026-11-14
topics: [loop, cgm, aid]
index: true
---

*Our summary (Mellis knowledge base) of a LoopDocs page, written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/faqs/cgm-faqs/.*

# LoopDocs: CGM questions for Loop

## CGMs supported by Loop [section "Which CGMs are supported by the Loop app?"]

- All Dexcom CGMs from Loop v3, including the 15-day G7.
- EU Libre 2/2+ from Loop 3.4; Libre 3/3+ only in the experimental next-dev branch.
- Eversense E3 and 365 from Loop v3.14.2.
- Remote CGM, which needs internet: Dexcom Share, or Nightscout as CGM.

## Starting Loop mid-sensor (Dexcom) [section "Do I need wait for a new Dexcom sensor session to start Loop?"]

No need to wait for a new sensor; Loop can start or stop mid-session.

## Dexcom warm-up and no recent glucose in Loop [section "What do I do when Dexcom sensor is in warm-up?"]

When the newest glucose is older than 15 minutes, Loop stops automatic adjustments; the HUD shows three dashes and the status row `No Recent Glucose`, which makes it easy to enter a fingerstick in Loop (also saved to Apple Health). The pump returns to scheduled basal within 30 minutes or less. Carb entries, manual boluses and a Manual Temp Basal still work.

## Dexcom G7 15-day support and G7 warm-up overlap [sections "Is the 15-day Dexcom G7 Supported?", "Dexcom G7 Warmup"]

- 15-day G7 support came with Loop v3.10.0 (January 2026).
- G7 (and ONE+) warms up from insertion in under half an hour. Many Loopers combine this with the G7's 12-hour grace period to avoid a gap: during the grace period insert the next sensor without connecting it to the G7 app on the Loop phone; after it settles, stop the old one and connect the new one. The G7 app then shows both traces (around 9 hours of settling in LoopDocs' example), and the overlap helps judge how far to trust the new sensor.

## Changing Dexcom transmitters in Loop (G5, G6, ONE) and G7 [sections "What do I do when I switch Dexcom transmitters?", "Dexcom G7", "Dexcom G5, G6 and ONE"]

- Before G7, a new transmitter (typically every three months) needs Loop updated: tap `Delete CGM` at the bottom of the CGM page (the ID line cannot be edited), optionally remove the old Dexcom transmitter in iPhone Bluetooth settings (`Forget This Device`), pair the new transmitter in the Dexcom app, then in Loop add the Dexcom CGM again with the new ID. Order in LoopDocs' diagram: Delete CGM in Loop, stop the old sensor, swap hardware, enter the new transmitter ID and sensor code in Dexcom, start the sensor, then Add CGM in Loop with the new transmitter serial number and enable Remote Upload.
- If the ID is not updated and Share credentials are stored, Loop silently uses Dexcom Share servers and needs internet; a small cloud above the glucose value shows this. LoopDocs advises not entering Share credentials.
- With G7, Loop picks up the active sensor from the G7 app automatically; nothing to change in Loop at sensor change.

## Libre connection problems with Loop [section "Troubleshoot Connections"]

- EU Libre 2 sensors reconnect slowly after losing the iOS connection. Keeping the app open in the foreground with the phone unlocked helps (Auto-Lock is under Display & Brightness).
- Repeated pairing attempts within minutes can make a sensor temporarily stop working, because pairing moves 16 times more data than a normal scan; stop, and if needed switch the phone off for up to five minutes.
- MiaoMiao or Bubble transmitters on top of EU Libre 2/2+ work without these connection problems (LibreTransmitter supports them on Libre 1 and also Libre 2).

## Libre readers, Libre 3 and LibreLinkUp with Loop [sections "Can I use Libre sensors with a reader like Miao Miao?", "What about other Libre sensors?"]

- Loop 3.4.x and later supports the Libre sensors handled by LibreTransmitter.
- Libre 3/3+ is only in the next-dev test branch.
- Some Libre sensors can only be read digitally through the maker's LibreLinkUp servers, which needs WiFi or cell internet. Options: a xDrip4iOS client customization (it notices when the sensor transmits and then fetches the value from LibreLinkUp), or Nightscout reading LibreLinkUp and used as CGM in Loop. Nightscout as CGM does not wake Loop when the phone is locked; usually the pump does that, otherwise consider the customization.

## Eversense and Nightscout as CGM in Loop [sections "Can I use Eversense E3 or Eversense 365?", "Can the Loop app read CGM data from Nightscout?"]

Eversense is built in from Loop 3.14.2. Loop can read CGM data from Nightscout.

## CGM customization (xDrip4iOS) [section "CGM Customization"]

A direct CGM connection to Loop is preferred. xDrip4iOS can be added as a CGM client by code customization (shared AppGroup), or used as a follower without customizing Loop. For Libre sensors that LibreTransmitter cannot read because of encryption, this is the only closed-loop option, and it makes closed loop depend on internet access. xDrip4iOS must be built with the same developer ID as Loop (not TestFlight pre-builds).
