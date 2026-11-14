---
id: loopdocs-faqs-remote-control
title: "LoopDocs: Remote control FAQ: three ways for caregivers to send overrides, carbs and boluses to Loop (Nightscout Careportal, LoopCaregiver, LoopFollow) and the OTP window"
publisher: "LoopDocs (LoopKit)"
url: https://loopkit.github.io/loopdocs/faqs/remote-control/
licence: "Own summary (Mellis); original: LoopDocs has no licence file: paraphrased with short quotes only"
licence_url: https://github.com/LoopKit/loopdocs
mode: SUMMARY_ONLY
language: en
retrieved: 2026-11-14
topics: [loop, aid, children, bolus-timing]
index: true
---

*Our summary (Mellis knowledge base) of a LoopDocs page, written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/faqs/remote-control/.*

# LoopDocs: remote control options for Loop caregivers

## What caregivers can do remotely in Loop and the three methods [section "Remote Caregivers"]

- All options need a Nightscout site for the Looper; with it the caregiver can monitor remotely.
- Remote commands: change the Override (Custom Preset) without a one-time password; add carbs and give a bolus, both needing an OTP (one-time password that changes every 30 seconds).
- Every method needs an APNS (Apple Push Notification) key from someone with an Apple Developer licence, and it must be the same developer who built the Looper's Loop app.
- Method 1, Nightscout Careportal in a browser: the only option for a caregiver with an Android phone; the Nightscout config vars must hold the APNS key and the developer ID of the Loop builder.
- Method 2, LoopCaregiver app built on the caregiver's iPhone (iOS 16 or newer): sends commands through Nightscout; same config-var requirements.
- Method 3, LoopFollow app on the caregiver's phone (iOS 16.6 or newer): sends APNS directly to the Looper's phone, which can be faster and more reliable; Nightscout is used only for monitoring and needs no extra config vars, which helps when Nightscout is a paid hosted service.

## Longer OTP window customization for Loop remote commands [section "Customization for Longer OTP Window"]

Many people find the OTP expires too soon when Looper and caregiver are on different networks. A Loop customization (from Loop and Learn) lets Loop accept a remote command that arrives within a 15-minute window; LoopDocs asks you to review it carefully before using it. Because it changes the Loop app, it applies to all three remote methods.
