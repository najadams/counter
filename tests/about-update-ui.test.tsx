// @vitest-environment jsdom
//
// Settings → About shows the version and what to do about an update; the Home
// notice appears for a newer release and "Remind tomorrow" hides it.

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppAboutResponse } from '../src/shared/types/ipc';

const counterMock = vi.hoisted(() => ({
  appAbout: vi.fn(),
  appCheckForUpdate: vi.fn(),
  appOpenDownloadPage: vi.fn(),
}));
vi.mock('../src/renderer/lib/ipc', () => ({ counter: counterMock, isDesktopHost: true }));

import { AboutTab } from '../src/renderer/screens/settings/AboutTab';
import { UpdateBanner } from '../src/renderer/components/UpdateBanner';

const base: AppAboutResponse = {
  version: '0.4.1', edition: 'FRIENDLY', editionName: 'Counter Friendly', platform: 'win32', arch: 'x64',
  canOpenDownloadPage: true,
  update: {
    status: 'AVAILABLE', currentVersion: '0.4.1', latestVersion: '0.4.2', releasedAt: '2026-09-25T09:00:00Z',
    releaseUrl: 'https://github.com/najadams/counter/releases/tag/v0.4.2',
    installerName: 'Counter-Friendly-Setup-0.4.2-x64.exe', notes: 'Corrections keep what was paid.',
    checkedAt: '2026-09-25T10:00:00Z', error: null,
  },
};

beforeEach(() => {
  for (const fn of Object.values(counterMock)) fn.mockReset();
  counterMock.appOpenDownloadPage.mockResolvedValue({ success: true, data: { opened: true } });
  localStorage.clear();
});
afterEach(cleanup);

describe('Settings → About', () => {
  it('shows the version, and how to install an available update', async () => {
    counterMock.appAbout.mockResolvedValue({ success: true, data: base });
    render(<AboutTab />);
    expect(await screen.findByText('Counter Friendly')).toBeInTheDocument();
    expect(screen.getByText('0.4.1', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText('Update available')).toBeInTheDocument();
    expect(screen.getByText('Counter-Friendly-Setup-0.4.2-x64.exe')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open download page' }));
    expect(counterMock.appOpenDownloadPage).toHaveBeenCalledOnce();
  });

  it('on a phone, says to use the shop PC instead of offering the button', async () => {
    counterMock.appAbout.mockResolvedValue({ success: true, data: { ...base, canOpenDownloadPage: false } });
    render(<AboutTab />);
    expect(await screen.findByText('Open the download page on the shop PC.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open download page' })).toBeNull();
  });

  it('checks again on request', async () => {
    counterMock.appAbout.mockResolvedValue({ success: true, data: { ...base, update: null } });
    counterMock.appCheckForUpdate.mockResolvedValue({
      success: true, data: { ...base.update!, status: 'UP_TO_DATE', latestVersion: '0.4.1' },
    });
    render(<AboutTab />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check now' }));
    expect(await screen.findByText('This is the latest version.')).toBeInTheDocument();
    expect(screen.getByText('Up to date')).toBeInTheDocument();
  });

  it('offline: says so plainly', async () => {
    counterMock.appAbout.mockResolvedValue({
      success: true,
      data: { ...base, update: { ...base.update!, status: 'UNKNOWN', latestVersion: null, checkedAt: null, error: 'fetch failed' } },
    });
    render(<AboutTab />);
    expect(await screen.findByText(/Couldn’t check for updates/)).toBeInTheDocument();
  });
});

describe('Home update notice', () => {
  it('shows a newer release until "Remind tomorrow"', async () => {
    counterMock.appAbout.mockResolvedValue({ success: true, data: base });
    const { unmount } = render(<UpdateBanner />);
    expect(await screen.findByText('Counter Friendly 0.4.2 is available. This till runs 0.4.1.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remind tomorrow' }));
    expect(screen.queryByText(/is available/)).toBeNull();
    unmount();

    // Still hidden on the next visit to Home, for the same version…
    render(<UpdateBanner />);
    await screen.findByText((_, el) => el === document.body);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText(/is available/)).toBeNull();
    cleanup();

    // …but a newer release shows straight away.
    counterMock.appAbout.mockResolvedValue({
      success: true, data: { ...base, update: { ...base.update!, latestVersion: '0.4.3' } },
    });
    render(<UpdateBanner />);
    expect(await screen.findByText('Counter Friendly 0.4.3 is available. This till runs 0.4.1.')).toBeInTheDocument();
  });

  it('shows nothing when up to date', async () => {
    counterMock.appAbout.mockResolvedValue({
      success: true, data: { ...base, update: { ...base.update!, status: 'UP_TO_DATE', latestVersion: '0.4.1' } },
    });
    const { container } = render(<UpdateBanner />);
    await new Promise((r) => setTimeout(r, 0));
    expect(container).toBeEmptyDOMElement();
  });
});
