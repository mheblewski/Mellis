/**
 * Every threshold of settings insights in one versioned object (v5 §7–§11). A proposal and a check store the version
 * they were made with, so a result can be reproduced after the thresholds change. Change a value = bump the version.
 */
export const SETTINGS_INSIGHTS_THRESHOLDS = {
  // v3: highs starting within 4 h after a meal / unknown carbs no longer count toward the basal/target/ISF early stop.
  version: 'settings-insights.thresholds.v4',

  analysisDays: 14,
  /** Night = 00:00–06:00 local. */
  nightEndMinute: 360,

  data: {
    /** A night or block counts with at least this share of 5-minute sensor slots. */
    minSensorCoverage: 0.7,
    /** Analysis pauses when the loop ran (a cycle in the slot) less than this share of the period. */
    minLoopCoverage: 0.8,
    /** More excluded days than this share → "Za mało zwykłych dni", no proposal. */
    maxExcludedDayShare: 0.3,
    /** Overrides on more nights than this → analyse effective settings and say so. */
    habitualOverrideNightShare: 0.3,
    /** A finding must hold in both halves of the window. */
    requireBothHalves: true,
    /** Same weekday holds this many of the lows (and at least 3) → paused, the chat asks about that day. */
    weekdayClusterShare: 0.75,
    weekdayClusterMin: 3,
    /** A note added this long after a night of a check only flags it. */
    lateNoteHours: 48,
  },

  confidence: {
    minSituations: 5,
    good: { minN: 8, minConsistency: 0.7, maxStep: 0.2 },
    moderate: { minN: 5, step: 0.1 },
  },

  basal: {
    /** A qualifying night: bolus + SMB insulin still active at the block start below this (U). */
    qualifyingIobBelow: 0.3,
    /** Type B (cause earlier): a low with at least this much bolus + SMB in the 4 h before. */
    typeBInsulinAbove: 0.5,
    typeBLookbackMinutes: 240,
    /** Lower when the loop delivered less than this share of the profile basal … */
    lowerWhenDeliveredBelow: 0.6,
    maxTypeBNights: 2,
    /** … and there are lows: lows on at least this many nights of the window, or this share of time < 70. */
    lowsMinNights: 3,
    lowsMinTimeShare: 0.04,
    /** Raise when delivered above this share with SMBs and no lows in the hour + 2 h. */
    raiseWhenDeliveredAbove: 1.5,
    /** Never propose going down to this rate (it zeroes the SMB cap). */
    forbiddenLowerTarget: 0.05,
    /** Very small basal: doubling allowed only after the advanced lever (or at night when it is blocked by day lows). */
    tinyBasal: 0.05,
    /**
     * Owner decision 2026-10-31: where a gate asked for zero lows (tiny-basal doubling in block + 3 h, the advanced
     * lever's guarded hours), at most this many lows per window of 14 nights, each no longer than maxMinutes and never
     * below minValue. A second, longer or deeper low still blocks.
     */
    lowsAllowance: { maxEpisodes: 1, maxMinutes: 30, minValue: 54 },
  },

  carbRatio: {
    // v4 (2026-11-01, literature: ≥ 5 meals of a meal time; Tyler 2020, NHS Tayside).
    minMeals: 5,
    maxDays: 21,
    minRelativeDifference: 0.1,
    correctionCarbsMaxGrams: 10,
    correctionCarbsAboveMgdl: 180,
    rescueBelowMgdl: 80,
    rescueFallingBelowMgdl: 100,
    // v4: the glucose change from start to end is accounted for (÷ ISF), so the end may differ more (calibration
    // 2026-11-01: 50 → 80 kept the same direction and size of the median, with half again as many meals).
    endWithinMgdl: 80,
    /** v4 (diabetologist review): a weaker ICR at most 15 % per step — where the SMB cap is below a pump step the loop
     * cannot make up a too-weak ratio. */
    maxLessStep: 0.15,
    outcomeMinutes: 240,
  },

  sensitivity: { minCorrections: 5, cleanCarbHours: 3 },

  target: { step: 10, floor: 100, minThresholdShareOfBlocks: 0.6 },

  advanced: {
    maxUamSmbMinutesFrom: 30,
    maxUamSmbMinutesTo: 60,
    maxIobBindingBelowShare: 0.2,
  },

  lowGuard: { blocksAtBgAbove: 200, dominantInputShare: 0.6 },

  safetyGates: { tbr70MaxShare: 0.04, tbr54MaxShare: 0.01 },

  evaluation: {
    validNights: 14,
    /** v4: a meal-time ICR change ends after this many days with a meal of that time (at least icrMinDays days). */
    icrMeals: 10,
    icrMinDays: 7,
    maxDays: 21,
    hardLimitDaysFromFirstChange: 35,
    maxRestarts: 1,
    blockBufferMinutes: 180,
    mealWindowMinutes: 240,
    effect: { maxLowNightsOf14: 1, minTarDropPoints: 0.05 },
    /** v2 (calibration 2026-10-31): TBR 24 h may not rise by more than 1 point over the patient's own baseline (the
     * absolute 4 % cap made every check of a patient above 4 % fail on noise). TAR may rise by 8 points after less insulin
     * (5 failed 16 % of unchanged weeks; a mild rise is the expected price of fewer lows). */
    safety: { maxTarIncreasePoints: 0.08, maxMedianRiseAt7: 20, tbr24TolerancePoints: 0.01 },
  },

  earlyStop: {
    /** v2: every count is relative to the 14 days before the change: it fires at max(absolute, baseline per 7 days +
     * margin) events in any 7 days, so a patient who already had lows there is not stopped by the same lows. With no
     * such events before (the usual case: more insulin is proposed only where there were no lows) it is the absolute. */
    moreInsulin: { below54Minutes: 15, lowNightsIn7: 2, lowMargin: 2, below54Margin: 1 },
    lessInsulin: { above250LongMinutes: 120, above250ShortMinutes: 60, above250ShortNights: 2, longMargin: 1, shortMargin: 2 },
    tinyBasalDoubling: { below54Minutes: 15, below70Minutes: 30 },
    /** Pushes for early stops wait until this local hour unless severe. */
    morningHour: 7,
  },

  history: {
    blockSameDirectionDays: 90,
    noFlipFlopDays: 60,
    expiresDays: 180,
  },

  proposal: {
    minDaysSinceLastChange: 14,
    /** After a rollback the same proposal may return only from nights after it; counting starts after this many. */
    afterRollbackStartNights: 7,
  },
} as const;

export type SettingsInsightsThresholds = typeof SETTINGS_INSIGHTS_THRESHOLDS;
