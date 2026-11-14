---
id: loopdocs-loop-3-settings
title: "LoopDocs: Loop 3 Settings screen: Closed Loop switch, Dosing Strategy, Missed Meal alerts, Algorithm Experiments, Favorite Foods, support reports and app expiry"
publisher: "LoopDocs (LoopKit)"
url: https://loopkit.github.io/loopdocs/loop-3/settings/
licence: "Own summary (Mellis); original: LoopDocs has no licence file: paraphrased with short quotes only"
licence_url: https://github.com/LoopKit/loopdocs
mode: SUMMARY_ONLY
language: en
retrieved: 2026-11-14
topics: [loop, settings, aid, smb, bolus-calculator, pump, cgm, education]
index: true
---

*Our summary (Mellis knowledge base) of a LoopDocs page, written in our own words with short quotes only; not the original text and not medical advice. Original: https://loopkit.github.io/loopdocs/loop-3/settings/.*

# LoopDocs: the Loop 3 Settings screen

## Where the Loop Settings screen is [section "Loop Settings Screen"]

In Loop 3 the Settings screen opens from the gear icon in the toolbar at the bottom of the main Loop screen. The page describes the layout of Loop 3.14.11 and later, going row by row through the sections below.

## Closed Loop switch [section "Closed Loop"]

The Closed Loop slider at the top of Loop Settings switches between closed loop (automatic insulin adjustment) and open loop. LoopDocs suggests new users keep it off at first and learn the app in Open Loop mode. The moment Closed Loop is turned on, Loop starts adjusting insulin automatically, so the therapy settings must already be suitable for the Loop algorithm.

The slider is disabled and no automatic adjustment happens when no pump has been added, when no CGM has been added, or while a Manual Temp Basal set by the user is running.

## How Loop computes the recommended insulin [section "Recommended Insulin"]

Each loop cycle (normally every 5 minutes) Loop refreshes its glucose prediction from the latest CGM or fingerstick value (which must be no more than 15 minutes old), carbs on board from meal entries, insulin on board from earlier delivery, and the Therapy Settings. From that prediction it works out the change in dosing needed to reach the correction range: a basal reduction to lift the prediction, or a recommended bolus (within Delivery Limits) to bring it down. The prediction is drawn on the Glucose Chart next to measured values. In Open Loop nothing is done automatically; in Closed Loop, Loop acts according to the selected Dosing Strategy.

## Dosing Strategy: Temp Basal Only vs Automatic Bolus [section "Dosing Strategy" / "Temp Basal Only"]

The Dosing Strategy row only changes how a recommended bolus, if there is one, gets delivered; the current choice is shown under the row label. The starting value is Temp Basal Only.

- Whatever the strategy, when glucose is below target or predicted to go below it, Loop reduces insulin with a temporary basal.
- **Temp Basal Only:** within Delivery Limits, Loop delivers the recommended bolus over 30 minutes as temp basals above the scheduled rate, raising IOB.
- **Automatic Bolus:** within Delivery Limits, Loop gives 40% of the recommended bolus at each loop cycle. The in-app text says Loop boluses automatically when insulin needs exceed scheduled basal and still uses temp basals to go below scheduled basal.

## Automatic Bolus and Glucose Based Partial Application [section "Automatic Bolus"]

LoopDocs advises staying on Temp Basal Only until the settings are well tuned. With Automatic Bolus, Loop gives 40% of the recommended dose as a bolus at the start of each cycle, when a new CGM reading arrives; it is the quicker way to get the recommended insulin in, and the scheduled basal keeps running unchanged while Loop adds the extra.

From Loop 3.4.0, Automatic Bolus can be combined with Glucose Based Partial Application (GBPA), switched on under Algorithm Experiments. Instead of a fixed 40%, the share per cycle is 20% when glucose is near the Correction Range and rises gradually to 80% at 200 mg/dL (11.1 mmol/L).

A manual bolus is always possible via the Bolus icon in the middle of the main screen, and the recommendation shown there is the full (100%) recommended bolus, not the partial automatic share.

## Alert Management and Missed Meal Notifications [section "Alert Management" / "Missed Meal Notifications"]

The Alert Management row holds alert permissions and the Missed Meal Notifications switch. When it is on, Loop watches for glucose rises that look like uncounted carbs and sends an alert estimating when the meal was eaten and how many carbs have already been absorbed; the user can then raise the carb amount to match what was really eaten.

