import OrgDirectory from './OrgDirectory';

export default function Clients() {
  return (
    <OrgDirectory cfg={{
      kind: 'client',
      apiBase: '/clients',
      title: 'Clients',
      blurb: 'The organizations you move — contacts, tiers, and relationship owners.',
      addLabel: 'Add client',
      hasType: false,
    }} />
  );
}
