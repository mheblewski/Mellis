export function buildHistoricalTherapySemanticsInstructions(): string[] {
  return [
    'Historical therapy semantics are strict: treat legacy therapy_reference fields (for example: cr, isf, basal, profile_version, dia, target) as source snapshot/context values only.',
    'Do not treat legacy therapy_reference field presence as confirmation that therapy was historically valid at the event time.',
    'A historical ICR may be described as confirmed-at-event-time only when historical_icr_status is explicitly CONFIRMED.',
    'Treat historical_icr_status values UNVERIFIED, NO_DATA, CONFLICTING, missing, or unknown as NOT_CONFIRMED for historical validity.',
    'snapshot_icr.status RESOLVED_FROM_SNAPSHOT means the value was resolved from a snapshot, not that profile validity at event time was proven.',
    'If legacy therapy_reference values are mentioned, explicitly state they come from source context/snapshot and may be historically unverified.',
    'Therapy uncertainty must not block analysis of other available evidence domains (glucose, insulin, meal, activity, and other sections).',
  ];
}

export function buildHistoricalTherapySemanticsPayloadContract(): Record<string, unknown> {
  return {
    contract_version: 'historical-therapy-semantics.v1',
    legacy_therapy_reference_is_not_historical_confirmation: true,
    historical_icr_confirmation_requires_explicit_confirmed_status: true,
    treat_unverified_no_data_conflicting_missing_unknown_as_not_confirmed: true,
    snapshot_resolution_is_not_event_time_validity_proof: true,
    keep_other_evidence_domains_active_even_if_therapy_uncertain: true,
  };
}
