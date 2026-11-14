---
id: loopdocs-loop-3-services
title: "LoopDocs: Loop 3 Services: adding or removing Nightscout (URL, API_SECRET, common errors, upload backfill), Tidepool double entries, Loggly and Amplitude"
publisher: "LoopDocs (LoopKit)"
url: https://loopkit.github.io/loopdocs/loop-3/services/
licence: "Own summary (Mellis); original: LoopDocs has no licence file: paraphrased with short quotes only"
licence_url: https://github.com/LoopKit/loopdocs
mode: SUMMARY_ONLY
language: en
retrieved: 2026-11-14
topics: [loop, aid, settings]
index: true
---

*Our summary (Mellis knowledge base) of a LoopDocs page, written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/loop-3/services/.*

# LoopDocs: Services in the Loop app (Nightscout, Tidepool, Loggly, Amplitude)

## Services section in Loop settings [section "Services for the Loop App"]

Near the bottom of Loop settings, Services are added with the + sign and listed alphabetically. They are optional; Loop works without them. Nightscout is highly recommended but can be added later. The most common are Nightscout and Tidepool.

## Adding Nightscout to Loop [sections "Nightscout", "Nightscout Login"]

- You need the site URL and the API_SECRET (on Heroku under Settings, Reveal Config Vars; on Azure under Application Settings, Connection Strings).
- Steps: Loop Settings -> Services -> Add Service -> Nightscout Service; tap the URL row and enter the URL including https://, or pick saved credentials from iPhone Passwords (fills URL and API_SECRET); otherwise type the API_SECRET; tap Login.
- Loop uploads from that moment on and does not backfill older data. After a temporary internet or Nightscout outage it fills in missed data, up to 7 days.
- Two common mistakes: using `http://` instead of `https://` (gives an App Transport Security policy error), and a trailing slash or embedded space in the URL (often from copy-paste).
- One family's parental website blocker on the child's phone blocked their Nightscout URL by accident.
- Tip: store the credentials as a password (iOS 17 and earlier: Settings, Passwords; iOS 18+: Passwords app): Title "Nightscout", Website = URL without https://, User Name = URL with https://, Password = API_SECRET; tokens can go in Notes.

## Removing or changing the Nightscout site in Loop [section "Nightscout Logout"]

To stop uploading or switch to another site, log out of the current Nightscout service first, then log in to the new one.

## Tidepool service in Loop and double entries [section "Tidepool"]

Loop can upload directly to Tidepool as a service. When doing so, turn off Tidepool Mobile's access to Apple Health; otherwise every carb and insulin record appears twice on Tidepool Web. Even after turning it off there are 7 days of overlap, because Loop stores 7 days of data; a filter on the Tidepool website separates the two sources. Tidepool Mobile notes still work without Health access (needs internet). Tidepool support: support@tidepool.org.

## Loggly and Amplitude services in Loop [sections "Loggly", "Amplitude"]

Loggly (free logging) needs a customer token from its Source Setup, Customer Tokens page pasted into Loop. Amplitude (remote event monitoring for errors and events) needs the API key from a free account.
