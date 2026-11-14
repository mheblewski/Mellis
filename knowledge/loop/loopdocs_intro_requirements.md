---
id: loopdocs-intro-requirements
title: "LoopDocs: Requirements: what hardware and accounts are needed to use Loop 3, including when a RileyLink is needed"
publisher: "LoopDocs (LoopKit)"
url: https://loopkit.github.io/loopdocs/intro/requirements/
licence: "Own summary (Mellis); original: LoopDocs has no licence file: paraphrased with short quotes only"
licence_url: https://github.com/LoopKit/loopdocs
mode: SUMMARY_ONLY
language: en
retrieved: 2026-11-14
topics: [loop, aid, pump, cgm, children]
index: true
---

*Our summary (Mellis knowledge base) of a LoopDocs page, written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/intro/requirements/.*

# LoopDocs: what you need to use Loop

## Two ways to build Loop 3 [section "Two Ways to Build the App"]

Since Loop 3 the app can be built either in a web browser on any computer or tablet (installed on the iPhone through TestFlight) or on a Mac with Xcode connected to the iPhone (the Mac's operating system and Xcode must be kept up to date). Both give the same app. LoopDocs suggests Mac owners may prefer the Mac method and everyone else the browser method.

## What every Loop user needs [section "Common Requirements"]

Whatever the build method, Loop needs:

- a compatible iPhone;
- a compatible insulin pump;
- a compatible CGM;
- a RileyLink-compatible radio device for Medtronic pumps and Omnipod Eros; it is not needed with Omnipod DASH or SOOIL Dana pumps (Dana-i or Dana RS);
- an Apple Developer membership. Building with a browser requires a paid developer account; building on a Mac can use a free account with limitations and a weekly rebuild. When Loop is built for a child, the child should have their own Apple ID.

The browser method also needs a free GitHub account; the Mac method needs a compatible Mac and the free Xcode app.

## Trying Loop with simulators [section "Getting Ready to Build", tip "Simulator Option"]

Loop includes a simulated CGM and simulated pump, available with either build method, so the app can be tried without hardware. Real CGM data can be fed in through Dexcom Share or Nightscout as a Remote CGM.
