-- Typed, tenant-keyed projections used by the HQ intelligence Edge Function.
-- Underlying tables retain default-deny RLS; these security-invoker views add
-- no direct client access and are read only by service-role functions.

create or replace view intelligence_items_central with (security_invoker = on) as
select
  company_id,
  shop_id,
  row_id as intelligence_item_id,
  data->>'fingerprint' as fingerprint,
  coalesce((data->>'episode')::integer, 1) as episode,
  data->>'scope' as scope,
  data->>'model_key' as model_key,
  data->>'model_version' as model_version,
  data->>'category' as category,
  data->>'audience' as audience,
  data->>'severity' as severity,
  data->>'status' as status,
  coalesce((data->>'control_override')::integer, 0) = 1 as control_override,
  data->>'title' as title,
  data->>'recommendation' as recommendation,
  nullif(data->>'cedi_impact_pesewas', '')::bigint as cedi_impact_pesewas,
  coalesce((data->>'confidence_bps')::integer, 0) as confidence_bps,
  data->>'due_at' as due_at,
  data->>'valid_until' as valid_until,
  data->>'source_data_through' as source_data_through,
  coalesce((data->>'evidence_json')::jsonb, '[]'::jsonb) as evidence,
  coalesce((data->>'rationale_json')::jsonb, '{}'::jsonb) as rationale,
  data->>'source_entity_type' as source_entity_type,
  data->>'source_entity_id' as source_entity_id,
  data->>'last_evaluated_at' as last_evaluated_at,
  ingested_at
from shop_events
where table_name = 'intelligence_items';

create or replace view daily_summaries_central with (security_invoker = on) as
select
  company_id,
  shop_id,
  row_id as daily_summary_id,
  data->>'summary_date' as summary_date,
  coalesce((data->>'total_revenue_pesewas')::bigint, 0) as total_revenue_pesewas,
  coalesce((data->>'cash_count_variance_pesewas')::bigint, 0) as cash_count_variance_pesewas,
  nullif(data->>'stocktake_shrinkage_value_pesewas', '')::bigint as stocktake_shrinkage_value_pesewas,
  nullif(data->>'stocktake_shrinkage_rate', '')::double precision as stocktake_shrinkage_rate,
  data->>'generated_at' as generated_at,
  ingested_at
from shop_events
where table_name = 'daily_summaries';
