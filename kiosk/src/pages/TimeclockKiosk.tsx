/** The Timeclock tile on a signed-in kiosk: the guided time clock flow,
 *  full screen, starting on Enter Your Name and leaving for Home. Punches
 *  go through this kiosk's own session, against its Kiosk Setup. */

import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import { getIdentity } from '../lib/identity';
import { sessionBackend } from '../timeclock/backend';
import TimeclockFlow from '../timeclock/TimeclockFlow';

export default function TimeclockKiosk() {
  const navigate = useNavigate();
  const backend = useMemo(() => sessionBackend(getIdentity().serial), []);
  return <TimeclockFlow mode="kiosk" backend={backend} onExit={() => navigate('/')} />;
}
