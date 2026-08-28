/**
 * SurveyForm — renders the data-driven per-site survey schema. Each group
 * is a `survey-group` sub-heading (visually subordinate to the modal's
 * `modal-section` headers) over the standard `pf-form` two-column grid.
 * Every field — booleans included — renders as the same label-above-control
 * block so the columns keep their rhythm; booleans are tri-state selects
 * (— / Yes / No), so an explicit "No" is a real answer, distinct from
 * unanswered. Values stay loose (Record<string, unknown>); the parent
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
  return (
    <div className={field.kind === 'textarea' ? 'full' : undefined}>
      <label>{field.label}</label>
      {field.kind === 'bool' && (
        <select
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
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          rows={3}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {field.kind === 'int' && (
        <input
          type="number"
          value={value === undefined || value === null ? '' : String(value)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {field.kind === 'select' && (
        <select
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
          value={typeof value === 'string' ? value : ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </div>
  );
}
