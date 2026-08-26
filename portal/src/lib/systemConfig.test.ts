import { describe, expect, it } from 'vitest';

import { ApiError, type LoggingConfig } from './api';
import { serverFieldErrors, validateLoggingForm } from './systemConfig';

const base = (): LoggingConfig => ({
  mode: 'local', local_max_rows_per_process: 20000,
  local_max_age_days: 14, remote_buffer_rows: 10000, min_level: 'INFO',
  transport: 'loki',
  loki: { url: '', username: '', password: '', tenant_id: '' },
  syslog: { host: '', port: 514, protocol: 'udp' },
});

describe('validateLoggingForm', () => {
  it('accepts defaults and good remote configs', () => {
    expect(validateLoggingForm(base())).toEqual({});
    expect(validateLoggingForm({
      ...base(), mode: 'local_remote',
      loki: { ...base().loki, url: 'http://loki:3100' },
    })).toEqual({});
    expect(validateLoggingForm({
      ...base(), mode: 'remote', transport: 'syslog',
      syslog: { host: 'wazuh.local', port: 514, protocol: 'udp' },
    })).toEqual({});
  });
  it('flags missing transport requirements only when remote', () => {
    expect(validateLoggingForm({ ...base(), mode: 'local_remote' }))
      .toHaveProperty(['loki.url']);
    expect(validateLoggingForm({
      ...base(), mode: 'remote', transport: 'syslog',
    })).toHaveProperty(['syslog.host']);
    expect(validateLoggingForm(base())).toEqual({});
  });
  it('flags bad numbers', () => {
    expect(validateLoggingForm({ ...base(), local_max_age_days: 0 }))
      .toHaveProperty(['local_max_age_days']);
    expect(validateLoggingForm({
      ...base(), mode: 'remote', transport: 'syslog',
      syslog: { host: 'x', port: 70000, protocol: 'udp' },
    })).toHaveProperty(['syslog.port']);
  });
});

describe('serverFieldErrors', () => {
  it('extracts the fields map from a 422', () => {
    const err = new ApiError(422, 'invalid_logging_config',
      { code: 'invalid_logging_config', fields: { 'loki.url': 'bad' } });
    expect(serverFieldErrors(err)).toEqual({ 'loki.url': 'bad' });
  });
  it('empty for anything else', () => {
    expect(serverFieldErrors(new Error('x'))).toEqual({});
    expect(serverFieldErrors(new ApiError(500, 'boom'))).toEqual({});
  });
});
