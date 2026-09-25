import { useState } from 'react';

import { moveSetupError } from '../../lib/moveSetup';

/** Skip this step: the page PATCHes skip and advances; a failure stays here. */
export function useSkip(onSkip: () => Promise<void>, setError: (message: string) => void) {
  const [skipping, setSkipping] = useState(false);
  const skip = () => {
    setSkipping(true);
    setError('');
    onSkip().catch((err) => { setError(moveSetupError(err)); setSkipping(false); });
  };
  return { skipping, skip };
}
