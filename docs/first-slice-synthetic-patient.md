# First Slice Synthetic Patient

This fixture is used for first-vertical-slice verification and contains synthetic, non-real data only.

## Patient Profile

- Child with type 1 diabetes
- Hypo event: confirmed
- Glucose at event: 68 mg/dL
- Glucose trend: unknown / falling context handled by the slice
- IOB: 0.8 U
- Recent insulin: 1.5 U rapid-acting insulin at 2026-09-16T19:20:00.000Z
- Activity context: UNKNOWN
- Meal context: UNKNOWN

## Purpose

The fixture is designed to drive the complete path:

Nightscout -> source record -> hypo detection -> trigger -> ContextPackage -> AI task -> conversation/question -> push notification -> iOS open -> UNKNOWN answer -> follow-up analysis -> recommendation

It is intentionally minimal and deterministic so the same flow can be verified repeatedly.
