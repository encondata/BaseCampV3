/**
 * SurveyForm — renders the data-driven per-site survey schema. Each group
 * is a `survey-group` sub-heading (visually subordinate to the modal's
 * `modal-section` headers) over the standard `pf-form` two-column grid.
 * Every field — booleans included — renders as the same label-above-control
 * block so the columns keep their rhythm; booleans are tri-state selects
 * (— / Yes / No), so an explicit "No" is a real answer, distinct from
 * unanswered. Whole-number fields are plain boxes with a numeric keypad
 * and no spinner arrows. Values stay loose (Record<string, unknown>); the parent
 * normalizes at save time via `surveyPayload`.
 */

import type { SurveyFieldDef, SurveySchema } from '../../lib/api';

interface Props {
  schema: SurveySchema;
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
  disabled?: boolean;
}

export default function SurveyForm({ schema, values, onChange, disabled = false }: Props) {
  return (
    <>
      {schema.groups.map((group) => (
        <div key={group.key}>
          <div className="survey-group">{group.label}</div>
          <div className="pf-form">
            {group.fields.map((field) => (
              <SurveyField
                key={field.key}
                field={field}
                value={values[field.key]}
                disabled={disabled}
                onChange={(v) => onChange(field.key, v)}
              />
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

function SurveyField({ field, value, disabled, onChange }: {
  field: SurveyFieldDef;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const inputId = `survey-${field.key}`;
  return (
    <div className={field.kind === 'textarea' ? 'full' : undefined}>
      <label htmlFor={inputId}>{field.label}</label>
      {field.kind === 'bool' && (
        <select
          id={inputId}
          className="org-select"
          value={value === true ? 'yes' : value === false ? 'no' : ''}
          disabled={disabled}
          onChange={(e) => onChange(
            e.target.value === 'yes' ? true
              : e.target.value === 'no' ? false : '')}
        >
          <option value="">—</option>
          <option value="yes">Yes</option>
          <option value="no">No</option>
        </select>
      )}
      {field.kind === 'textarea' && (
        <textarea
          id={inputId}
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          rows={3}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {field.kind === 'int' && (
        // A plain box with a numeric keypad instead of type="number": no
        // spinner arrows, and the scroll wheel can't nudge the value. Only
        // a whole number (optionally negative) gets through as you type.
        <input
          id={inputId}
          inputMode="numeric"
          value={value === undefined || value === null ? '' : String(value)}
          disabled={disabled}
          onChange={(e) => {
            const next = e.target.value.replace(/\s/g, '');
            if (/^-?\d*$/.test(next)) onChange(next);
            else onChange(next.replace(/(?!^-)\D/g, ''));
          }}
        />
      )}
      {field.kind === 'select' && (
        <select
          id={inputId}
          className="org-select"
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          <option value="">—</option>
          {field.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
        </select>
      )}
      {field.kind === 'text' && (
        <input
          id={inputId}
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}
