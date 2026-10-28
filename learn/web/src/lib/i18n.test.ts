// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { en } from '../i18n/en';
import { he } from '../i18n/he';
import { ja } from '../i18n/ja';
import { ko } from '../i18n/ko';
import { LANG_KEY, getLang, nativeName, setLang, setOffered, t } from './i18n';

const FOUR = [
  { code: 'en', rtl: false }, { code: 'ja', rtl: false }, { code: 'ko', rtl: false }, { code: 'he', rtl: true },
];

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

afterEach(() => {
  setLang('en');
  localStorage.clear();
  setOffered([{ code: 'en', rtl: false }]);
  vi.unstubAllGlobals();
});

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

});

describe('t and setLang', () => {
  beforeEach(() => setOffered(FOUR));

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

describe('the offered languages', () => {
  it('names each language in itself, capitalized for the picker', () => {
    expect(['en', 'ja', 'ko', 'he', 'ms', 'zh-Hans', 'es'].map(nativeName))
      .toEqual(['English', '日本語', '한국어', 'עברית', 'Melayu', '简体中文', 'Español']);
    expect(nativeName('not a tag')).toBe('not a tag');
  });

  it('a language with no screen text of its own shows English, laid out as the API says', () => {
    setOffered([{ code: 'en', rtl: false }, { code: 'ar', rtl: true }, { code: 'ms', rtl: false }]);
    setLang('ms');
    expect(t('signin.title')).toBe('Enter your learning code');
    expect(document.documentElement.lang).toBe('ms');
    setLang('ar');
    expect(document.documentElement.dir).toBe('rtl');
  });

  it('keeps a saved choice that is offered', () => {
    localStorage.setItem(LANG_KEY, 'ja');
    setOffered(FOUR);
    expect(getLang()).toBe('ja');
  });

  it("uses the browser's own language when nothing offered was saved", () => {
    vi.stubGlobal('navigator', { languages: ['ms-MY', 'en-US'], language: 'ms-MY' });
    localStorage.setItem(LANG_KEY, 'ko');   // not offered here
    setOffered([{ code: 'en', rtl: false }, { code: 'ms', rtl: false }]);
    expect(getLang()).toBe('ms');
    // the saved choice is kept for when Korean is switched on again
    expect(localStorage.getItem(LANG_KEY)).toBe('ko');
  });

  it('falls back to English when the language in use is switched off', () => {
    setOffered(FOUR);
    setLang('he');
    localStorage.clear();
    setOffered([{ code: 'en', rtl: false }]);
    expect(getLang()).toBe('en');
    expect(document.documentElement.dir).toBe('ltr');
  });
});
