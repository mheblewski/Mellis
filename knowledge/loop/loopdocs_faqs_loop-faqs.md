---
id: loopdocs-faqs-loop-faqs
title: "LoopDocs: Loop FAQs: getting and updating the app, costs, RileyLink need, compatible pumps, losing the RileyLink or phone, offline use and the mmol/L display glitch"
publisher: "LoopDocs (LoopKit)"
url: https://loopkit.github.io/loopdocs/faqs/loop-faqs/
licence: "Own summary (Mellis); original: LoopDocs has no licence file: paraphrased with short quotes only"
licence_url: https://github.com/LoopKit/loopdocs
mode: SUMMARY_ONLY
language: en
retrieved: 2026-11-14
topics: [loop, aid, pump, education]
index: true
---

*Our summary (Mellis knowledge base) of a LoopDocs page, written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/faqs/loop-faqs/.*

# LoopDocs: general Loop FAQs

## Loop is not in the App Store [section "Can I download the Loop app from the App store?"]

Loop cannot be downloaded from the App Store, because that would mean distributing a medical device; each user builds their own app. LoopDocs urges reading the documentation on what happens after the build, not only the build steps.

## Phones and devices Loop runs on [section "Can I use an android phone or iPad for Loop?"]

Loop needs an Apple device. Older iPads lack Apple Health, which Loop requires; newer iPads are untested. For Android, LoopDocs points to AndroidAPS.

## School nurse cheat sheet for Loop [section "Is there a cheat sheet for a school nurse to use?"]

LoopDocs links a downloadable school-nurse cheat sheet (PDF) for Loop.

## Costs of using Loop and RileyLink devices [sections "Does the Loop app cost money?", "RileyLink Options", "Free Developer Account Options"]

- Most people pay for an Apple Developer Account ($99/year), which allows building in a browser without a Mac. A free developer account means rebuilding every 7 days on a Mac with Xcode.
- Pumps that need a RileyLink-compatible device (loopable Medtronic pumps and older Omnipod Eros) need one at about $150 each, one-time; LoopDocs recommends owning two, one as a spare (used ones circulate in the community). Bluetooth pumps such as DASH, DanaKit and Medtrum need none.
- Beyond that there are no costs other than CGM, pump supplies and insulin.

## How often a Loop app must be updated [section "How often do I need to get on the computer for Loop?"]

- Browser build: GitHub disables the automatic build for Loop, so a manual action is needed; LoopDocs recommends updating and installing from TestFlight monthly, and at minimum installing from TestFlight at least every 90 days, checking that builds are generated and signing developer agreements when asked.
- Mac build: once at the start and at least once a year afterwards (every 7 days with a free account).
- Updates never come through the App Store; Loop releases come a few times a year.

## Switching pumps without rebuilding Loop [section "Will I need to build a new Loop app if I switch between different pumps?"]

No rebuild is needed; one Loop app can change pump type (Change Pump Type).

## One developer account for a family; switching or borrowing accounts [sections "Can I use my Apple Developer account to build for others?", "What happens when I switch Apple Developer ID?", "Can I use someone else's Apple Developer account?"]

- One adult's developer account covers all Loopers in the family (TestFlight group for browser builds). LoopDocs advises that another family member knows how to build, and building Loop on a backup phone, especially for travel. Each Looper needs their own Apple ID.
- A build from a different developer ID installs as a second Loop app; the Looper must onboard it, re-enter all settings and delete the old app.
- Using someone else's account is risky: if they revoke the device certificate or let the account lapse, Loop stops working at once and will not even open.

## Compatible pumps for Loop [sections "How can I find a compatible pump? supplies?", "What about other pumps? When will they Loop?"]

- Omnipod DASH and Eros work with Loop; no Omnipod PDM is needed, though Insulet may ask for a PDM serial number for pod replacements.
- Older Medtronic pumps: LoopDocs has a separate page on finding them, supplies and checking whether a given Medtronic pump is compatible. Newer Medtronic pumps are not compatible.
- Medtrum works with released Loop v3.14.2 or newer. Dana pumps are available in a feature branch. Tandem pumps are not compatible.

## Paying someone to build Loop [section "Can I pay someone else to do build the app for me?"]

Some companies offer Loop as a service; LoopDocs gives no links and strongly encourages building it yourself. Anyone using such a service should first read all of LoopDocs and know how to set up, operate and troubleshoot Loop, for safety.

## Losing or replacing the iPhone [section "What if I lose or get a new iPhone?"]

A lost phone is handled like a lost RileyLink (next section). A new phone can be planned for; LoopDocs has a separate New Phone page.

## Losing the RileyLink device: what Medtronic and Eros users do [section "What if I lose my RileyLink Compatible Device?"]

- Only Medtronic and Eros users need a RileyLink; Bluetooth pump users are unaffected.
- Medtronic: go back to using the pump on its own until a device is available. The current temp basal ends by itself (30 minutes or less) or can be cancelled in the pump menu; boluses are given with the pump's own bolus menu. When Loop is running again (found device or backup), enter in Loop any recent carbs that may still affect glucose, backdated to when they were eaten: Loop reads the insulin delivered meanwhile from the pump, but it does not read carbs entered into the pump.
- Eros: the pod finishes any temp basal (max 30 minutes) and returns to scheduled basal; boluses need a pen or syringe. A backup device can be connected to the same Loop app and pod session; without one, the pod must be replaced and started with the PDM until a new device arrives.

## Returning from the dev branch to the released version [section "How do I return to the released version?"]

Most people should build the released version (`main` branch). From version 3.14.1, a Loop built from the `dev` branch shows an alert at startup that must be acknowledged; feature branches do not show it.

## More than one Loop app on one phone [section "Can I have more than one Loop app on a phone?"]

Possible, but it can cause conflicts that stop Loop staying green, and a pod works with one Loop app only; LoopDocs advises one Loop app per phone.

## Using Loop without internet (plane, mountains) [section "Will I be able to use the Loop app on a plane? Or in the mountains?"]

Loop needs no internet or cell coverage, only Bluetooth on the iPhone, for the CGM and the pump (DASH directly, Eros or Medtronic through the RileyLink). The exception is a CGM source that itself needs the internet (remote CGM).

## Glucose units suddenly switching from mmol/L to mg/dL in Loop [section "How to Fix Loop Suddenly Changing Glucose Units from mmol/L to mg/dL?"]

A known display glitch sometimes switches readings from mmol/L to mg/dL. Force-closing and reopening Loop usually fixes it; if not, the units are changed through Apple Health (separate FAQ).
