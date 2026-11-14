---
id: loopdocs-nightscout-remote-commands
title: "LoopDocs: Nightscout remote commands for Loop: OTP and QR setup, remote overrides, remote bolus and carbs, duplicate-dose risk, bolus-then-carbs order, unique carb times, Careportal and Shortcuts"
publisher: "LoopDocs (LoopKit)"
url: https://loopkit.github.io/loopdocs/nightscout/remote-commands/
licence: "Own summary (Mellis); original: LoopDocs has no licence file: paraphrased with short quotes only"
licence_url: https://github.com/LoopKit/loopdocs
mode: SUMMARY_ONLY
language: en
retrieved: 2026-11-14
topics: [loop, aid, children, bolus-timing, nutrition, settings]
index: true
---

*Our summary (Mellis knowledge base) of a LoopDocs page, written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/nightscout/remote-commands/.*

# LoopDocs: sending remote commands to Loop through Nightscout

## Requirements for Loop remote commands [section "Requirements"]

- All remote commands need the Remote Configuration steps done first (APNS key in Nightscout etc.).
- Every remote bolus and every remote carb entry needs a fresh one-time password (OTP). The OTP changes every 30 seconds, and both the sending device and the Loop phone must use automatic time.
- Remote overrides need no OTP. Some Nightscout versions show an OTP row for Temporary Override in the Careportal; leave it empty.
- This applies whatever tool is used, including LoopCaregiver.

## Finding the Loop QR code for one-time passwords [section "QR Code"]

On the Loop phone, Nightscout must be added under Loop -> Settings -> Services. Open Services -> Nightscout and tap the One-Time Password row to show the QR code; the 6-digit number on that row changes every 30 seconds. Authenticator setup scans this QR, either live from the Loop phone or from a saved screenshot. Keep that screenshot secure and never share it when asking for help.

## Authenticator apps for Loop remote bolus and carbs [section "Set up an Authentication App"]

- An authenticator app generates the OTPs. LoopCaregiver handles OTPs itself, but LoopDocs advises setting up an authenticator anyway for times the LoopCaregiver phone is not at hand.
- Apple Keychain (iPhone or Mac): in iOS Settings -> Passwords (iOS 17 and earlier) or the Passwords app (iOS 18+), tap + and enter Website = Nightscout URL without "https://", Username = full URL with "https://", Password = the Looper's API_SECRET. Then use "Setup Verification Code" and scan the Loop QR code; an OTP appears. If the Loop phone is nearby, check over a cycle or two that both show the same 6 digits and change together. In Password Options enable `Autofill Passwords` with `Keychain`.
- In Safari on the Looper's Nightscout site, the Careportal (+) offers the OTP on every field; ignore it for carb amount, absorption time and bolus amount and pick it only for the OTP row. Leave OTP empty for remote overrides.
- Other authenticator apps work too, for example 1Password, Authenticator and Authy.

## General FAQs for Loop remote commands [section "FAQs for all Remote Commands"]

- One APNs key can be used in the Nightscout sites of several Loopers; multiple keys are not needed.
- A command worked if the change shows in Nightscout (for an override, the override pill) after the next Loop cycle; near the Loop phone the new override appears in about 30 seconds.

## FAQs on remote overrides in Loop [section "FAQs on Remote Overrides"]

- Only override presets already defined in the Loop app can be started remotely; a new custom override cannot be created from Nightscout.
- An override started on the Loop phone can be cancelled from the Nightscout Careportal ("temporary override" cancel), and can be replaced by one started from Nightscout.
- Nightscout shows a phone-started override as a grey bar with its name, and the Loop pill shows targets and duration; the grey bars have a known issue, so trust the pill.
- The Looper can cancel any override, whatever started it, by tapping the heart icon in Loop so it is no longer highlighted. A remote override cancelled this way is not restored later: the push is sent once, so it must be sent again if wanted.
- Remote overrides cannot be scheduled ahead: they start at once and last for the duration set for that preset in Loop. Advance scheduling is possible only in the Loop app.

## Remote bolus and carb commands: minimum versions [section "Remote Commands"]

Remote bolus and carbs require an OTP. Minimum versions are Loop 3 and Nightscout 14.2.6. With older Nightscout, commands may be accepted but always at the current time, so carbs meant for the past or future land at the moment of receipt on the Loop phone.

## Duplicate delivery risk with remote bolus or carbs in Loop [section "Warnings on Remote Commands"]

