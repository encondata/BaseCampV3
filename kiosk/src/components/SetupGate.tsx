/** Route guard for a feature that isn't `alwaysAvailable`: renders its
 *  children only once kiosk setup is complete, otherwise bounces to the
 *  launcher — so typing a feature path directly (e.g. `/scan`) while
 *  setup is incomplete or failed lands back on Home instead of the
 *  feature's placeholder. */

import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';

import { featureAvailable, type KioskFeature } from '../lib/features';
import { useKioskSetupState } from '../lib/setupState';

export default function SetupGate({ feature, children }: { feature: KioskFeature; children: ReactNode }) {
  const [setupState] = useKioskSetupState();
  if (!featureAvailable(feature, setupState)) return <Navigate to="/" replace />;
  return <>{children}</>;
}
