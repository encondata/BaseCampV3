/** The learn site's small dictionary: English, Japanese, Korean and
 *  Hebrew (right to left). English governs; the others are convenience
 *  translations with exactly the same keys. The choice is remembered per
 *  browser (localStorage `ss.learn.lang`); with none saved, the browser's
 *  own language picks one, else English.
 *
 *  `t()` reads the current language, so a component that shows text calls
 *  `useLang()` once to re-render when it changes. */
import { useSyncExternalStore } from 'react';

import { en, type Dictionary, type MessageKey } from '../i18n/en';
import { he } from '../i18n/he';
import { ja } from '../i18n/ja';
import { ko } from '../i18n/ko';

export type Lang = 'en' | 'ja' | 'ko' | 'he';

/** In picker order, each under its own name. */
export const LANGS: { code: Lang; name: string }[] = [
  { code: 'en', name: 'English' },
  { code: 'ja', name: '日本語' },
  { code: 'ko', name: '한국어' },
  { code: 'he', name: 'עברית' },
];

export const LANG_KEY = 'ss.learn.lang';

const DICTIONARIES: Record<Lang, Dictionary> = { en, ja, ko, he };
const RTL: ReadonlySet<Lang> = new Set(['he']);

function isLang(v: unknown): v is Lang {
  return typeof v === 'string' && v in DICTIONARIES;
}

function initialLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (isLang(saved)) return saved;
  } catch { /* storage blocked: fall through */ }
  if (typeof navigator !== 'undefined') {
    for (const tag of navigator.languages ?? [navigator.language]) {
      const base = tag?.toLowerCase().split('-')[0];
      // `iw` is the old code for Hebrew some browsers still send
      const code = base === 'iw' ? 'he' : base;
      if (isLang(code)) return code;
    }
  }
  return 'en';
}

let current: Lang = typeof window === 'undefined' ? 'en' : initialLang();
const listeners = new Set<() => void>();

function applyToPage(lang: Lang): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = lang;
  document.documentElement.dir = RTL.has(lang) ? 'rtl' : 'ltr';
}
applyToPage(current);

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  current = lang;
  try { localStorage.setItem(LANG_KEY, lang); } catch { /* not remembered, still applied */ }
  applyToPage(lang);
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The current language; the calling component re-renders when it changes. */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, getLang);
}

/** The text for `key` in the current language, `{name}` placeholders
 *  filled from `vars`. */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const text = DICTIONARIES[current][key] ?? en[key];
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    (name in vars ? String(vars[name]) : whole));
}
