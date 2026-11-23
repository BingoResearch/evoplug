-- HOST migration 0009 (DD-TRG-002), schema major 4.
-- The physical policy rows live in the shared `policy_record` store; the guard
-- keeps a user replacement intact when a fresh home was already seeded by core.
-- Default TriggerPolicy and canonical `bpol/1` budget policy.
--
-- 0008 owns only the trigger_policy schema. This migration installs the
-- default rows with guards: an existing active policy for the global scope or
-- any existing budget (`bpol/1` or active) is preserved unchanged, so a user
-- replacement is never overwritten, and a fresh home gets a real active row
-- instead of an in-memory fallback.

INSERT INTO trigger_policy (
  policy_id, policy_version, scope_key, lifecycle, policy_hash,
  canonical_json, created_at, updated_at
)
SELECT
  'pol:01JXT21Q00G0EACKS8GK8119P3',
  '1.0.0',
  'sha256:6bbdf45b50d580cf4ab77946eb23b2985009d822fc21aa6c7d9dec1715de54a3',
  'active',
  'sha256:37f51c83635047f1bbfa9791ccaa7ea51610c2945ec12929a0b4041af014a821',
  '{"budget":{"budget_policy_ref":"budget://default","require_budget_for_generation":true,"require_budget_for_paid_request":true},"capabilities":{"allow_unverified_auto_review":false,"allow_unverified_online_semantics":false,"profile_version":"cap-gate/1","require_probe_freshness_ms":86400000,"subject":"product_adapter"},"created_at":1750000000000,"lifecycle":"active","online":{"delivery_min_inclusion":"provider_payload","enabled":true,"local_fact_priority":"always_sync","max_remote_checks_per_input":1,"max_remote_checks_per_minute":20,"min_interval_ms":1000,"on_compaction":"refresh_refs","on_input":true,"on_tool_event":"update_only","remote_semantics":"shadow","semantic_merge_window_ms":1000},"origin":{"descendant_suppression":true,"evaluator_suppression":true,"registry_ttl_ms":604800000,"unknown_origin_auto_review":"suppress","unknown_origin_explicit_review":"grant_required","unknown_origin_online_checks":"local_only"},"policy_hash":"sha256:37f51c83635047f1bbfa9791ccaa7ea51610c2945ec12929a0b4041af014a821","policy_id":"pol:01JXT21Q00G0EACKS8GK8119P3","policy_version":"1.0.0","progress":{"enabled":true,"excluded_task_states":["waiting","blocked","paused","cancelled","collection_gap","unknown"],"max_checks_per_window":4,"min_checks":2,"min_span_ms":60000,"on_input_boundary":true,"on_stable_boundary":true,"semantic_compare":"disabled","stall_opens_issue":true,"step_effect_mode":"shadow","window_ms":900000},"review":{"auto":{"enabled":true,"max_auto_jobs_per_task_24h":4,"max_open_jobs_per_task":1,"min_signals":["repeated_correction","reproducible_error","stable_recovery"],"require_stable_boundary":true,"signal_match":"any"},"explicit":{"allowed_when_auto_disabled":true,"enabled":true,"require_grant":true,"unstable_snapshot":"stage_with_gaps"},"mode":"signal_gated","pending":{"defer_max_ms":300000,"on_timeout":"expire_await_explicit","resume_on_verified_stable":true},"signal_policy":{"completion_claim_max_strength":"unverified_claim","repeated_correction":{"min_distinct_events":2,"window_ms":604800000},"reproducible_error":{"min_independent_runs":2,"same_failure_signature":true},"stable_recovery":{"min_consecutive_passes":2,"verified_failure_required":true}}},"schema_version":"rsi.trigger_policy/1","scope":{"scope_kind":"global"},"updated_at":1750000000000}',
  1750000000000,
  1750000000000
WHERE NOT EXISTS (
  SELECT 1 FROM trigger_policy
   WHERE scope_key = 'sha256:6bbdf45b50d580cf4ab77946eb23b2985009d822fc21aa6c7d9dec1715de54a3'
     AND lifecycle = 'active'
);

-- The canonical `bpol/1` row is seeded by `migrations/sql/0001_core.sql` into
-- the shared `policy_record` store.
