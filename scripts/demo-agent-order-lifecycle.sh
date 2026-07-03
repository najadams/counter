#!/usr/bin/env bash
# Demonstrates the full WhatsApp order agent lifecycle end-to-end against a
# real (staging or dev) Supabase project: register an agent, search the
# catalog, check availability, create a quote, confirm it, and read it back.
# This is workstream A's "definition of done" from
# docs/phase4-whatsapp-order-agent.md §A6 — run it after applying the
# 20260702130000_agent_orders.sql migration and deploying the agent,
# orders-feed, and register-agent Edge Functions.
#
# Prereqs:
#   - A company + at least one shop already provisioned:
#       PROVISION_ADMIN_SECRET=<secret> npm run provision:company -- ACME "Acme Drinks Ltd" OSU HQ
#   - That shop has synced its catalog up at least once (so shop_events has
#     'products'/'product_units' rows for the HQ shop) — run Counter against
#     this project and let a sync cycle complete, or seed test rows directly
#     for a dry run against a project with no real shop yet.
#   - `jq` installed.
#
# Usage:
#   PROVISION_ADMIN_SECRET=<secret> \
#   CENTRAL_URL=https://<project>.supabase.co/functions/v1/ \
#   COMPANY_CODE=ACME SHOP_ID=OSU \
#     ./scripts/demo-agent-order-lifecycle.sh
#
# PRODUCT_ID/UNIT_ID are optional — if omitted, the script picks the first
# product/unit returned by a catalog search.

set -euo pipefail

command -v jq >/dev/null 2>&1 || { echo "jq is required (brew install jq / apt install jq)"; exit 1; }

: "${PROVISION_ADMIN_SECRET:?Set PROVISION_ADMIN_SECRET}"
: "${COMPANY_CODE:?Set COMPANY_CODE (e.g. ACME)}"
: "${SHOP_ID:?Set SHOP_ID (e.g. OSU) — must already be provisioned under COMPANY_CODE}"
CENTRAL_URL="${CENTRAL_URL:-https://pakfonjgxcnxdkgpuafg.supabase.co/functions/v1/}"
CENTRAL_URL="${CENTRAL_URL%/}/"
AGENT_ID="${AGENT_ID:-demo-agent-$(date +%s)}"
CUSTOMER_PHONE="${CUSTOMER_PHONE:-+233555000999}"

echo "== 1. Register a throwaway agent ($AGENT_ID) =="
REGISTER_RESP=$(curl -sS -X POST "${CENTRAL_URL}register-agent" \
  -H "content-type: application/json" -H "x-admin-secret: ${PROVISION_ADMIN_SECRET}" \
  -d "{\"companyCode\":\"${COMPANY_CODE}\",\"agentId\":\"${AGENT_ID}\"}")
echo "$REGISTER_RESP" | jq .
AGENT_TOKEN=$(echo "$REGISTER_RESP" | jq -r '.token')
if [ "$AGENT_TOKEN" = "null" ] || [ -z "$AGENT_TOKEN" ]; then
  echo "Registration failed — see error above." >&2
  exit 1
fi

auth() { curl -sS -H "authorization: Bearer ${AGENT_TOKEN}" "$@"; }

echo
echo "== 2. Search the catalog =="
CATALOG_RESP=$(auth "${CENTRAL_URL}agent/v1/catalog?limit=5")
echo "$CATALOG_RESP" | jq .

PRODUCT_ID="${PRODUCT_ID:-$(echo "$CATALOG_RESP" | jq -r '.products[0].productId // empty')}"
if [ -z "$PRODUCT_ID" ]; then
  echo "No products in the catalog for this shop's HQ yet — sync Counter's catalog up first, or seed test rows." >&2
  exit 1
fi
UNIT_ID="${UNIT_ID:-$(echo "$CATALOG_RESP" | jq -r --arg pid "$PRODUCT_ID" '.products[] | select(.productId == $pid) | .units[0].unitId // empty')}"
echo "Using productId=${PRODUCT_ID} unitId=${UNIT_ID:-<canonical>}"

echo
echo "== 3. Check availability =="
AVAIL_URL="${CENTRAL_URL}agent/v1/availability?shopId=${SHOP_ID}&productId=${PRODUCT_ID}&qty=1"
[ -n "$UNIT_ID" ] && AVAIL_URL="${AVAIL_URL}&unitId=${UNIT_ID}"
auth "$AVAIL_URL" | jq .

echo
echo "== 4. Create a quote (order) =="
if [ -n "$UNIT_ID" ]; then
  LINE="{\"productId\":\"${PRODUCT_ID}\",\"unitId\":\"${UNIT_ID}\",\"quantity\":1}"
else
  LINE="{\"productId\":\"${PRODUCT_ID}\",\"quantity\":1}"
fi
ORDER_RESP=$(auth -X POST "${CENTRAL_URL}agent/v1/orders" \
  -H "content-type: application/json" \
  -d "{\"shopId\":\"${SHOP_ID}\",\"customerPhone\":\"${CUSTOMER_PHONE}\",\"customerName\":\"Demo customer\",\"lines\":[${LINE}],\"idempotencyKey\":\"demo-$(date +%s)\"}")
echo "$ORDER_RESP" | jq .
ORDER_ID=$(echo "$ORDER_RESP" | jq -r '.id')
if [ "$ORDER_ID" = "null" ] || [ -z "$ORDER_ID" ]; then
  echo "Order creation failed — see error above." >&2
  exit 1
fi
echo "Created order ${ORDER_ID}, status $(echo "$ORDER_RESP" | jq -r '.status')"

echo
echo "== 5. Confirm the order =="
auth -X POST "${CENTRAL_URL}agent/v1/orders/${ORDER_ID}/confirm" | jq .

echo
echo "== 6. Read it back =="
auth "${CENTRAL_URL}agent/v1/orders/${ORDER_ID}" | jq .

echo
echo "== 7. Confirming again should now conflict (already CONFIRMED) =="
CONFLICT_STATUS=$(auth -o /dev/null -w '%{http_code}' -X POST "${CENTRAL_URL}agent/v1/orders/${ORDER_ID}/confirm")
echo "HTTP ${CONFLICT_STATUS} (expect 409)"

echo
echo "Done. Revoke this demo agent when finished:"
echo "  select revoke_agent('${COMPANY_CODE}', '${AGENT_ID}');"
