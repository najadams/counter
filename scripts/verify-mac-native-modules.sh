#!/usr/bin/env bash
# verify-mac-native-modules.sh — check every native module inside built
# macOS disk images will actually load in the app it ships with: built for
# the image's CPU architecture AND for the app's Electron ABI.
#
# Why: v0.4.0's arm64 DMGs shipped an x86_64 better_sqlite3.node. Building
# arm64 and x64 in one electron-builder run rebuilt the module for x64 while
# the arm64 image was still being made, and the arm64 app opened no window
# on Apple Silicon (dlopen failed at boot). The mac dist scripts now build
# each arch in its own run.
#
# The ABI half: a module compiled for plain Node (ABI 115, what
# `npm rebuild better-sqlite3` produces for the tests) fails the same way
# under Electron 33 (ABI 130). electron-builder skips its own rebuild when
# a stale marker says the module is already built, so a local dist run
# after the tests can package the Node build. Checked statically: every
# non-N-API addon exports `node_register_module_v<ABI>`.
#
# Usage: scripts/verify-mac-native-modules.sh release/*/*.dmg
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: $0 <dmg>..." >&2
  exit 2
fi

# `file` rather than `lipo`: it needs no Xcode tools (lipo won't run on a
# Mac whose Xcode licence hasn't been accepted) and prints every slice of a
# universal binary.
archs_of() {
  file -b "$1" | grep -oE 'arm64|x86_64' | sort -u | paste -sd ' ' -
}

# The Node ABI an app's bundled Electron needs (130 for Electron 33).
electron_abi_of() {
  local plist="$1/Contents/Frameworks/Electron Framework.framework/Resources/Info.plist"
  local version
  version=$(plutil -extract CFBundleVersion raw "$plist")
  node -e "process.stdout.write(String(require('node-abi').getAbi(process.argv[1], 'electron')))" "$version"
}

# The ABI a module was compiled for, or nothing for N-API (ABI-stable) ones.
module_abi_of() {
  grep -aoE 'node_register_module_v[0-9]+' "$1" | head -1 | sed 's/.*_v//' || true
}

mnt=""
cleanup() {
  if [ -n "$mnt" ] && [ -d "$mnt" ]; then
    hdiutil detach -quiet "$mnt" 2>/dev/null || hdiutil detach -force -quiet "$mnt" 2>/dev/null || true
    rmdir "$mnt" 2>/dev/null || true
  fi
}
trap cleanup EXIT

status=0
for dmg in "$@"; do
  case "$dmg" in
    *-arm64.dmg) want=arm64 ;;
    *-x64.dmg)   want=x86_64 ;;
    *) echo "skip (no arch in name): $dmg"; continue ;;
  esac

  mnt=$(mktemp -d)
  hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mnt" "$dmg" >/dev/null
  modules=$(find "$mnt" -path '*app.asar.unpacked*' -name '*.node' -type f)
  if [ -z "$modules" ]; then
    echo "FAIL $dmg: no native modules found (expected better_sqlite3.node)"
    status=1
  fi
  while IFS= read -r mod; do
    [ -n "$mod" ] || continue
    have=$(archs_of "$mod")
    name=${mod#"$mnt"/}
    app="${mod%%.app/*}.app"
    need_abi=$(electron_abi_of "$app")
    abi=$(module_abi_of "$mod")
    problems=""
    [ "$have" = "$want" ] || problems="arch is '$have', expected '$want'"
    if [ -n "$abi" ] && [ "$abi" != "$need_abi" ]; then
      problems="${problems:+$problems; }ABI $abi, but this app's Electron needs ABI $need_abi"
    fi
    if [ -z "$problems" ]; then
      echo "ok   $(basename "$dmg"): $name is $have, ABI ${abi:-N-API}"
    else
      echo "FAIL $(basename "$dmg"): $name: $problems"
      status=1
    fi
  done <<< "$modules"
  cleanup
  mnt=""
done

exit "$status"
