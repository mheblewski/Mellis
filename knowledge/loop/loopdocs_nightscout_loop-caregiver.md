---
id: loopdocs-nightscout-loop-caregiver
title: "LoopDocs: LoopCaregiver app: requirements, adding a Looper with the QR code, timeline display and sending overrides, carbs and boluses to Loop"
publisher: "LoopDocs (LoopKit)"
url: https://loopkit.github.io/loopdocs/nightscout/loop-caregiver/
licence: "Own summary (Mellis); original: LoopDocs has no licence file: paraphrased with short quotes only"
licence_url: https://github.com/LoopKit/loopdocs
mode: SUMMARY_ONLY
language: en
retrieved: 2026-11-14
topics: [loop, aid, children]
index: true
---

*Our summary (Mellis knowledge base) of a LoopDocs page, written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/nightscout/loop-caregiver/.*

# LoopDocs: the LoopCaregiver app for remote Loop commands

## LoopCaregiver requirements and prerequisites [section "The LoopCaregiver App"]

- LoopCaregiver is an app still in development that makes remote commands to Loop easier to send and follow.
- Minimum: Loop 3.3 or newer, iOS 16 or newer on the caregiver's phone, Nightscout 14.2.6 (released 30 September 2022).
- First complete the four Remote Configuration steps (Looper's iPhone settings, Apple Push Notifications, adding the APN key to Nightscout, testing remote overrides) and read the remote-commands warnings and override FAQs.
- With older Nightscout, carbs entered for a past or future time are accepted by the app but land at the current time on the Looper's phone; LoopDocs asks to update Nightscout.
- As development code, it needs following the LoopCaregiver Zulipchat stream for announcements, reporting problems and frequent rebuilding.

## Building LoopCaregiver [section "Build the LoopCaregiver App"]

It is built like Loop, either with the browser method or with a Mac build script; build steps are not summarised here.

## Adding a Looper to LoopCaregiver [section "Add Looper to the LoopCaregiver App"]

On the Loop phone open Loop -> Settings -> Services -> Nightscout and tap the `One-Time-Password` row to show the QR code (a screenshot kept securely lets you add it later without the Looper; never share it). In LoopCaregiver open `Settings`, enter the Looper's name, the Nightscout URL (with https://) and the `API_SECRET`, then tap the QR row and scan the code. Several Loopers can be added and monitored.

## LoopCaregiver main screen and timeline [section "Main Screen of the LoopCaregiver App"]

The app reuses much of Loop's look plus a Nightscout-like Timeline. The timeline autoscales to the last 24 hours of glucose (plus the forecast if enabled), can be changed with the hours dropdown and by scrolling, and a double tap toggles between 1-hour and 6-hour views. In `Settings` you choose mg/dL or mmol/L and whether to show the Loop prediction (`Show Prediction`) on the timeline and glucose chart.

## Sending remote commands with LoopCaregiver [section "Issue Remote Commands with the LoopCaregiver App"]

Overrides, carbs and boluses are sent from a toolbar similar to Loop's. Carb and bolus commands must be authorised with the caregiver phone's own unlock method (Face ID, fingerprint or passcode). LoopDocs says this makes remote commands much easier and more reliable, and asks users to review the Remote Commands warnings first. Errors are covered on a separate Remote Errors page.
