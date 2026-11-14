---
id: loopdocs-loop-3-medtronic
title: "LoopDocs: Medtronic pump settings in Loop 3: suspend/resume, insulin type, MySentry, devices, pump time and deleting the pump"
publisher: "LoopDocs (LoopKit)"
url: https://loopkit.github.io/loopdocs/loop-3/medtronic/
licence: "Own summary (Mellis); original: LoopDocs has no licence file: paraphrased with short quotes only"
licence_url: https://github.com/LoopKit/loopdocs
mode: SUMMARY_ONLY
language: en
retrieved: 2026-11-14
topics: [loop, pump, insulin, settings, aid]
index: true
---

*Our summary (Mellis knowledge base) of a LoopDocs page, written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/loop-3/medtronic/.*

# LoopDocs: Medtronic pump settings screen in Loop 3

## Opening the Medtronic Pump Settings screen in Loop [sections "Pump Settings", "Medtronic Status and Commands"]

Tap the pump icon in the Heads Up Display (HUD) or the connected pump in Loop Settings. The bottom rows (Pump ID, Firmware Version, Region) are set when the pump is connected and cannot be edited.

## Suspend Delivery and Resume Delivery for a Medtronic pump in Loop [section "Suspend Delivery"]

- `Suspend Delivery` stops all delivery: basal, temp basals and any running bolus. The row shows `Suspending` while Loop talks to the pump, then `Resume Delivery`; delivery stays off until resumed from the HUD Status Row, Pump Settings or the pump itself.
- If it fails, an alert ("Error Suspending" or "Failed to Resume Insulin Delivery") must be acknowledged and the command sent again; keep the RileyLink-type device (RileyLink, OrangeLink, EmaLink) on and close to phone and pump.
- In portrait view the Pump Status Icon shows the suspension, and the HUD Status Row message can be tapped to resume.
- Suspend/resume on the pump itself also works; Loop picks it up by the next cycle (typically under 5 minutes).
- A manual bolus from Loop while suspended also resumes basal. No automatic boluses run while suspended.

## Insulin Type for a Medtronic pump in Loop [section "Insulin Type"]

Chosen when the pump is connected. After installing Loop 3 over Loop 2 with the pump already set up, Insulin Type must be set here, otherwise red loops. All rapid-acting brands share one model (recording a brand change is still suggested); switching between rapid and ultra-rapid must be entered so Loop uses the right model.

## Pump battery, data source and MySentry for a Medtronic pump in Loop [sections "Pump Battery Type", "Preferred Data Source", "Use MySentry", "Pump Battery Remaining"]

- Pump Battery Type changes how Loop reads the battery and estimates `Pump Battery Remaining`.
- Leave Preferred Data Source on Event History.
- `Use MySentry` appears only on pumps that support it; MySentry with an OrangeLink drains batteries fast on some pumps, so it can be turned off here.

## Devices on the Medtronic Pump Settings screen in Loop [section "Devices"]

Opens the screen of each connected RileyLink-compatible device.

## Pump Time and time zone for a Medtronic pump in Loop [sections "Pump Time", "Change Time Zone"]

Loop keeps pump time matched to the phone automatically, but after a time-zone or daylight-saving change it lets the zones differ until you choose to change them. A yellow Pump Time row and a small clock on the pump status icon mean they differ. The row `Sync to Current Time` (below Pump Battery Remaining and Pump Time) sets the pump to the current phone time.

## Delete Pump for a Medtronic pump in Loop [section "Delete Pump"]

To switch pumps: turn off the RileyLink device slider(s) (no longer green), tap `Delete Pump`, confirm with `Delete Pump` again, then add the new pump.
