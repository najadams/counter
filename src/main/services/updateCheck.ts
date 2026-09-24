// Is there a newer Counter than the one running?
//
// Asked of the project's public GitHub releases, from the main process only
// (the renderer's CSP allows no outside requests). The request carries nothing
// about the shop: GitHub sees an IP address and "Counter/<version>". A till is
// often offline, so a failed check is quiet: the last good answer is kept in
// <userData>/last_update_check.json and shown with its time. Nothing is
// downloaded or installed here; the owner fetches the installer from the
// release page and runs it (CLAUDE.md §16).
//
// COUNTER_UPDATE_CHECK=0 turns the network check off (an air-gapped shop).

import fs from 'node:fs';
import path from 'node:path';

export const RELEASES_API = 'https://api.github.com/repos/najadams/counter/releases/latest';
export const RELEASES_PAGE = 'https://github.com/najadams/counter/releases';
const CACHE_FILE = 'last_update_check.json';
const FIRST_CHECK_DELAY_MS = 20_000;
const CHECK_EVERY_MS = 12 * 60 * 60 * 1000;
const NOTES_MAX_CHARS = 800;

export type Edition = 'STANDARD' | 'VAT' | 'FRIENDLY' | 'COUNTERS';

export interface UpdateInfo {
  status: 'UP_TO_DATE' | 'AVAILABLE' | 'UNKNOWN';
  currentVersion: string;
  latestVersion: string | null;
  releasedAt: string | null;
  /** Always a page under RELEASES_PAGE. */
  releaseUrl: string | null;
  /** The installer for this edition and computer, when the release has one. */
  installerName: string | null;
  /** The start of the release notes, as plain text. */
  notes: string | null;
  /** When a check last succeeded. */
  checkedAt: string | null;
  /** Why the most recent attempt failed, when it did. */
  error: string | null;
}

export interface UpdateCheckConfig {
  currentVersion: string;
  edition: Edition;
  platform: NodeJS.Platform;
  arch: string;
  userDataDir: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/** Numeric x.y.z comparison; a leading "v" and any "-suffix" are ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.replace(/^v/i, '').split('-')[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

const PREFIX: Record<Edition, string> = {
  STANDARD: 'Counter', VAT: 'Counter-VAT', FRIENDLY: 'Counter-Friendly', COUNTERS: 'Counters',
};

/** The file a release publishes for this edition on this computer (see the
 *  artifactName patterns in package.json and electron-builder.*.cjs). */
export function installerNameFor(edition: Edition, platform: NodeJS.Platform, arch: string, version: string): string | null {
  const prefix = PREFIX[edition];
  if (platform === 'win32') return `${prefix}-Setup-${version}-x64.exe`;
  if (platform === 'darwin') return `${prefix}-${version}-${arch === 'arm64' ? 'arm64' : 'x64'}.dmg`;
  if (platform === 'linux') return `${prefix}-${version}-x86_64.AppImage`;
  return null;
}

interface GithubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  body?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  assets?: Array<{ name?: unknown }>;
}

/** Turn GitHub's "latest release" answer into what the till shows. */
export function describeRelease(release: GithubRelease, config: UpdateCheckConfig, checkedAt: string): UpdateInfo {
  const tag = typeof release.tag_name === 'string' ? release.tag_name : '';
  const latest = tag.replace(/^v/i, '');
  if (!/^\d+\.\d+\.\d+/.test(latest) || release.draft === true || release.prerelease === true) {
    throw new Error('the latest release has no usable version');
  }
  const url = typeof release.html_url === 'string' && release.html_url.startsWith(`${RELEASES_PAGE}/`)
    ? release.html_url
    : RELEASES_PAGE;
  const wanted = installerNameFor(config.edition, config.platform, config.arch, latest);
  const names = new Set((release.assets ?? []).map((a) => (typeof a.name === 'string' ? a.name : '')));
  const body = typeof release.body === 'string' ? release.body.trim() : '';
  return {
    status: compareVersions(latest, config.currentVersion) > 0 ? 'AVAILABLE' : 'UP_TO_DATE',
    currentVersion: config.currentVersion,
    latestVersion: latest,
    releasedAt: typeof release.published_at === 'string' ? release.published_at : null,
    releaseUrl: url,
    installerName: wanted && names.has(wanted) ? wanted : null,
    notes: body ? (body.length > NOTES_MAX_CHARS ? `${body.slice(0, NOTES_MAX_CHARS).trimEnd()}…` : body) : null,
    checkedAt,
    error: null,
  };
}

