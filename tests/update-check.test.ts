// Update notice: comparing versions, reading GitHub's latest release, keeping
// the last answer offline, and opening the download page on the shop PC only.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RELEASES_PAGE, _resetUpdateChecks, checkForUpdate, checkForUpdateNow, compareVersions,
  configureUpdateChecks, currentUpdateInfo, describeRelease, installerNameFor, readCachedUpdate,
  type UpdateCheckConfig,
} from '../src/main/services/updateCheck';
import { HandlerRegistry } from '../src/main/ipc/registry';
import { registerAppInfoHandlers } from '../src/main/ipc/handlers';
import { requestSession, setGlobalSession } from '../src/main/ipc/session';
import { IPC_CHANNELS_APP } from '../src/shared/types/ipc';

let dir = '';
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'counter-update-')); });
afterEach(() => {
  _resetUpdateChecks();
  setGlobalSession(null);
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

const cfg = (over: Partial<UpdateCheckConfig> = {}): UpdateCheckConfig => ({
  currentVersion: '0.4.1', edition: 'FRIENDLY', platform: 'win32', arch: 'x64', userDataDir: dir, ...over,
});
const release = (tag = 'v0.4.2', extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  html_url: `${RELEASES_PAGE}/tag/${tag}`,
  published_at: '2026-09-25T09:00:00Z',
  body: 'Corrections keep what was paid.',
  assets: [
    { name: `Counter-Setup-${tag.slice(1)}-x64.exe` },
    { name: `Counter-Friendly-Setup-${tag.slice(1)}-x64.exe` },
    { name: `Counter-Friendly-${tag.slice(1)}-arm64.dmg` },
  ],
  ...extra,
});
const answer = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('versions and installers', () => {
  it('compares versions by number, not text', () => {
    expect(compareVersions('0.4.10', '0.4.9')).toBe(1);
    expect(compareVersions('v0.4.2', '0.4.2')).toBe(0);
    expect(compareVersions('0.4.1', '0.5.0')).toBe(-1);
    expect(compareVersions('1.0.0-beta', '1.0.0')).toBe(0);
  });

  it("names each edition's installer the way the release publishes it", () => {
    expect(installerNameFor('STANDARD', 'win32', 'x64', '0.4.2')).toBe('Counter-Setup-0.4.2-x64.exe');
    expect(installerNameFor('VAT', 'darwin', 'arm64', '0.4.2')).toBe('Counter-VAT-0.4.2-arm64.dmg');
    expect(installerNameFor('FRIENDLY', 'darwin', 'x64', '0.4.2')).toBe('Counter-Friendly-0.4.2-x64.dmg');
    expect(installerNameFor('STANDARD', 'linux', 'x64', '0.4.2')).toBe('Counter-0.4.2-x86_64.AppImage');
  });
});

describe('reading the latest release', () => {
  it('finds a newer version and this edition’s installer', () => {
    const info = describeRelease(release(), cfg(), '2026-09-25T10:00:00Z');
    expect(info).toMatchObject({
      status: 'AVAILABLE', currentVersion: '0.4.1', latestVersion: '0.4.2',
      installerName: 'Counter-Friendly-Setup-0.4.2-x64.exe',
      releaseUrl: `${RELEASES_PAGE}/tag/v0.4.2`, notes: 'Corrections keep what was paid.',
    });
  });

  it('is up to date on the same or an older release', () => {
    expect(describeRelease(release('v0.4.1'), cfg(), 'x').status).toBe('UP_TO_DATE');
    expect(describeRelease(release('v0.3.4'), cfg(), 'x').status).toBe('UP_TO_DATE');
  });

  it('leaves out an installer the release lacks, and never links outside the releases page', () => {
    const info = describeRelease(release('v0.4.2', { html_url: 'https://evil.example/x' }), cfg({ platform: 'linux' }), 'x');
    expect(info.installerName).toBeNull();
    expect(info.releaseUrl).toBe(RELEASES_PAGE);
  });

  it('refuses drafts, pre-releases and tags that are not versions', () => {
    expect(() => describeRelease(release('v0.5.0', { prerelease: true }), cfg(), 'x')).toThrow();
    expect(() => describeRelease(release('latest'), cfg(), 'x')).toThrow();
  });

  it('cuts long release notes', () => {
    const info = describeRelease(release('v0.4.2', { body: 'x'.repeat(2000) }), cfg(), 'x');
    expect(info.notes!.length).toBeLessThan(900);
    expect(info.notes!.endsWith('…')).toBe(true);
  });
});

describe('checking', () => {
  it('sends nothing about the shop', async () => {
    const fetchImpl = answer(release());
    await checkForUpdate(cfg({ fetchImpl }));
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('https://api.github.com/repos/najadams/counter/releases/latest');
    expect(init.headers).toEqual({ Accept: 'application/vnd.github+json', 'User-Agent': 'Counter/0.4.1' });
    expect(init.body).toBeUndefined();
  });

  it('offline or refused: keeps the last good answer and says why', async () => {
    const good = await checkForUpdate(cfg({ fetchImpl: answer(release()) }));
    const failed = await checkForUpdate(cfg({ fetchImpl: vi.fn(async () => { throw new Error('fetch failed'); }) as unknown as typeof fetch }), good);
    expect(failed).toMatchObject({ status: 'AVAILABLE', latestVersion: '0.4.2', error: 'fetch failed' });
    const refused = await checkForUpdate(cfg({ fetchImpl: answer({}, 403) }));
    expect(refused).toMatchObject({ status: 'UNKNOWN', error: 'GitHub answered 403' });
  });

  it('remembers the answer across restarts and re-reads it once the update is installed', async () => {
    configureUpdateChecks(cfg({ fetchImpl: answer(release()) }));
    expect(currentUpdateInfo()).toMatchObject({ status: 'UNKNOWN', error: null });
    await checkForUpdateNow();
    expect(readCachedUpdate(dir, '0.4.1')?.status).toBe('AVAILABLE');

    // Offline after an upgrade to 0.4.2: the stored answer now says up to date.
    configureUpdateChecks(cfg({ currentVersion: '0.4.2', fetchImpl: vi.fn(async () => { throw new Error('offline'); }) as unknown as typeof fetch }));
    expect(currentUpdateInfo()).toMatchObject({ status: 'UP_TO_DATE', currentVersion: '0.4.2', latestVersion: '0.4.2' });
  });

  it('COUNTER_UPDATE_CHECK=0 makes no request', async () => {
    vi.stubEnv('COUNTER_UPDATE_CHECK', '0');
    const fetchImpl = answer(release());
    configureUpdateChecks(cfg({ fetchImpl }));
    const info = await checkForUpdateNow();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(info).toMatchObject({ status: 'UNKNOWN', error: 'Update checks are turned off on this till' });
  });
});

describe('app info handlers', () => {
  async function setup() {
    configureUpdateChecks(cfg({ fetchImpl: answer(release()) }));
    await checkForUpdateNow();
    const opened: string[] = [];
    const r = new HandlerRegistry();
    registerAppInfoHandlers(r, {
      version: '0.4.1', edition: 'FRIENDLY', platform: 'win32', arch: 'x64',
      updates: { current: currentUpdateInfo, checkNow: checkForUpdateNow },
      openExternal: async (url) => { opened.push(url); },
    });
    setGlobalSession({ workerId: 'w', fullName: 'Ama', role: 'OWNER' });
    const call = (channel: string) => (r.handlers.get(channel) as (e: unknown, p: unknown) => Promise<{ success: boolean; data?: any; error?: string }>)({}, {});
    const overLan = (channel: string) => requestSession.run(
      { session: { workerId: 'w', fullName: 'Ama', role: 'OWNER' }, station: 'door' }, () => call(channel),
    );
    return { call, overLan, opened };
  }

  it('reports the version, edition and update', async () => {
    const { call } = await setup();
    const about = await call(IPC_CHANNELS_APP.APP_ABOUT);
    expect(about.data).toMatchObject({
      version: '0.4.1', editionName: 'Counter Friendly', canOpenDownloadPage: true,
      update: { status: 'AVAILABLE', latestVersion: '0.4.2' },
    });
  });

  it('opens only the release page, and only on the shop PC', async () => {
    const { call, overLan, opened } = await setup();
    expect((await overLan(IPC_CHANNELS_APP.APP_ABOUT)).data.canOpenDownloadPage).toBe(false);
    const fromPhone = await overLan(IPC_CHANNELS_APP.APP_OPEN_DOWNLOAD_PAGE);
    expect(fromPhone).toMatchObject({ success: false });
    expect(opened).toEqual([]);

    expect((await call(IPC_CHANNELS_APP.APP_OPEN_DOWNLOAD_PAGE)).success).toBe(true);
    expect(opened).toEqual([`${RELEASES_PAGE}/tag/v0.4.2`]);
  });

  it('needs someone signed in', async () => {
    const { call } = await setup();
    setGlobalSession(null);
    expect((await call(IPC_CHANNELS_APP.APP_ABOUT)).success).toBe(false);
  });
});
