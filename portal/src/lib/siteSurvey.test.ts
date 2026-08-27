import { describe, expect, it } from 'vitest';

import type { RawSurveyRow, SiteSurveyRow } from './api';
import {
  filledCount, rawSurveyCellText, rawSurveySearchText, SITE_SURVEY_ERRORS,
  surveyCellText, surveySearchText, surveyValueText,
} from './siteSurvey';

const boolRow: SiteSurveyRow = {
  field_key: 'dock_available', label: 'Dock available', group: 'dock',
  group_label: 'Dock & access', kind: 'bool', options: [], value: true,
  raw_id: 10, updated_by: 'u1', updated_by_name: 'Pat Person',
  updated_at: '2026-08-27T09:00:00Z',
};

const boolFalseRow: SiteSurveyRow = { ...boolRow, value: false };

const intRow: SiteSurveyRow = {
  field_key: 'floor', label: 'Floor', group: 'facility',
  group_label: 'Facility', kind: 'int', options: [], value: 3,
  raw_id: 11, updated_by: 'u1', updated_by_name: 'Pat Person',
  updated_at: '2026-08-27T09:00:00Z',
};

const selectRow: SiteSurveyRow = {
  field_key: 'floor_covering_required', label: 'Floor covering required',
  group: 'dock', group_label: 'Dock & access', kind: 'select',
  options: ['none', 'carpet', 'masonite', 'other'], value: 'carpet',
  raw_id: 12, updated_by: 'u1', updated_by_name: 'Pat Person',
  updated_at: '2026-08-27T09:00:00Z',
};

const textRow: SiteSurveyRow = {
  field_key: 'contact_name', label: 'Contact name', group: 'contact',
  group_label: 'Site contact', kind: 'text', options: [], value: 'Jamie',
  raw_id: 13, updated_by: 'u1', updated_by_name: 'Pat Person',
  updated_at: '2026-08-27T09:00:00Z',
};

const unansweredRow: SiteSurveyRow = {
  field_key: 'additional_notes', label: 'Additional notes', group: 'notes',
  group_label: 'Notes', kind: 'textarea', options: [], value: null,
  raw_id: null, updated_by: null, updated_by_name: null, updated_at: null,
};

describe('surveyValueText', () => {
  it('renders bool as Yes/No', () => {
    expect(surveyValueText(boolRow)).toBe('Yes');
    expect(surveyValueText(boolFalseRow)).toBe('No');
  });
  it('renders unanswered as em dash', () => {
    expect(surveyValueText(unansweredRow)).toBe('—');
  });
  it('renders int/select/text as plain strings', () => {
    expect(surveyValueText(intRow)).toBe('3');
    expect(surveyValueText(selectRow)).toBe('carpet');
    expect(surveyValueText(textRow)).toBe('Jamie');
  });
});

describe('surveyCellText', () => {
  it('mirrors cell rendering for each column', () => {
    expect(surveyCellText(textRow, 'field')).toBe('Contact name');
    expect(surveyCellText(textRow, 'group')).toBe('Site contact');
    expect(surveyCellText(textRow, 'value')).toBe('Jamie');
    expect(surveyCellText(textRow, 'updated_by')).toBe('Pat Person');
    expect(surveyCellText(textRow, 'updated')).toBe(
      new Date(textRow.updated_at as string).toLocaleString());
  });
  it('falls back to em dash for unanswered rows', () => {
    expect(surveyCellText(unansweredRow, 'value')).toBe('—');
    expect(surveyCellText(unansweredRow, 'updated_by')).toBe('—');
    expect(surveyCellText(unansweredRow, 'updated')).toBe('—');
  });
});

describe('surveySearchText', () => {
  it('joins the searchable fields lowercased', () => {
    const t = surveySearchText(textRow);
    expect(t).toContain('contact name');
    expect(t).toContain('site contact');
    expect(t).toContain('jamie');
    expect(t).toContain('pat person');
  });
  it('skips the updated-by name when unanswered', () => {
    const t = surveySearchText(unansweredRow);
    expect(t).not.toContain('null');
  });
});

describe('filledCount', () => {
  it('counts non-null rows against the total', () => {
    expect(filledCount([boolRow, intRow, unansweredRow]))
      .toEqual({ filled: 2, total: 3 });
  });
  it('handles an empty list', () => {
    expect(filledCount([])).toEqual({ filled: 0, total: 0 });
  });
});

const rawRow: RawSurveyRow = {
  id: 1, field_key: 'dock_available', registered: true, value: true,
  captured_at: '2026-08-27T09:00:00Z', submitted_by: 'u1',
  submitted_by_name: 'Pat Person', device_id: 'tablet-1', source: 'portal',
  created_at: '2026-08-27T09:00:01Z',
};

const strayRawRow: RawSurveyRow = {
  id: 2, field_key: 'legacy_field', registered: false, value: 'old value',
  captured_at: '2026-08-27T09:05:00Z', submitted_by: null,
  submitted_by_name: null, device_id: '', source: 'import',
  created_at: '2026-08-27T09:05:01Z',
};

describe('rawSurveyCellText', () => {
  it('mirrors cell rendering including registered Yes/dash', () => {
    expect(rawSurveyCellText(rawRow, 'field')).toBe('dock_available');
    expect(rawSurveyCellText(rawRow, 'value')).toBe('true');
    expect(rawSurveyCellText(rawRow, 'registered')).toBe('Yes');
    expect(rawSurveyCellText(rawRow, 'source')).toBe('portal');
    expect(rawSurveyCellText(rawRow, 'submitted_by')).toBe('Pat Person');
    expect(rawSurveyCellText(rawRow, 'device')).toBe('tablet-1');
    expect(rawSurveyCellText(rawRow, 'captured')).toBe(
      new Date(rawRow.captured_at).toLocaleString());
    expect(rawSurveyCellText(rawRow, 'ingested')).toBe(
      new Date(rawRow.created_at).toLocaleString());
  });
  it('renders a stray unregistered row with dashes and String(value)', () => {
    expect(rawSurveyCellText(strayRawRow, 'registered')).toBe('—');
    expect(rawSurveyCellText(strayRawRow, 'submitted_by')).toBe('—');
    expect(rawSurveyCellText(strayRawRow, 'device')).toBe('—');
    expect(rawSurveyCellText(strayRawRow, 'value')).toBe('old value');
    expect(rawSurveyCellText({ ...rawRow, value: null }, 'value')).toBe('—');
    expect(rawSurveyCellText({ ...rawRow, value: 42 }, 'value')).toBe(String(42));
  });
});

describe('rawSurveySearchText', () => {
  it('joins the searchable fields lowercased', () => {
    const t = rawSurveySearchText(rawRow);
    expect(t).toContain('dock_available');
    expect(t).toContain('true');
    expect(t).toContain('portal');
    expect(t).toContain('pat person');
    expect(t).toContain('tablet-1');
  });
});

describe('SITE_SURVEY_ERRORS', () => {
  it('has copy for every documented survey error code', () => {
    for (const code of [
      'unknown_survey_field', 'invalid_survey_value',
      'survey_value_not_found', 'forbidden',
    ]) {
      expect(SITE_SURVEY_ERRORS[code]).toBeTruthy();
    }
  });
});
