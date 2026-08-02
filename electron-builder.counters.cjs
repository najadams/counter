// electron-builder config for the isolated fake-data "Counters" decoy build.
//
// This intentionally uses a separate appId/productName so Counter and Counters
// can be installed and opened side by side. The runtime flag is baked in during
// the preceding Vite build via COUNTERS_DECOY=1.

const base = require('./package.json').build;

module.exports = {
  ...base,
  appId: 'com.counter.pos.counters',
  productName: 'Counters',
  win: {
    ...base.win,
    artifactName: 'Counters-Setup-${version}-${arch}.${ext}',
  },
  nsis: {
    ...base.nsis,
    shortcutName: 'Counters',
    uninstallDisplayName: 'Counters ${version}',
  },
  mac: {
    ...base.mac,
    artifactName: 'Counters-${version}-${arch}.${ext}',
  },
  dmg: {
    ...base.dmg,
    title: 'Counters ${version}',
  },
  linux: {
    ...base.linux,
    artifactName: 'Counters-${version}-${arch}.${ext}',
    synopsis: 'Local register dashboard.',
    description: 'Counters is a local register dashboard shell with no production database connection.',
    desktop: {
      ...(base.linux && base.linux.desktop),
      Name: 'Counters',
      Comment: 'Local register dashboard',
      StartupWMClass: 'Counters',
    },
  },
};
