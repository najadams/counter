// electron-builder config for the VAT build variant.
//
// Reuses the entire base `build` config from package.json and only overrides the
// install identity, so a VAT install and a no-VAT install can coexist on one PC
// and never share a database (distinct appId => distinct userData dir). The
// `${version}` / `${arch}` tokens below are electron-builder placeholders, kept
// as literal JS strings so no shell touches them.
//
// Use with: COUNTER_VAT=1 electron-builder --config electron-builder.vat.cjs ...
// (COUNTER_VAT=1 must also be set for the preceding `vite build`, which bakes the
// VAT logic in via the Vite `define`.)

const base = require('./package.json').build;

module.exports = {
  ...base,
  appId: 'com.counter.pos.vat',
  productName: 'Counter VAT',
  win: {
    ...base.win,
    artifactName: 'Counter-VAT-Setup-${version}-${arch}.${ext}',
  },
  nsis: {
    ...base.nsis,
    shortcutName: 'Counter VAT',
    uninstallDisplayName: 'Counter VAT ${version}',
  },
  mac: {
    ...base.mac,
    artifactName: 'Counter-VAT-${version}-${arch}.${ext}',
  },
  dmg: {
    ...base.dmg,
    title: 'Counter VAT ${version}',
  },
  linux: {
    ...base.linux,
    artifactName: 'Counter-VAT-${version}-${arch}.${ext}',
    desktop: {
      ...(base.linux && base.linux.desktop),
      Name: 'Counter VAT',
      StartupWMClass: 'Counter VAT',
    },
  },
};
