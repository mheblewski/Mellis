---
id: loopdocs-loop-3-rileylink
title: "LoopDocs: RileyLink screen in Loop 3: opening it, signal loss, connection status, Bluetooth signal strength and renaming the device"
publisher: "LoopDocs (LoopKit)"
url: https://loopkit.github.io/loopdocs/loop-3/rileylink/
licence: "Own summary (Mellis); original: LoopDocs has no licence file: paraphrased with short quotes only"
licence_url: https://github.com/LoopKit/loopdocs
mode: SUMMARY_ONLY
language: en
retrieved: 2026-11-14
topics: [loop, pump, aid, settings]
index: true
---

*Our summary (Mellis knowledge base) of a LoopDocs page, written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/loop-3/rileylink/.*

# LoopDocs: the RileyLink (OrangeLink, EmaLink) screen in Loop 3

## Opening the RileyLink screen in Loop [sections "RileyLink", "RileyLink Status and Commands"]

Open the pump screen (pump in Loop Settings or pump icon in the HUD), scroll to `DEVICES` and tap the device with a green slider. The status screen is titled with your device name, looks the same for every pump, and shows device-specific firmware.

## Signal loss on the RileyLink in Loop 3 [section "Signal Loss"]

If Loop cannot reach the device, its row shows old or missing data. In Loop 3 the Devices list shows a signal-loss icon instead of dB, and if it persists the Pump Status Icon on the main screen shows Signal Loss too. The fix is the red-loop communication reset.

## Connection Status and Signal Strength on the RileyLink screen in Loop [section "Device"]

- Connection Status should be `connected`. If `connecting` or `disconnected`, toggle iPhone Bluetooth and/or power-cycle the device.
- Signal Strength is the Bluetooth link to the iPhone, not the radio link to the pump or pod. It is negative dB (-50 dB is stronger than -80 dB) and changes live, which can help find a lost device nearby.

## Renaming a RileyLink, OrangeLink or EmaLink in Loop [section "Personalize Device"]

Rename the device from its default name right after first connecting: tap the Name row, enter a name, and wait a few seconds so it is stored in the device (going back too soon may lose it; repeat). The device must be on and connected.
