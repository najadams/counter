// Operator-only: mint a bearer token for a WhatsApp order agent belonging to
// an EXISTING client company. Same trust model as provision-company.ts — the
// company must already be bootstrapped; this only ever adds an agent under a
// company that already exists, so it's a lighter gate than bootstrap-company
// but still admin-secret gated (an agent token is create-orders + read-catalog
// access, not something to hand out self-service).
//
// No DB password needed — this hits the register-agent Edge Function, which
// checks the same admin secret as bootstrap-company:
//   supabase secrets set PROVISION_ADMIN_SECRET=<random> --project-ref <ref>
//
// Run:
//   PROVISION_ADMIN_SECRET=<secret> PROVISION_CENTRAL_URL=https://<project>.supabase.co/functions/v1/ \
//     npx tsx scripts/provision-agent.ts <companyCode> <agentId>
//
// or via the npm script:
//   PROVISION_ADMIN_SECRET=<secret> npm run provision:agent -- ACME order-agent-prod

// Scopes this file as a module rather than a global script, so its top-level
// declarations (companyCode, adminSecret, etc.) don't collide with the same
// names in provision-company.ts under `tsc -b`'s whole-program check. No
// runtime effect — tsx transpiles each script file independently regardless.
export {};

const [companyCode, agentId] = process.argv.slice(2);

if (!companyCode || !agentId) {
  console.error('Usage: PROVISION_ADMIN_SECRET=<secret> npm run provision:agent -- <companyCode> <agentId>');
  process.exit(1);
}

const adminSecret = process.env['PROVISION_ADMIN_SECRET'];
if (!adminSecret) {
  console.error('PROVISION_ADMIN_SECRET is not set. Get it from wherever you stored it when you ran `supabase secrets set`.');
  process.exit(1);
}

const centralUrl = process.env['PROVISION_CENTRAL_URL']
  ?? 'https://pakfonjgxcnxdkgpuafg.supabase.co/functions/v1/';
const base = centralUrl.endsWith('/') ? centralUrl : `${centralUrl}/`;

async function main(): Promise<void> {
  const res = await fetch(new URL('register-agent', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-secret': adminSecret! },
    body: JSON.stringify({ companyCode, agentId }),
  });
  const body = await res.json() as { error?: string; token?: string };
  if (!res.ok || !body.token) {
    console.error(`Agent registration failed (HTTP ${res.status}): ${body.error ?? 'unknown error'}`);
    process.exit(1);
  }

  console.log(`Agent "${agentId}" registered for company "${companyCode}".`);
  console.log('');
  console.log('Copy this into that agent instance\'s config now — the token will not be shown again:');
  console.log('');
  console.log(`  Agent id     : ${agentId}`);
  console.log(`  Central URL  : ${base}`);
  console.log(`  Agent token  : ${body.token}`);
  console.log('');
  console.log('Set AGENT_CENTRAL_URL and AGENT_TOKEN in the counter-agent deployment and restart it.');
  console.log('To revoke this token later, run the same command again with a NEW agentId, or');
  console.log('revoke this one via: select revoke_agent(\'' + companyCode + '\', \'' + agentId + '\');');
}

void main();
