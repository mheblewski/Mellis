---
id: loopdocs-faqs-rileylink-faqs
title: "LoopDocs: RileyLink FAQs: when a RileyLink-type device is needed, adding or switching devices, range, losing contact, firmware (OrangeLink), lights, charging and battery"
publisher: "LoopDocs (LoopKit)"
url: https://loopkit.github.io/loopdocs/faqs/rileylink-faqs/
licence: "Own summary (Mellis); original: LoopDocs has no licence file: paraphrased with short quotes only"
licence_url: https://github.com/LoopKit/loopdocs
mode: SUMMARY_ONLY
language: en
retrieved: 2026-11-14
topics: [loop, pump, aid, education]
index: true
---

*Our summary (Mellis knowledge base) of a LoopDocs page, written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/faqs/rileylink-faqs/.*

# LoopDocs: RileyLink-compatible device FAQs (RileyLink, OrangeLink, EmaLink)

## When Loop needs a RileyLink-compatible device [section "RileyLink Compatible Device FAQs"]

Needed for Medtronic pumps and Omnipod Eros, not for Omnipod DASH. It talks to the pump by radio and to the iPhone by Bluetooth, so it must stay in range of both: carry it in a pocket, bag or belt and always take it along.

## Adding or changing the RileyLink device in Loop [section "Adding or Changing RileyLink"]

The device can be swapped without affecting the connected pump (a new Medtronic pump or a switch between Medtronic and Omnipod uses Change Pump Type instead). Open the pump menu, scroll to DEVICES, switch the new device on and wait for it to appear; a never-connected device may show as a blank line with a slider, which you turn green to reveal the name. Use the sliders to pick the active device.

## Using more than one RileyLink device with Loop [section "Using More Than One Device"]

Several devices can be connected; Loop uses one at a time and switches at the next cycle to whichever is in Bluetooth range (e.g. one in the bedroom, one in the kitchen). Keep all charged, keep the phone close enough for CGM data, and take one device when leaving home.

## Bluetooth, Signal Strength and range of RileyLink devices with Loop [sections "Communications", "Range"]

- iPhone Bluetooth problems cause Loop failures; Bluetooth audio devices (car, home speakers) have been reported to interfere.
- `Signal Strength` (Loop settings, pump, device menu) is Bluetooth device-to-phone only, negative dB; -50 dB beats -80 dB.
- Range depends on place and device; OrangeLink and some EmaLink sizes reach farther than RileyLink (typically 10 to 20 ft) but must still be near. The body blocks signal (it is mostly water; e.g. sleeping on a pod), and crowded wireless places (concerts, conferences, arenas) interfere. Many keep it on the pump's side of the body; avoid RFID-blocking bags.

## What happens when Loop loses contact with the RileyLink [section "What happens if Loop loses communication?"]

A running temp basal continues to its end; Loop's temp basals last at most 30 minutes, so the pump is back on scheduled basal within 30 minutes. Back in range, Loop resumes by itself within 5-10 minutes.

## Waterproofing [section "Are these devices waterproof?"]

The electronics are not waterproof; waterproof cases exist (some with wireless charging).

## Checking RileyLink firmware in Loop [section "Firmware version"]

Loop settings, tap the pump, tap the device. A RileyLink should show at least `subg_rfspy 2.2/ble_rfspy 2.0` (pre-August-2018 units may be lower). subg_rfspy is the radio firmware to the pump (missing: device reaches the phone but not the pump); ble_rfspy is Bluetooth to the phone (not working: device does not appear in the list). Note the values when all works; with red loops, check that both items show after a power cycle. If not, fully quit Loop, power-cycle the device, reopen Loop, repeat several times; then contact the maker.

## OrangeLink firmware versions and Loop [section "OrangeLink Firmware"]

- Updatable from a phone app (iPhone 7 and later).
- FW2.6 (shipped on some OrangeLink Pro units and offered as download) worked badly with Loop and AndroidAPS. With communication problems update to FW3.2. Otherwise optional: OrangeLink (hardware 1.0) is fine on FW2.5 or FW3.2; OrangeLink Pro (hardware 1.1) on FW1.0 or FW3.2. Newer versions may exist.
- On FW 1.x/2.x the hardware version may display oddly in Loop; harmless, fixed in 3.x. Loop 3 is compatible with OrangeLink.

## RileyLink assembly and battery cable [sections "RileyLink Information", "RileyLink Assembly"]

The rest of the page covers the original RileyLink. It arrives with the LiPo battery unplugged. The plug needs a firm push to seat fully; a loose cable makes communication fail. The two most common new-owner errors are a not-fully-seated battery cable and not charging the device.

## RileyLink lights [section "RileyLink Lights"]

- No power light: flick the slide switch off/on; flashing lights in the board middle mean power.
- Red = charging (off when full, brief top-offs later). Green = Bluetooth link to the iPhone, should stay on; if not, restart iPhone Bluetooth and/or the RileyLink. Blue = pump communication (older firmware flashes; Medtronic users with firmware shipped since late August 2018 see more with "Enabled Diagnostic LEDs").
- Solid blue that stays on: a temporary fault fixed by off/on, or a short/damage, most often from sweat and moisture (do not carry it against skin, e.g. in a sports bra or waistband, while exercising). Still solid after restart: use the backup.

## RileyLink charging and run time [sections "RileyLink Charging", "How long will my RileyLink go between charging?", "How can I tell how much charge my RileyLink has?"]

Not fully charged on arrival. Charging takes about 1-2 hours (red light off); a charge lasts about 30-36 hours depending on battery health. It stops charging when full, so overnight charging is the norm. There is no charge indicator in Loop or Nightscout. A portable USB battery and a short mini-USB cable help if you forget.

## Antenna types: Medtronic vs Omnipod RileyLink [sections "What are the differences between the RileyLink Medtronic and Omnipod Antennas?", "What will happen if your RileyLink has the wrong antenna?"]

Each RileyLink has an antenna tuned for one pump type. OrangeLink has both and works with Medtronic or Omnipod; EmaLink needs the pump type chosen. A wrong-antenna RileyLink works only within inches in clear line of sight, with many red loops; at most an emergency backup.

## RileyLink battery life, swelling and antenna solder [sections "How long will my RileyLink battery last?", "RileyLink Battery", "RileyLink Battery Removal"]

- Replace the LiPo battery when it no longer lasts a day; many get over 2 years.
- A swollen battery should go out of the home to a fire-safe place and be recycled. Damaged or punctured LiPo batteries are unsafe; disconnect at once. The case protects it.
- After about a year of drops the antenna solder may loosen and cause red loops; the joint should be shiny and firm.
- Remove the battery slowly, rocking the plug side to side (small curved pliers or a flat screwdriver help).