/** One check against GitHub. Never throws: a failure comes back as UNKNOWN
 *  with the reason, carrying the last good answer if there is one. */
export async function checkForUpdate(config: UpdateCheckConfig, previous: UpdateInfo | null = null): Promise<UpdateInfo> {
  const now = (config.now ?? (() => new Date()))();
  const doFetch = config.fetchImpl ?? fetch;
  try {
    const res = await doFetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `Counter/${config.currentVersion}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    return describeRelease(await res.json() as GithubRelease, config, now.toISOString());
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return previous
      ? { ...restate(previous, config.currentVersion), error: reason }
      : {
          status: 'UNKNOWN', currentVersion: config.currentVersion, latestVersion: null, releasedAt: null,
          releaseUrl: null, installerName: null, notes: null, checkedAt: null, error: reason,
        };
  }
}

/** A stored answer, re-read against the version now running (the shop may
 *  have installed the update since it was stored). */
function restate(info: UpdateInfo, currentVersion: string): UpdateInfo {
  const status = info.latestVersion
    ? (compareVersions(info.latestVersion, currentVersion) > 0 ? 'AVAILABLE' : 'UP_TO_DATE')
    : 'UNKNOWN';
  return { ...info, status, currentVersion };
}

export function readCachedUpdate(userDataDir: string, currentVersion: string): UpdateInfo | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(userDataDir, CACHE_FILE), 'utf8')) as UpdateInfo;
    return raw && typeof raw === 'object' && 'status' in raw ? restate(raw, currentVersion) : null;
  } catch {
    return null;
  }
}

function writeCachedUpdate(userDataDir: string, info: UpdateInfo): void {
  try {
    fs.writeFileSync(path.join(userDataDir, CACHE_FILE), JSON.stringify(info, null, 2));
  } catch {
    // A read-only or full disk only costs the offline memory of the answer.
  }
}

// --- the running till's state ---------------------------------------------

let config: UpdateCheckConfig | null = null;
let latest: UpdateInfo | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

export function updateChecksEnabled(): boolean {
  return process.env['COUNTER_UPDATE_CHECK'] !== '0';
}

/** What the till knows now: the last check (this run, or stored), or nothing. */
export function currentUpdateInfo(): UpdateInfo | null {
  if (!config) return null;
  latest = latest ? restate(latest, config.currentVersion) : readCachedUpdate(config.userDataDir, config.currentVersion);
  return latest ?? {
    status: 'UNKNOWN', currentVersion: config.currentVersion, latestVersion: null, releasedAt: null,
    releaseUrl: null, installerName: null, notes: null, checkedAt: null,
    error: updateChecksEnabled() ? null : 'Update checks are turned off on this till',
  };
}

/** Check now (the Settings button). Keeps the last good answer on failure. */
export async function checkForUpdateNow(): Promise<UpdateInfo | null> {
  if (!config) return null;
  if (!updateChecksEnabled()) return currentUpdateInfo();
  const result = await checkForUpdate(config, currentUpdateInfo());
  latest = result;
  if (!result.error) writeCachedUpdate(config.userDataDir, result);
  return result;
}

/** Remember what is running and where to keep the answer. The handlers need
 *  this even where nothing checks on a timer (tests, the LAN preview). */
export function configureUpdateChecks(cfg: UpdateCheckConfig): void {
  config = cfg;
  latest = null;
}

/** Unless turned off, check shortly after start and twice a day. Returns a
 *  stop function. Call configureUpdateChecks first. */
export function startUpdateChecks(onResult?: (info: UpdateInfo) => void): () => void {
  if (!config || !updateChecksEnabled()) return () => {};
  const run = async () => {
    const info = await checkForUpdateNow();
    if (info) onResult?.(info);
    timer = setTimeout(() => void run(), CHECK_EVERY_MS);
    timer.unref?.();
  };
  timer = setTimeout(() => void run(), FIRST_CHECK_DELAY_MS);
  timer.unref?.();
  return () => { if (timer) clearTimeout(timer); timer = null; };
}

/** Test hook: forget the running till's state. */
export function _resetUpdateChecks(): void {
  if (timer) clearTimeout(timer);
  config = null; latest = null; timer = null;
}
