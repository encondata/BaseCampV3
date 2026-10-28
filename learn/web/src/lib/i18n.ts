/** The learn site's languages. The API says which are offered (learning
 *  settings switch them on; GET /learn/languages, loaded once by App), and
 *  the picker names each under its own name from the browser's
 *  Intl.DisplayNames. The screen text comes from a small dictionary:
 *  English governs, Japanese, Korean and Hebrew are convenience
 *  translations with exactly the same keys, and any other language shows
 *  the English text (its documents still come in that language).
 *
 *  The choice is remembered per browser (localStorage `ss.learn.lang`).
 *  Until the offered list arrives the page uses that saved choice, else
 *  English; then a choice that isn't offered gives way to the browser's
 *  own language if that is offered, else English.
 *
 *  `t()` reads the current language, so a component that shows text calls
 *  `useLang()` once to re-render when it changes. */
import { useSyncExternalStore } from 'react';

import { en, type Dictionary, type MessageKey } from '../i18n/en';
import { he } from '../i18n/he';
import { ja } from '../i18n/ja';
import { ko } from '../i18n/ko';

/** A language tag the API offers ("en", "ms", "zh-Hans"). */
export type Lang = string;

export interface OfferedLanguage {
  code: Lang;
  /** Its own name ("Bahasa Melayu"), for the picker. */
  name: string;
  rtl: boolean;
}

export const LANG_KEY = 'ss.learn.lang';

const DICTIONARIES: Partial<Record<Lang, Dictionary>> = { en, ja, ko, he };
// before the offered list says otherwise
const RTL_TAGS = new Set(['he', 'ar', 'fa', 'ur']);

/** A language's name in that language, capitalized as a picker shows it;
 *  the tag itself when the browser has no name for it. */
export function nativeName(code: Lang): string {
  try {
    const name = new Intl.DisplayNames([code], { type: 'language' }).of(code) ?? code;
    return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
  } catch {
    return code;
  }
}

const offer = (code: Lang, rtl: boolean): OfferedLanguage => ({ code, name: nativeName(code), rtl });

let offered: OfferedLanguage[] = [offer('en', false)];

function savedLang(): Lang | null {
  try {
    return localStorage.getItem(LANG_KEY);
  } catch {
    return null;   // storage blocked
  }
}

function browserLangs(): string[] {
  if (typeof navigator === 'undefined') return [];
  return (navigator.languages ?? [navigator.language]).filter(Boolean).map((tag) => tag.toLowerCase());
}

/** The offered language a browser tag asks for: an exact tag ("zh-hans")
 *  first, then its base ("ms-MY" → "ms"; `iw` is the old code for Hebrew
 *  some browsers still send). */
function matchOffered(tag: string): Lang | null {
  const base = tag.split('-')[0];
  const exact = offered.find((l) => l.code.toLowerCase() === tag);
  const bare = offered.find((l) => l.code.toLowerCase() === (base === 'iw' ? 'he' : base));
  return (exact ?? bare)?.code ?? null;
}

let current: Lang = (typeof window === 'undefined' ? null : savedLang()) ?? 'en';
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

/** Whether a language reads right to left (the API's word for offered
 *  ones). */
export function isRtl(lang: Lang): boolean {
  const known = offered.find((l) => l.code === lang);
  return known ? known.rtl : RTL_TAGS.has(lang.split('-')[0]);
}

function applyToPage(lang: Lang): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = lang;
  document.documentElement.dir = isRtl(lang) ? 'rtl' : 'ltr';
}
applyToPage(current);

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  current = lang;
  try { localStorage.setItem(LANG_KEY, lang); } catch { /* not remembered, still applied */ }
  applyToPage(lang);
  notify();
}

/** The languages the API offers, English first. The page then uses the
 *  saved choice if it's offered, else the browser's own language if that
 *  is, else the current one if it is, else English — without overwriting
 *  the saved choice, so it comes back if the language is switched on
 *  again. */
export function setOffered(list: { code: Lang; rtl: boolean }[]): void {
  offered = list.length > 0 ? list.map((l) => offer(l.code, l.rtl)) : [offer('en', false)];
  const has = (lang: Lang | null): lang is Lang => lang !== null && offered.some((l) => l.code === lang);
  current = [savedLang(), ...browserLangs().map(matchOffered), current].find(has) ?? 'en';
  applyToPage(current);
  notify();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

const getOffered = () => offered;

/** The current language; the calling component re-renders when it changes. */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, getLang);
}

/** The offered languages, in the API's order (English first). */
export function useOffered(): OfferedLanguage[] {
  return useSyncExternalStore(subscribe, getOffered, getOffered);
}

/** The text for `key` in the current language (English where that
 *  language has none), `{name}` placeholders filled from `vars`. */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const text = DICTIONARIES[current]?.[key] ?? en[key];
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    (name in vars ? String(vars[name]) : whole));
}
