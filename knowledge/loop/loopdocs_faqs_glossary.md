---
id: loopdocs-faqs-glossary
title: "LoopDocs: Glossary: short definitions of Loop terms and abbreviations (IOB, COB, ISF, CR, DIA, Glucose Safety Limit, Dosing Strategy, overrides, devices, Nightscout)"
publisher: "LoopDocs (LoopKit)"
url: https://loopkit.github.io/loopdocs/faqs/glossary/
licence: "Own summary (Mellis); original: LoopDocs has no licence file: paraphrased with short quotes only"
licence_url: https://github.com/LoopKit/loopdocs
mode: SUMMARY_ONLY
language: en
retrieved: 2026-11-14
topics: [loop, education, settings, insulin, aid, pump, cgm]
index: true
---

*Our summary (Mellis knowledge base) of a LoopDocs page, written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/faqs/glossary/.*

# LoopDocs: Loop glossary

## Loop therapy settings and dosing terms [section "Glossary"]

- **Automatic Bolus:** Loop Dosing Strategy that gives part of the recommended insulin automatically at each new CGM reading (default 40 %).
- **Temp Basal Only:** Loop Dosing Strategy that gives the recommended insulin as a raised temp basal over half an hour, capped by the maximum basal rate.
- **Dosing Strategy:** the Loop choice of how extra insulin is given: high temp basal, or automatic bolus on top of scheduled basal.
- **GBPA (Glucose Based Partial Application):** a variant of Loop's Automatic Bolus strategy.
- **Temp Basal:** a temporary change to the pump's scheduled basal rate.
- **MTB (Manual Temp Basal):** a temp basal started by the user, available for Omnipod in Loop.
- **Therapy Settings:** Loop's basal rates, ISF, CR, correction and safety ranges and delivery limits.
- **Correction Range:** the glucose range Loop aims the prediction at when it changes basal or recommends a bolus.
- **Glucose Safety Limit:** Loop suggests no insulin when the forecast (next 3 hours) falls below it; called Suspend Threshold in Loop 2.
- **Pre-Meal Range:** a lower correction range for up to one hour, switched on from the toolbar.
- **Override:** a temporary change to Loop's correction range, sensitivity (basal, ISF, CR) or both; heart icon on the main screen; called a Custom Preset in the app.
- **Delivery Limits:** the maximum bolus and maximum basal rate allowed in Loop's therapy settings.
- **Guardrails:** Loop's built-in limits for user settings, with recommended and absolute ranges.
- **ISF (Insulin Sensitivity Factor):** how far glucose drops per unit of insulin; also called correction factor.
- **Correction Factor:** another name for ISF.
- **CR (Carb Ratio):** grams of carbohydrate covered by one unit of rapid-acting insulin.
- **DIA (Duration of Insulin Action):** the whole time insulin is active, including its long low tail.
- **IOB (Insulin on Board):** active insulin above or below the basal rate, calculated by Loop and used in its forecast.
- **COB (Carbs on Board):** grams of carbs Loop still expects to be absorbed and uses in its forecast.
- **Dynamic carb absorption:** Loop models the glucose effect from the carbs, absorption time and settings, then corrects it from measured glucose.
- **ICE (Insulin Counteraction Effect):** the gap between the observed glucose change and the change Loop expects from insulin alone.
- **RC (Retrospective Correction):** the part of Loop's model that compares actual glucose with earlier predictions.
- **IRC (Integral Retrospective Correction):** an optional alternative to RC that sums glucose deviations over a longer period.
- **EGP (Endogenous Glucose Production):** glucose the body makes from its own stores, mainly liver glycogen.
- **MPC (model predictive control):** the type of control algorithm Loop uses.
- **Prebolus:** giving some or all of a meal bolus before eating.
- **Onboarding:** the Loop 3 process that walks users through therapy settings and checks them against the guardrails.

## Loop modes, screens and app behaviour [section "Glossary"]

- **Closed Loop:** Loop changes insulin delivery automatically from its predictions, entries, settings, IOB and COB.
- **Open Loop:** Loop makes no automatic insulin changes, but predictions and recommendations still work.
- **Loop Cycle:** normally every 5 minutes: new CGM value, updated prediction, pump update and, in Closed Loop, a dosing change if needed.
- **HUD (Heads-Up Display):** the top part of Loop's main screen, shown with the phone upright.
- **Glucose Chart:** Loop's chart of measured and predicted glucose.
- **Event History:** the record of pump events (boluses, temp basals) that Loop reads and uses.
- **Modal:** a message in front of the app that must be acknowledged before going back.
- **Lock your Phone:** press the side button to lock the phone so no Loop command is triggered by accident.
- **Quit the Loop App:** fully close the app (swipe it up in the app switcher), which is not the same as just leaving it.
- **Expiration Date:** a built Loop app works only for a limited time; it starts warning 3 weeks before it expires.
- **Provisioning Profile:** ties the app to the developer account and sets its lifetime: 1 year with a paid account, 1 week with a free one.
- **TestFlight:** Apple's way to install the app without connecting the phone to a computer.
- **Loop / Loop 3:** Loop is a do-it-yourself artificial pancreas system; Loop 3 is its current major release.
- **DIY:** do it yourself, the open-source community's common label.

## Loop devices and connections [section "Glossary"]

- **CGM:** continuous glucose monitor, a wearable sensor measuring glucose in interstitial fluid.
- **Omnipod:** Insulet's tubeless pump; Loop supports Eros (also called Classic, UST400 or System, needs a RileyLink-type device) and DASH.
- **Activated (Omnipod):** the time insulin was filled into the pod and two beeps sounded.
- **MDT:** short for Medtronic pumps.
- **RileyLink / OrangeLink / EmaLink:** radio bridges Loop uses to control Eros pods and older Medtronic pumps.
- **BLE:** Bluetooth Low Energy, used by phones, CGMs and some pumps.
- **NFC:** near-field communication, used to scan devices such as Libre sensors.
- **watchOS:** the Apple Watch operating system; it must be compatible with the phone's iOS.
- **UTC / GMT:** the world time standards; Loop keeps its records in UTC.

## Loop remote following and Nightscout terms [section "Glossary"]

- **Nightscout:** a personal website for viewing glucose and diabetes data; Loop can upload to it.
- **Pill (Nightscout):** a small information box on the Nightscout screen; tap for details.
- **CAGE / SAGE / BAGE:** cannula (site) age, sensor age and pump battery age shown in Nightscout.
- **API_SECRET:** the Nightscout site password, at least 12 characters.
- **Tokens:** Nightscout Admin Tools settings that grant access permissions.
- **APN (Apple Push Notification service):** needed to send remote commands through Nightscout.
- **OTP (one-time password):** lets caregivers send remote commands to the Looper's phone securely.
- **LoopCaregiver:** an app that sends remote commands to Loop through Nightscout.
- **LoopFollow:** an app for remote viewing and extra alarms, using Dexcom Share or Nightscout data.
