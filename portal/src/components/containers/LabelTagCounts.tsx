/** The per-tag steppers + summary from "Add in bulk", shared with Create a
 *  move in steps' crates. Tags fill in TAG_ASSIGNMENT_ORDER; the + is
 *  disabled once the tags cover the count. */
import type { CSSProperties } from 'react';

import { TAG_TYPES } from '../../labels/tagTypes';
import { summaryText, tagTotal, TAG_ASSIGNMENT_ORDER, type TagCounts } from '../../lib/bulkContainers';
import '../../styles/bulkContainers.css';

interface Props {
  count: number;
  tags: TagCounts;
  onChange: (tags: TagCounts) => void;
  disabled: boolean;
  notice: string;
  noun?: string;
}

export default function LabelTagCounts({ count, tags, onChange, disabled, notice, noun = 'container' }: Props) {
  const total = tagTotal(tags);
  const inc = (key: (typeof TAG_ASSIGNMENT_ORDER)[number]) => {
    if (total >= count) return;
    onChange({ ...tags, [key]: (tags[key] ?? 0) + 1 });
  };
  const dec = (key: (typeof TAG_ASSIGNMENT_ORDER)[number]) => {
    if (tags[key]) onChange({ ...tags, [key]: tags[key]! - 1 });
  };
  return (
    <>
      <div className="bc-tags">
        {TAG_ASSIGNMENT_ORDER.map((key) => {
          const opt = TAG_TYPES[key];
          const n = tags[key] ?? 0;
          return (
            <div key={key} className="bc-tag-row">
              <span className="chip custom" style={{ '--chip': opt.color } as CSSProperties}>
                <span className="dot" />{opt.label}
              </span>
              <div className="bc-stepper" role="group" aria-label={`${opt.label} count`}>
                <button type="button" className="mini-btn" aria-label={`Fewer ${opt.label}`}
                        disabled={disabled || n <= 0} onClick={() => dec(key)}>−</button>
                <span className="mono bc-stepper-value">{n}</span>
                <button type="button" className="mini-btn" aria-label={`More ${opt.label}`}
                        disabled={disabled || total >= count} onClick={() => inc(key)}>+</button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="bc-summary">
        <span className="eyebrow">Summary</span>
        <p className="page-hint">{summaryText(count, tags, noun)}</p>
        {notice && <p className="pf-error">{notice}</p>}
      </div>
    </>
  );
}
