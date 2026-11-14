---
id: loopdocs-faqs-safety-faqs
title: "LoopDocs: Safety FAQs: settings, iOS Focus alerts, cancelling a bolus, Apple Health entries, scary predictions, Medtronic tips"
publisher: "LoopDocs (LoopKit)"
url: https://loopkit.github.io/loopdocs/faqs/safety-faqs/
licence: "Own summary (Mellis); original: LoopDocs has no licence file: paraphrased with short quotes only"
licence_url: https://github.com/LoopKit/loopdocs
mode: SUMMARY_ONLY
language: en
retrieved: 2026-11-14
topics: [loop, aid, settings, pump, cgm, limits, education, children]
index: true
---

*Our summary (Mellis knowledge base) of a LoopDocs page, written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/faqs/safety-faqs/.*

# LoopDocs: safety FAQs for Loop

## Loop settings you are unsure of [section "Know your settings"]

LoopDocs warns against entering guessed therapy settings into Loop, such as a carb ratio picked at random. Settings should be tested and discussed with the health care provider.

## Loop alerts and iOS Focus modes [section "iOS Focus Notifications"]

Each iPhone Focus mode has to be set up to let diabetes apps notify, or glucose alerts will be missed. Critical alerts (for example Dexcom's urgent low) come through regardless of Focus, but ordinary low and high alerts can be silenced, and open-source apps such as Loop can only notify during a Focus if the user allows it. In iOS Settings, open Focus and pick a mode (for example Sleep), turn on Time Sensitive Notifications (off by default), tap + to add allowed apps, search for and select Loop and any other alerting apps. A small clock icon shows time-sensitive notifications are on. Repeat for every Focus mode in use.

## Understanding the Loop main screen [section "Understand the App Displays"]

Users should understand everything on the Loop main screen (heads-up display, charts, toolbar) and are pointed to the Displays page if not.

## Carb entries and Loop insulin delivery [section "Carb Entry and Insulin Delivery"]

In closed loop, Loop starts dosing for carbs as soon as they are entered. If the amount or time of a carb entry was wrong or plans changed, edit or delete the entry so Loop can predict and dose correctly.

## How to cancel a bolus in Loop [section "How to Cancel a Bolus"]

A running bolus shows its progress in the HUD Status Row of the Loop main screen (visible with the phone in portrait). Tapping that row stops the bolus.

## Loop delivery limits [section "Understand Delivery Limits"]

Each cycle Loop computes a positive or negative dose towards the correction range; the automatic response to a positive dose depends on the Dosing Strategy and is limited by the Delivery Limits (Maximum Bolus and Maximum Basal Rate).

## Loop and carbs from other apps in Apple Health [section "Health app permissions"]

In older Loop versions, or Loop 3 customized to read carbs from third-party apps, carbs written to Apple Health by other apps (MyFitnessPal is the example) can be read by Loop and dosed for, and such entries cannot be edited in Loop.

## Very low or negative Loop predictions [section "Glucose Prediction is Scary"]

A very low, even negative, predicted glucose will not actually happen, as it is an artefact of the model, but the user must find out what is causing it. Two common causes:

- **Extreme override:** new users often assume a 10 % override acts like a 10 % temp basal on a manual pump; it does not. The Overrides page explains how to avoid extreme Insulin Needs settings.
- **Wrong entry in Apple Health:** Loop 3 has its own ways to enter fingerstick values and non-pump insulin, but still reads Apple Health. Glucose must go into glucose and insulin into insulin. In one case a caregiver using mmol/L put a fingerstick value into the insulin record, saw a huge IOB for their child and feared the pump had given 10 U; deleting the entry fixed the prediction.

## Medtronic Easy Bolus button with Loop [section "Beware the Medtronic Easy Bolus button"]

The Medtronic Easy Bolus button has caused accidental boluses when the pump was in a pocket. Since boluses are given from the phone with Loop, LoopDocs suggests disabling it.

## Finishing Medtronic priming with Loop [section "Finish your Medtronic priming"]

After a site change and reservoir rewind, the Medtronic pump shows a screen to finish priming. Complete it and return to the main menu: the pump will not resume basal delivery until that priming screen is finished.
