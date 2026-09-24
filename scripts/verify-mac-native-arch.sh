#!/usr/bin/env bash
# verify-mac-native-arch.sh — check every native module inside built macOS
# disk images matches the image's architecture.
#
# Why: v0.4.0's arm64 DMGs shipped an x86_64 better_sqlite3.node. Building
# arm64 and x64 in one electron-builder run rebuilt the module for x64 while
# the arm64 image was still being made, and the arm64 app opened no window
# on Apple Silicon (dlopen failed at boot). The mac dist scripts now build
# each arch in its own run; this check fails the release if it ever
# regresses.
#
# Usage: scripts/verify-mac-native-arch.sh release/*/*.dmg
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
    if [ "$have" = "$want" ]; then
      echo "ok   $(basename "$dmg"): $name is $have"
    else
      echo "FAIL $(basename "$dmg"): $name is '$have', expected '$want'"
      status=1
    fi
  done <<< "$modules"
  cleanup
  mnt=""
done

exit "$status"
