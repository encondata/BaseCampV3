// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { FEATURES } from '../lib/features';
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
