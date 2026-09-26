/** The top bar's space picker: a ComboBox over the spaces the person can
 *  view; picking one opens its home. */
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

import ComboBox, { type ComboOption } from '@portal/components/ComboBox';

import type { SpaceOut } from '../lib/types';

export default function SpaceSwitcher({ spaces, current }: { spaces: SpaceOut[] | null; current: SpaceOut | null }) {
  const navigate = useNavigate();
  const options = useMemo<ComboOption[]>(() => (spaces ?? []).map((s) => ({
    value: s.key,
    label: s.icon ? `${s.icon}  ${s.name}` : s.name,
    sub: s.key,
  })), [spaces]);
  return (
    <div className="wiki-space-switcher">
      <ComboBox
        options={options}
        value={current?.key ?? ''}
        onChange={(key) => { if (key) navigate(`/s/${key}`); }}
        placeholder={spaces && spaces.length === 0 ? 'No spaces yet' : 'Choose a space…'}
        ariaLabel="Space"
        disabled={!spaces || spaces.length === 0}
      />
    </div>
  );
}
