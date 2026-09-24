#!/usr/bin/env node
// Guard for the plain-Node dev scripts (serve:lan and friends).
//
// better-sqlite3 is a native module, so one compiled copy serves exactly one
// ABI. This repo has three consumers that disagree:
//
//   npm run dev        Electron   (ABI 130 for Electron 33)
//   npm test           plain Node (ABI 115 for Node 20)
//   npm run serve:lan  plain Node (ABI 115 for Node 20)
//
// Whichever ran last wins, and the loser crashes deep inside dlopen with a
// stack that points at bindings.js and says nothing about which command to
// run. That crash is also easy to misread: require('better-sqlite3') alone
// does NOT load the binary — the load happens when a Database is constructed,
// which is why a bare require appears to succeed.
//
// So: construct one, and translate the failure into the fix.

const ABI_NAMES = {
  108: 'Node 18',
  115: 'Node 20',
  118: 'Node 21',
  127: 'Node 22',
  130: 'Electron 33',
  137: 'Electron 35',
};

const describe = (abi) => (ABI_NAMES[abi] ? `${ABI_NAMES[abi]}, ABI ${abi}` : `ABI ${abi}`);

try {
  const Database = require('better-sqlite3');
  new Database(':memory:').close();
  process.exit(0);
} catch (err) {
  const message = String(err && err.message ? err.message : err);
  const compiledFor = Number((message.match(/using\s+NODE_MODULE_VERSION (\d+)/) || [])[1]);
  const needs = Number((message.match(/requires\s+NODE_MODULE_VERSION (\d+)/) || [])[1]);

  if (!compiledFor || !needs) {
    console.error('\nbetter-sqlite3 could not be loaded:\n');
    console.error(`  ${message}\n`);
    process.exit(1);
  }

  const running = `${process.version} (${describe(needs)})`;
  console.error('\n  better-sqlite3 is built for a different runtime than the one running this script.\n');
  console.error(`    built for   ${describe(compiledFor)}`);
  console.error(`    running     ${running}\n`);

  if (compiledFor === 115 && needs === 108) {
    console.error('  You are on Node 18. This repo needs Node 20 (engines.node is ">=20"):\n');
    console.error('    nvm use 20 && npm run serve:lan\n');
  } else if (compiledFor >= 130) {
    console.error('  The module is currently built for Electron, so `npm run dev` works but');
    console.error('  plain-Node scripts do not. To switch it over:\n');
    console.error('    npm rebuild better-sqlite3\n');
    console.error('  and to switch back for `npm run dev` afterwards:\n');
    console.error('    npx electron-builder install-app-deps\n');
  } else {
    console.error('  Rebuild it for the runtime you want:\n');
    console.error('    npm rebuild better-sqlite3            # plain Node (tests, serve:lan)');
    console.error('    npx electron-builder install-app-deps # Electron (npm run dev)\n');
  }
  process.exit(1);
}
