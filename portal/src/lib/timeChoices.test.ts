import { describe, expect, it } from 'vitest';

import {
  TIME_CHOICES as LEARNING_TIME_CHOICES, timeLabel as learningTimeLabel,
} from '../components/learning/initiativeLearning';
import { TIME_CHOICES, timeLabel, timeOptions } from './timeChoices';

describe('TIME_CHOICES', () => {
  it('is every quarter hour of the day as HH:MM', () => {
    expect(TIME_CHOICES.length).toBe(96);
    expect(TIME_CHOICES[0]).toBe('00:00');
    expect(TIME_CHOICES[1]).toBe('00:15');
    expect(TIME_CHOICES[95]).toBe('23:45');
    expect(TIME_CHOICES.every((t) => /^\d{2}:(00|15|30|45)$/.test(t))).toBe(true);
  });

  it('is already in clock order', () => {
    expect([...TIME_CHOICES].sort()).toEqual(TIME_CHOICES);
  });
});

describe('timeLabel', () => {
  it('reads a time in 12-hour form, whatever the locale', () => {
    expect(timeLabel('21:00')).toBe('9:00 PM');
    expect(timeLabel('07:30')).toBe('7:30 AM');
    expect(timeLabel('00:00')).toBe('12:00 AM');
    expect(timeLabel('12:00')).toBe('12:00 PM');
    expect(timeLabel('23:45')).toBe('11:45 PM');
  });

  it('ignores seconds, the way the API sends a stored time', () => {
    expect(timeLabel('21:10:00')).toBe('9:10 PM');
  });

  it('passes through a value that is not a time', () => {
    expect(timeLabel('soon')).toBe('soon');
  });
});

describe('timeOptions', () => {
  it('is the quarter-hour grid with 12-hour labels when there is no current time', () => {
    const options = timeOptions(null);
    expect(options.length).toBe(96);
    expect(options[0]).toEqual({ value: '00:00', label: '12:00 AM' });
    expect(options.find((o) => o.value === '21:00')).toEqual({ value: '21:00', label: '9:00 PM' });
  });

  it('adds nothing when the current time is already on the grid, seconds or not', () => {
    expect(timeOptions('21:15').length).toBe(96);
    expect(timeOptions('21:15:00').length).toBe(96);
    expect(timeOptions('21:15:00').map((o) => o.value)).toEqual(TIME_CHOICES);
  });

  it('slots an off-grid time in order, as HH:MM, between its quarter-hour neighbors', () => {
    const options = timeOptions('21:10:00');
    expect(options).toContainEqual({ value: '21:10', label: '9:10 PM' });
    const values = options.map((o) => o.value);
    expect(values.length).toBe(97);
    expect(values.indexOf('21:10')).toBe(values.indexOf('21:00') + 1);
    expect(values.indexOf('21:15')).toBe(values.indexOf('21:10') + 1);
    expect([...values].sort()).toEqual(values);
  });

  it('puts an off-grid time at either end of the day where it belongs', () => {
    expect(timeOptions('00:05')[1]).toEqual({ value: '00:05', label: '12:05 AM' });
    const late = timeOptions('23:50');
    expect(late[late.length - 1]).toEqual({ value: '23:50', label: '11:50 PM' });
  });

  it('ignores a value that is not a time', () => {
    expect(timeOptions('soon').length).toBe(96);
    expect(timeOptions('').length).toBe(96);
  });
});

describe('the Learning module keeps exporting the grid', () => {
  it('re-exports the same TIME_CHOICES and timeLabel', () => {
    expect(LEARNING_TIME_CHOICES).toBe(TIME_CHOICES);
    expect(learningTimeLabel).toBe(timeLabel);
  });
});
