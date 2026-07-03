// Operator-only: bootstrap a brand-new CLIENT COMPANY and its first shop on the
// central store. This is the ONE gated action in onboarding — anyone with a
// copy of Counter can self-service ADD A BRANCH to a company that already
// exists (Settings -> Sync -> "Add a new branch"), but creating a new company
// is deliberately not exposed in the app: it's a business decision (a new
// paying client), not something the app should let anyone trigger for free.
//
// No DB password needed — this hits the bootstrap-company Edge Function, which
// checks an admin secret you set once via:
//   supabase secrets set PROVISION_ADMIN_SECRET=<random> --project-ref <ref>
//
// Run:
//   PROVISION_ADMIN_SECRET=<secret> PROVISION_CENTRAL_URL=https://<project>.supabase.co/functions/v1/ \
//     npx tsx scripts/provision-company.ts <companyCode> <companyName> <shopId> [HQ|SHOP]
//
// or via the npm script:
//   PROVISION_ADMIN_SECRET=<secret> npm run provision:company -- ACME "Acme Drinks Ltd" OSU HQ

const [companyCode, companyName, shopId, roleArg] = process.argv.slice(2);

if (!companyCode || !companyName || !shopId) {
  console.error(
    'Usage: PROVISION_ADMIN_SECRET=<secret> npm run provision:company -- <companyCode> <companyName> <shopId> [HQ|SHOP]',
  );
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
const role = roleArg === 'SHOP' ? 'SHOP' : 'HQ';

async function main(): Promise<void> {
  const res = await fetch(new URL('bootstrap-company', base), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-secret': adminSecret! },
    body: JSON.stringify({ companyCode, companyName, shopId, role }),
  });
  const body = await res.json() as { error?: string; token?: string };
  if (!res.ok || !body.token) {
    console.error(`Bootstrap failed (HTTP ${res.status}): ${body.error ?? 'unknown error'}`);
    process.exit(1);
  }

  console.log(`Company "${companyCode}" (${companyName}) created, first shop "${shopId}" (${role}).`);
  console.log('');
  console.log('Copy these into that shop\'s Settings -> Sync now — the token will not be shown again:');
  console.log('');
  console.log(`  Shop code / id : ${shopId}`);
  console.log(`  Central URL    : ${base}`);
  console.log(`  Role           : ${role === 'HQ' ? 'HQ (owns the catalog)' : 'Shop (sells; pulls catalog)'}`);
  console.log(`  Sync token     : ${body.token}`);
  console.log('');
  console.log('Restart Counter on that install after saving for the sync worker to start.');
}

void main();
