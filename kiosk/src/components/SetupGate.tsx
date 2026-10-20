/** Route guard for a feature that isn't `alwaysAvailable`: renders its
 *  children only once kiosk setup is complete, otherwise bounces to the
 *  launcher — so typing a feature path directly (e.g. `/scan`) while
 *  setup is incomplete or failed lands back on Home instead of the
 *  feature's placeholder. Label Printing (every `/labels*` route) also
 *  bounces home on an RFID Station laptop, developer mode or not: that
 *  station has no Label Printing tile. */

import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';

import { useDevMode } from '../lib/devMode';
import { featureAvailable, type KioskFeature } from '../lib/features';
import { useKioskSetup } from '../lib/kioskSetup';
import { isLaptop } from '../lib/platform';
import { useKioskSetupState } from '../lib/setupState';

export default function SetupGate({ feature, children }: { feature: KioskFeature; children: ReactNode }) {
  const [setupState] = useKioskSetupState();
  const [devMode] = useDevMode();
  const [kioskSetup] = useKioskSetup();
  if (feature.id === 'labels' && isLaptop() && kioskSetup?.stationType === 'rfid') {
    return <Navigate to="/" replace />;
  }
  if (!featureAvailable(feature, setupState, devMode)) return <Navigate to="/" replace />;
  return <>{children}</>;
}