## Therapy Settings need a pump [section "Configuration" / "Add Pump for Therapy Settings"]

The Therapy Settings row in Loop Settings appears only once a pump is connected, because Loop needs the pump's parameters (for example its basal steps and limits). Ways around this described by LoopDocs:

- **Omnipod or Omnipod DASH:** start adding the pod (Omnipod needs a RileyLink) up to the `Pair Pod` screen and cancel; Loop then uses general Omnipod details so Therapy Settings can be edited.
- **Medtronic:** add the Insulin Pump Simulator, open its control screen (tap the pump in settings or the HUD), choose the Medtronic model, set the Therapy Settings, then delete the simulator.
- **Running Loop alongside current therapy:** add the Insulin Pump Simulator and pick the pump type to imitate (each has its own basal rates and ranges); use a real CGM on the same phone or Dexcom Share / Nightscout as the CGM, and mirror each real meal or correction in Loop to watch its predictions and recommendations.

## Usage Data Sharing [section "Usage Data Sharing"]

Loop's Usage Data Sharing choice can be changed at any time and takes effect immediately. Shared data is anonymous. Options: share nothing; share only the Loop version, phone type and iOS version; or additionally share event-only usage data. Health values such as glucose, insulin and carbs are not collected.

## Algorithm Experiments: GBPA and IRC [section "Algorithm Experiments"]

Since Loop 3.4 the Settings screen has an Algorithm Experiments row with two optional features the user decides whether to enable:

- **Glucose Based Partial Application (GBPA):** changes only the speed of Automatic Bolus delivery; smaller automatic boluses per cycle near target, larger when glucose is higher, and the automatic bolus is always less than the recommended bolus.
- **Integral Retrospective Correction (IRC):** changes Loop's prediction model by also looking at longer-term differences between predicted and actual glucose. People mainly like it because it helps when glucose seems "stuck on high". Users who turn on IRC often need to raise ISF a little.

## Pump and CGM rows [section "Pump" / "CGM Settings"]

The Pump and CGM rows in Loop Settings lead to the device screens. Pumps covered in LoopDocs: Omnipod and Omnipod DASH, Medtronic, Medtrum (needs the `dev` branch) and Dana (needs a feature branch).

## Favorite Foods [section "Favorite Foods"]

Favorite Foods (since Loop 3.4) are optional saved meal entries, created either in Loop Settings or on the Carb Entry screen. To save one from Carb Entry, a specific food emoji must be chosen by tapping the plate icon; picking the plain Lollipop, Taco or Pizza icons at the top level does not enable the Save as Favorite button.

## Services [section "Services"]

The Services section of Loop Settings is where Nightscout, Tidepool, Loggly and Amplitude can be added.

## Support: reporting a problem in Loop [section "Support" and subsections]

The Support section (builds newer than v3.14.9; older builds differ) offers:

- **Send to Loop Developers:** a form to explain a problem, with optional screenshots, sent anonymously or with contact details. Not meant for build trouble or settings questions.
- **Share a Diagnostic Report:** the Loop Report (formerly "Issue Report"); viewing it shows the version and any customizations, and the share arrow sends it. LoopDocs suggests saving one with a screenshot before asking for help.
- **Open a GitHub Issue** (called Submit Bug Report up to v3.14.9): for real code errors only; search first whether the issue already exists. Not for trouble building, pairing a pod, red loops, a RileyLink that does not work, or adjusting settings.
- **Export Critical Event Logs:** a zip of detailed app data covering 7 days, in JSON, one set per local day (Alerts, Carbs, DeviceLog, Doses, DosingDecisions, Glucoses, Settings), with timestamps in UTC; today is merged with the previous day. Developers may ask for it.

In v3.14.9 and earlier the Issue Report covered 84 hours, so a full pod history fits.

## TestFlight or App Profile: when the Loop app expires [section "TestFlight or App Profile"]

The last section of Loop Settings, named TestFlight or App Profile depending on how Loop was built, shows how many days remain before the app stops opening, and the local date and time when the `"Loop" is No Longer Available` or `"Loop" Beta has Expired` message will appear. A `How to update (LoopDocs)` link is included. Loop's estimate is conservative: a TestFlight install may last about a day longer, and the TestFlight app itself shows the exact time. Before Loop 3.4 this TestFlight warning existed only in `dev`.
