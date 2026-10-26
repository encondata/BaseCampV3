// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { en } from '../i18n/en';
import { he } from '../i18n/he';
import { ja } from '../i18n/ja';
import { ko } from '../i18n/ko';
import { LANGS, LANG_KEY, getLang, setLang, t } from './i18n';

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

afterEach(() => { setLang('en'); localStorage.clear(); });

describe('dictionaries', () => {
  it.each([['ja', ja], ['ko', ko], ['he', he]] as const)('%s has exactly the English keys', (_lang, dict) => {
    expect(Object.keys(dict).sort()).toEqual(Object.keys(en).sort());
  });

  it.each([['en', en], ['ja', ja], ['ko', ko], ['he', he]] as const)(
    '%s has no empty strings and the same placeholders as English', (_lang, dict) => {
      for (const key of Object.keys(en) as (keyof typeof en)[]) {
        expect(dict[key].trim(), key).not.toBe('');
        expect(placeholders(dict[key]), key).toEqual(placeholders(en[key]));
      }
    });

  it('offers the four languages under their own names', () => {
    expect(LANGS.map((l) => l.code)).toEqual(['en', 'ja', 'ko', 'he']);
    expect(LANGS.map((l) => l.name)).toEqual(['English', '日本語', '한국어', 'עברית']);
  });
});

describe('t and setLang', () => {
  it('translates, fills placeholders and follows the chosen language', () => {
    expect(t('signin.title')).toBe('Enter your learning code');
    expect(t('signin.codeBox', { n: 3 })).toBe('Character 3 of 6');
    setLang('ja');
    expect(getLang()).toBe('ja');
    expect(t('signin.title')).toBe(ja['signin.title']);
  });

  it('remembers the choice and sets the page language and direction', () => {
    setLang('he');
    expect(LANG_KEY).toBe('ss.learn.lang');
    expect(localStorage.getItem(LANG_KEY)).toBe('he');
    expect(document.documentElement.lang).toBe('he');
    expect(document.documentElement.dir).toBe('rtl');
    setLang('ko');
    expect(document.documentElement.lang).toBe('ko');
    expect(document.documentElement.dir).toBe('ltr');
  });
});
