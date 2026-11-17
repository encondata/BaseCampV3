/** The Environments page's Environments tab: the Dashboard's environment
 *  cards (the same component and data, GET /api/dashboard), without its
 *  traffic graph or infrastructure tree. Only real environments get a card
 *  (the Dashboard's "Set up" placeholders stay there). A card opens its
 *  environment's page; its Deploy button opens the deploy dialog, as on the
 *  Dashboard. `reload` changes to load the cards again (after an adopt). */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';

import {
  errorText, getDashboard, getEnvironment, type DashEnvironment, type Environment,
} from '../../lib/sirdarApi';
import EnvCard from '../dashboard/EnvCard';
import '../dashboard/dashboard.css';

import DeployModal from './DeployModal';

const envPage = (name: string) => `/deploy/environments/${encodeURIComponent(name)}`;

export default function EnvironmentCards({ reload = 0 }: { reload?: number }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [cards, setCards] = useState<DashEnvironment[] | null>(null);
  const [error, setError] = useState('');
  const [deployEnv, setDeployEnv] = useState<Environment | null>(null);
  const [deployError, setDeployError] = useState('');

  useEffect(() => {
    let live = true;
    getDashboard({ demo: false, refresh: false })
      .then((d) => { if (live) { setCards(d.environments.filter((c) => c.environment)); setError(''); } })
      .catch((e) => { if (live) setError(errorText(e, "Couldn't load environments.")); });
    return () => { live = false; };
  }, [reload]);

  const openDeploy = async (name: string) => {
    setDeployError('');
    try { setDeployEnv(await getEnvironment(name)); }
    catch (e) { setDeployError(errorText(e, "Couldn't open that environment.")); }
  };

  return (
    <>
      {error && <p className="form-error" role="alert">{error}</p>}
      {deployError && <p className="form-error" role="alert">{deployError}</p>}
      {cards === null && !error && <p className="page-hint">Loading…</p>}
      {cards !== null && cards.length === 0 && <p className="page-hint">No environments yet.</p>}
      {cards !== null && cards.length > 0 && (
        <div className="sd-dash sirdar-env-cards">
          <div className="sd-env-grid">
            {cards.map((card) => (
              <EnvCard key={card.id} env={card} demo={false} canDeploy={can('deploy', 'add')} selected={false} opens
                       onSelect={() => navigate(envPage(card.environment!))}
                       onDeploy={(name) => void openDeploy(name)} onSetUp={() => navigate('/deploy/new')} />
            ))}
          </div>
        </div>
      )}
      {/* A sibling of .sd-dash, so its h3 / b rules don't restyle the modal. */}
      {deployEnv && (
        <DeployModal env={deployEnv} onClose={() => setDeployEnv(null)}
                     onStarted={(dep) => navigate(`${envPage(deployEnv.name)}?deployment=${dep.id}`)} />
      )}
    </>
  );
}
