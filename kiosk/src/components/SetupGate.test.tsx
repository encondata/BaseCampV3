// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeDevMode } from '../lib/devMode';
import { FEATURES } from '../lib/features';
import { writeKioskSetup } from '../lib/kioskSetup';
import { writeSetupState } from '../lib/setupState';
import SetupGate from './SetupGate';

const scan = FEATURES.find((f) => f.id === 'scan')!;

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<div>Home</div>} />
        <Route path={scan.path} element={<SetupGate feature={scan}><div>Scan feature</div></SetupGate>} />
      </Routes>
    </MemoryRouter>,
  );
}

it('redirects to / when setup is incomplete', () => {
  renderAt('/scan');
  expect(screen.getByText('Home')).toBeTruthy();
  expect(screen.queryByText('Scan feature')).toBeNull();
});

it('redirects to / when setup failed', () => {
  writeSetupState('failed');
  renderAt('/scan');
  expect(screen.getByText('Home')).toBeTruthy();
  expect(screen.queryByText('Scan feature')).toBeNull();
});

it('renders children when setup is complete', () => {
  writeSetupState('complete');
  renderAt('/scan');
  expect(screen.getByText('Scan feature')).toBeTruthy();
});

it('renders children when setup is incomplete but developer mode is on', () => {
  writeDevMode(true);
  renderAt('/scan');
  expect(screen.getByText('Scan feature')).toBeTruthy();
});

it('renders children when setup failed but developer mode is on', () => {
  writeSetupState('failed');
  writeDevMode(true);
  renderAt('/scan');
  expect(screen.getByText('Scan feature')).toBeTruthy();
});

describe('Label Printing on a laptop station', () => {
  const labels = FEATURES.find((f) => f.id === 'labels')!;
  const SETUP = {
    initiativeId: 'i-1', initiativeName: 'Move', siteId: 's-1', siteName: 'ORD1',
    siteRole: 'source' as const, scanStatus: 'k', scanLabel: 'Dock',
  };

  function renderLabels(path: string) {
    return render(
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/" element={<div>Home</div>} />
          <Route path="/labels/station" element={<SetupGate feature={labels}><div>Printing Station</div></SetupGate>} />
        </Routes>
      </MemoryRouter>,
    );
  }

  beforeEach(() => {
    writeSetupState('complete');
    window.__KIOSK_CONFIG__ = { mode: 'laptop', identity: { serial: 'kiosk-laptop-1', name: 'Kiosk 0001' } };
  });
  afterEach(() => { delete window.__KIOSK_CONFIG__; });

  it('an RFID Station sends /labels/station home', () => {
    writeKioskSetup({ ...SETUP, stationType: 'rfid' });
    renderLabels('/labels/station');
    expect(screen.getByText('Home')).toBeTruthy();
    expect(screen.queryByText('Printing Station')).toBeNull();
  });

  it('even with developer mode on', () => {
    writeDevMode(true);
    writeKioskSetup({ ...SETUP, stationType: 'rfid' });
    renderLabels('/labels/station');
    expect(screen.getByText('Home')).toBeTruthy();
  });

  it('a Label Station opens it', () => {
    writeKioskSetup({ ...SETUP, stationType: 'label' });
    renderLabels('/labels/station');
    expect(screen.getByText('Printing Station')).toBeTruthy();
  });

  it('web mode is unchanged', () => {
    delete window.__KIOSK_CONFIG__;
    writeKioskSetup({ ...SETUP, stationType: 'rfid' });
    renderLabels('/labels/station');
    expect(screen.getByText('Printing Station')).toBeTruthy();
  });
});
