// electron-builder afterPack hook.
//
// Why this exists: the CI mac build is unsigned (no Apple Developer cert), and
// on Apple Silicon the kernel refuses to launch an arm64 app that carries NO
// signature at all — Finder reports it as "damaged and can't be opened." An
// ad-hoc signature (codesign --sign -) is enough to make the OS run it; the
// user still clears Gatekeeper quarantine once on first open, but the app is no
// longer treated as corrupt.
//
// We sign in afterPack (not afterSign) because afterSign only fires when
// electron-builder did its own signing, which it doesn't here. afterPack runs
// after the .app is assembled and before the .dmg is built, so the dmg ships a
// signed app. No-op on Windows/Linux.

const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);

  // Ad-hoc deep sign. --deep re-signs the bundled Electron frameworks and
  // helper apps; the empty identity "-" means ad-hoc (no certificate).
  console.log(`[after-pack] ad-hoc signing ${appPath}`);
  execFileSync(
    'codesign',
    ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath],
    { stdio: 'inherit' },
  );

  // Sanity check: fail the build loudly if the signature didn't take, rather
  // than shipping another "damaged" dmg.
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], {
    stdio: 'inherit',
  });
  console.log('[after-pack] signature verified');
};
