---
id: androidaps-extended-carbs-ecarbs
title: "AndroidAPS docs: extended carbs (eCarbs) for fat/protein meals and why extended boluses do not fit a closed loop"
publisher: "AndroidAPS documentation (openaps/AndroidAPSdocs) and source code"
url: https://androidaps.readthedocs.io/en/latest/DailyLifeWithAaps/ExtendedCarbs.html
licence: "AGPL-3.0"
licence_url: https://github.com/openaps/AndroidAPSdocs/blob/master/LICENSE
mode: SHIP_TEXT
language: en
retrieved: 2026-10-20
topics: [fat-protein, split-bolus, loop, aid]
index: true
corpus_v7: fat-protein/devices/androidaps-extended-carbs-ecarbs.md
attribution: "Contains text from the AndroidAPS documentation (openaps/AndroidAPSdocs) and/or code from nightscout/AndroidAPS, GNU AGPL v3.0 (https://github.com/openaps/AndroidAPSdocs/blob/master/LICENSE). Original: https://androidaps.readthedocs.io/en/latest/DailyLifeWithAaps/ExtendedCarbs.html"
changes: "Docs text reproduced (images omitted) with our notes and a header; see the file header for what is verbatim."
---

*Contains text from the AndroidAPS documentation (openaps/AndroidAPSdocs) and/or code from nightscout/AndroidAPS, GNU AGPL v3.0 (https://github.com/openaps/AndroidAPSdocs/blob/master/LICENSE). Original: https://androidaps.readthedocs.io/en/latest/DailyLifeWithAaps/ExtendedCarbs.html*

# AndroidAPS docs: Extended carbs / "eCarbs" (fat, protein and slowly absorbed meals in a closed loop)

- **Source:** AndroidAPS documentation, page "Extended carbs / eCarbs" (DailyLifeWithAaps/ExtendedCarbs.md)
- **URL:** https://androidaps.readthedocs.io/en/latest/DailyLifeWithAaps/ExtendedCarbs.html (raw: https://github.com/openaps/AndroidAPSdocs/blob/master/docs/EN/DailyLifeWithAaps/ExtendedCarbs.md)
- **Licence:** the AndroidAPSdocs repository is published under the GNU AGPL v3 (repository LICENSE file); reproduced verbatim (images omitted), retrieved 2026-10-20.
- **Relevance to Trio:** AndroidAPS and Trio both run the oref1 algorithm with SMB/UAM. Trio's equivalent of eCarbs is the "Fat and Protein" (FPU) entry, which creates future carb entries (see corpus trio/configuration_settings_features_meal-settings.md).

---

# Extended carbs / "eCarbs"

## What are eCarbs and when are they useful?

With a regular pump therapy, extended boluses are a good way to deal with fatty or otherwise slowly-absorbed meals which increase blood glucose longer than the insulin is in effect. In a loop context, however, extended boluses don't make as much sense (and pose technical difficulties), since they're basically a fixed high temporary basal rate, which goes against how the loop works, which is adjusting the basal rate dynamically. For details see [extended bolus](#extended-bolus-and-why-they-wont-work-in-closed-loop-environment) below.

The need to deal with such meals still exists though. Which is why AAPS as of version 2.0 supports so called extended carbs or eCarbs.

eCarbs are carbs that are spilt up over several hours. For standard meals with more carbohydrates than fat/protein, entering the carbs up front (and reducing the initial bolus if needed) is usually sufficient to prevent too-early insulin delivery.  But for slower-absorbing meals where full carb entry up front results in too much IOB from SMB, eCarbs can be used to more accurately simulate how the carbs (and any carb equivalents you enter for other macronutrients) are absorbed and influence the blood glucose. With this information, the loop can administer SMBs more gradually to deal with those carbs, which can be seen as a dynamic extended bolus (this should also work without SMBs, but is probably less effective).

**Note:** eCarbs aren't limited to fatty / protein heavy meals: they can be also be used to help in any situation where there are influences that increase the blood sugar, e.g. other medication like corticosteroids.

## Mechanics of using eCarbs

To enter eCarbs, set a duration in the *Carbs* dialog on the overview tab, the total carbs and optionally a time shift (*numbers below are just examples, you will need to try your own values to arrive at satisfactory glucose response for your use-cases*):


The eCarbs on the overview tab, note the carbs in brackets at the COB field, which shows the carbs in the future:


______________________________________________________________________

A way to handle fat and protein with that feature is described here: [https://adriansloop.blogspot.com/2018/04/page-margin-0.html](https://adriansloop.blogspot.com/2018/04/page-margin-0.html)

______________________________________________________________________

## Recommended setup, example scenario, and important notes

The recommended setup is to use the OpenAPS SMB APS plugin, with SMBs enabled as well as the *Enable SMB with COB* preference being enabled.

A scenario e.g. for a Pizza might be to give a (partial) bolus up front via the *calculator* and then use the *carbs* button to enter the remaining carbs for a duration of 4-6 hours, starting after 1 or 2 hours.

**Important notes:** You'll need to try out and see which concrete values work for you of course. You might also carefully adjust the setting *max minutes of basal to limit SMB to* to make the algorithm more or less aggressive.
With low carb, high fat/protein meals it may be enough to only use eCarbs without manual boluses (see the blog post above). When eCarbs are generated, a Careportal note is also created to document all inputs, to make it easier to iterate and improve inputs.

## Extended bolus and why they won't work in closed-loop environment?

As mentioned above extended or multiwave boluses do not really work in a closed loop environment. [See below](#why-extended-boluses-wont-work-in-a-closed-loop-environment) for details

### Extended bolus and switch to open loop - Dana and Insight pump only

Some people were asking for an option to use extended bolus in AAPS anyway as they wanted to treat special foods the way they are used to.

That's why as of version 2.6 there is an option for an extended bolus for users of Dana and Insight pumps.

- Closed loop will automatically be stopped and switched to open loop mode for the time running extended bolus.
- Bolus units, remaining and total time will be shown on homescreen.
- On Insight pump extended bolus is *not available* if [TBR emulation](#Accu-Chek-Insight-Pump-settings-in-aaps) is used.


### Why extended boluses won't work in a closed loop environment

1. The loop determines that now 1.55U/h is to be delivered. Whether this is delivered as an extended bolus or TBR does not matter to the algorithm. In fact, some of the pumps use the extended bolus. What should happen then? Most pump drivers then stop the extended bolus -> You didn't even need to start it.

2. If you had the extended bolus as input, what should happen in the model?

   1. Should it be considered neutral together with the BR and looped on it? Then the loop should also be able to reduce the bolus if, for example, you get too low and all the "neutral" insulin is taken away?
   2. Should the extended bolus simply be added? So the loop should simply be allowed to continue? Even in the worst hypo? I don't think this is so good: A hypo is foreseen but it must not be prevented?

3. The IOB that the extended bolus builds up materializes after 5 minutes at the next run. Accordingly, the loop would give less basal. So not much changes... except that the possibility of hypo avoidance is taken.