LoopDocs puts this risk first: always assume an earlier remote bolus or carb entry was delivered. Its example: a 5-unit remote bolus is delivered, Nightscout has a temporary glitch and does not show it, the caregiver assumes it failed and sends another 5 units, and the Looper gets 10 units in total. If an entry does not appear in Nightscout, judge carefully whether enough time has passed before trying again.

## Sending both: remote bolus first, then remote carbs [section "Remote Bolus, Then Remote Carb"]

- Sending carbs first and then a bolus can give too much insulin. With dosing strategy Temp Basal Only, Loop starts a maximum temp basal when it receives the carbs, and the later bolus adds on top. With Automatic Bolus, Loop gives a percentage of the recommended dose on receiving the carbs, and the later bolus adds on top or is rejected because a bolus is already running.
- Usually a remote carb entry alone is enough for Loop to start dosing for the meal.
- If you do want both, send the bolus first (it may make Loop set a zero temp basal, the safer direction), then the carbs, so the forecast includes both.
- Wait at least 60 seconds between remote commands, otherwise the OTP is rejected as already used.

## Unique times for remote carb entries (Nightscout keeps one per timestamp) [section "Use Unique Times for Remote Carbohydrate Entries"]

- Nightscout keeps only one carb treatment per identical hour:minute:second. Loop itself keeps both (it gives each entry its own identifier), but Nightscout and therefore LoopCaregiver may show only one, tempting the caregiver to resend.
- Remote carbs cannot be edited. To raise a 10 g entry at 11:30 to 15 g, add a new 5 g entry at 11:31. To enter two absorption times, use e.g. 10 g with 2 h absorption at 11:30 and 15 g with 4 h at 11:31.
- LoopCaregiver now uses the seconds of the moment the entry is created, so collisions are unlikely (1 in 60). Careportal entries with the same hour:minute always get 0 seconds: Loop accepts both, but when Loop reports the second back to Nightscout it replaces the first in the Nightscout record.

## Ways to send remote commands to Loop [section "Using Remote Commands"]

Four ways: LoopCaregiver, the Nightscout Careportal, iPhone Shortcuts and IFTTT.

## Nightscout Careportal setup for Loop remote commands [section "Nightscout Careportal"]

- The Nightscout site needs the Loop configuration plus Remote Configuration. The `ENABLE` line must contain `override`, `careportal` and `Loop` (order does not matter). After changing build method (Mac vs Browser), an extra config var is needed. The site must be authenticated with the API_SECRET so the Careportal is active.
- After authenticating, the Careportal is the plus sign at the upper right. Remote commands are at the bottom of the `event type` list. Entries at the top without "remote" are manual treatment records for people without an automated system; Loop does not read them (OpenAPS-based systems may behave differently).

## Sending a remote bolus or remote carb entry from the Careportal [section "Command Remote Bolus or Carb Entry"]

Open the Careportal (+), pick `Remote Carb Entry` or `Remote Bolus Entry` at the bottom of the event types, fill in the form up to the OTP row, then paste or autofill the OTP (Safari offers it automatically, sometimes after two taps; with other apps copy the code) and tap "Submit Form". Loop accepts the current OTP and the one that just expired. With the Looper nearby, a notification appears on their phone and the entry shows in Loop's carb or insulin views; remotely, the result should show in Nightscout within 5 minutes.

## Starting and ending a remote override from the Careportal [section "Start and End Remote Override"]

No OTP needed. The Looper gets a banner notification with the command details and whether it succeeded. To cancel, choose event type `Temporary Override Cancel` and submit.

## iPhone Shortcuts for Loop remote overrides [section "Shortcuts"]

LoopKit provides iPhone Shortcuts: a comprehensive Loop shortcut (set remote override, cancel override, troubleshooting tips, quick texts, manual BG entry, bookmarks) and single-purpose ones for setting or cancelling a remote override. Untrusted shortcuts must be allowed in iPhone Settings -> Shortcuts ("Allow Untrusted Shortcuts"), and that switch only appears after running any gallery shortcut once. In the shortcut's URL field, do not end the Nightscout URL with `/`. Success shows `ok`; the usual error is a wrong API_SECRET (watch for a hidden trailing space) or incomplete Nightscout/Loop setup.

## IFTTT for Loop remote overrides [section "IFTTT"]

IFTTT (If This, Then That) integration with Nightscout can also set overrides, and log cannula or sensor changes, with single button presses; LoopDocs presents it as the harder route and points to the Nightscout documentation.
