-- evoplug schema major 4. Raises review_generate output headroom to 64k so a
-- long reasoning answer is not cut off mid-JSON; the wall budget stays 10 min.
-- evoplug:directive:begin
-- evoplug:schema_major=4
-- evoplug:schema_minor=0
-- evoplug:directive:end
UPDATE policy_record
   SET body_json = json_object(
         'policy_version', 'bpol/1',
         'canonical_json', '{"concurrency":{"burst":3,"cooldown_base_ms":5000,"cooldown_max_ms":300000,"global_inflight":2,"per_scope_inflight":1,"rpm":30,"unknown_limit_inflight":1,"unknown_limit_rpm":6},"policy_version":"bpol/1","reservation_ttl_ms":120000,"schema_version":"rsi.budget_policy/1","scopes":[{"attempt_charge_at":"claim","attempt_refundable":false,"max_attempts":2,"max_cost_micros":100000,"max_input_tokens":32768,"max_output_tokens":2048,"min_work_ms":100,"purpose":"judge","question_margin_tokens":512,"question_max_tokens":32000,"request_margin_tokens":2048,"request_max_tokens":64000,"reserve_ms":150,"wall_ms":5000},{"attempt_charge_at":"claim","attempt_refundable":false,"max_attempts":3,"max_cost_micros":500000,"max_input_tokens":65536,"max_output_tokens":65536,"min_work_ms":1000,"purpose":"review_generate","question_margin_tokens":512,"question_max_tokens":32768,"request_margin_tokens":2048,"request_max_tokens":131072,"reserve_ms":1500,"wall_ms":600000},{"attempt_charge_at":"claim","attempt_refundable":false,"max_attempts":3,"max_cost_micros":100000,"max_input_tokens":32768,"max_output_tokens":4096,"min_work_ms":200,"purpose":"review_match","question_margin_tokens":256,"question_max_tokens":16384,"request_margin_tokens":1024,"request_max_tokens":32768,"reserve_ms":300,"wall_ms":30000},{"attempt_charge_at":"claim","attempt_refundable":false,"max_attempts":2,"max_cost_micros":200000,"max_input_tokens":65536,"max_output_tokens":4096,"min_work_ms":500,"purpose":"verifier","question_margin_tokens":512,"question_max_tokens":32768,"request_margin_tokens":2048,"request_max_tokens":65536,"reserve_ms":1000,"wall_ms":120000},{"attempt_charge_at":"claim","attempt_refundable":false,"max_attempts":1,"max_cost_micros":200000,"max_input_tokens":65536,"max_output_tokens":8192,"min_work_ms":300,"purpose":"egress_other","question_margin_tokens":512,"question_max_tokens":32768,"request_margin_tokens":2048,"request_max_tokens":65536,"reserve_ms":500,"wall_ms":120000}],"unknown_cost":"block_paid","unknown_provider_limit":"local_guard"}',
         'content_hash', 'sha256:555a4f336ec5d31e023108dd75aa33a03cd7b2a577a8ae3828dafa7ab5d53890',
         'active', 1,
         'created_at', 1750000000000
       )
 WHERE row_key = 'budget_policy:bpol/1';
