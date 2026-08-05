import OrgDirectory from './OrgDirectory';

export default function Partners() {
  return (
    <OrgDirectory cfg={{
      kind: 'partner',
      apiBase: '/partners',
      title: 'Partners',
      blurb: 'External organizations you work with — staffing, logistics, subcontractors.',
      addLabel: 'Add partner',
      hasType: true,
    }} />
  );
}
