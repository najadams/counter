// electron-builder config for the "Counter Friendly" build variant.
//
// Same app, same rules — only the renderer differs (large illustrated buttons,
// simple wording, on-screen number pads; see FRIENDLY_UI_ENABLED in
// src/shared/lib/buildFlags.ts). Like the VAT variant it reuses the base
// `build` config and overrides only the install identity, so it installs beside
// the standard Counter with its own userData dir and database.
//
// Use with: COUNTER_FRIENDLY=1 electron-builder --config electron-builder.friendly.cjs ...
// (COUNTER_FRIENDLY=1 must also be set for the preceding `vite build`, which
// bakes the flag in via the Vite `define`.)

const base = require('./package.json').build;

module.exports = {
  ...base,
  appId: 'com.counter.pos.friendly',
  productName: 'Counter Friendly',
  win: {
    ...base.win,
    artifactName: 'Counter-Friendly-Setup-${version}-${arch}.${ext}',
  },
  nsis: {
    ...base.nsis,
    shortcutName: 'Counter Friendly',
    uninstallDisplayName: 'Counter Friendly ${version}',
  },
  mac: {
    ...base.mac,
    artifactName: 'Counter-Friendly-${version}-${arch}.${ext}',
  },
  dmg: {
    ...base.dmg,
    title: 'Counter Friendly ${version}',
  },
  linux: {
    ...base.linux,
    artifactName: 'Counter-Friendly-${version}-${arch}.${ext}',
    desktop: {
      ...(base.linux && base.linux.desktop),
      Name: 'Counter Friendly',
      StartupWMClass: 'Counter Friendly',
    },
  },
};
