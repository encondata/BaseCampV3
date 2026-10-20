/**
 * The builder's font dropdown (spec §3.2, §4.4): the eight library
 * families, each name and the sample `0O 1Il 7` drawn in that family's own
 * face at the weight in use. The resident Swiss 721 Condensed Bold shows
 * under its own name in its Roboto Condensed Bold stand-in (fonts.ts
 * faceFile), marked "default"; the monospace families are marked "mono".
 * Opening the list asks `metricsFor` for every family, which is how the
 * page loads their faces.
 *
 * It looks like the portal's ComboBox (org-select trigger, combo-menu
 * list) but is a listbox, since ComboBox options are plain text and these
 * must render in their own face. The list always portals (fixed, like a
 * ComboBox in a modal), since the side panels scroll and would clip it. The face reaches the text through the
 * `--lbp-face` variable (labelBuilder.css `.lbp-face`): the sample is the
 * content itself, not list typography.
 *
 * Keyboard: ↓ ↑ Enter or Space on the trigger open the list and focus it;
 * in the list ↓ ↑ Home End move, Enter or Space pick, Escape closes, Tab
 * closes and moves on. The canvas leaves these keys alone in a listbox
 * (useBuilderShortcuts ownsKeys).
 */

import { useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';

import {
  DEFAULT_FAMILY, FONT_FAMILIES, FONT_SAMPLE, faceFile, familyInfo, type FontWeight,
} from '../../../labels/builder/fonts';
import { cssFamilyOf } from '../../../labels/builder/metrics';
import '../../../styles/directory.css';
import '../../../styles/labelBuilder.css';
import { useMenuPlacement } from '../../useMenuPlacement';
import type { MetricsFor } from './Canvas';

export interface FontSelectProps {
  /** The family slug chosen. */
  value: string;
  /** The weight the samples draw in (the element's). */
  weight?: FontWeight;
  onChange: (family: string) => void;
  /** Loads a family's face (the page's cache); asked for each family on open. */
  metricsFor?: MetricsFor;
  disabled?: boolean;
  id?: string;
}

/** The inline style that puts `family` at `weight` on `.lbp-face`. */
export function faceStyle(family: string, weight: FontWeight): CSSProperties {
  const face = cssFamilyOf(faceFile({ family, weight }));
  const fallback = familyInfo(family)?.mono ? 'ui-monospace, monospace' : 'sans-serif';
  return { '--lbp-face': `"${face}", ${fallback}` } as CSSProperties;
}

function Sample({ family, weight }: { family: string; weight: FontWeight }) {
  return (
    <span className="lbp-face" style={faceStyle(family, weight)}>
      <span className="lbp-font-name">{familyInfo(family)?.label ?? family}</span>
      <span className="lbp-font-sample">{FONT_SAMPLE}</span>
    </span>
  );
}

export default function FontSelect({ value, weight = 'regular', onChange, metricsFor, disabled = false, id }: FontSelectProps) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const optionId = (i: number) => `${uid}-font-${i}`;

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  };

  // always portaled: the side panels scroll, and a scroll box would clip it
  const { portalHost, dropUp, menuStyle } = useMenuPlacement({
    wrapRef, menuRef: listRef, open, portal: true, onDismiss: () => setOpen(false),
  });
  // as wide as the widest family (never narrower than the trigger), its
  // right edge on the trigger's so it opens toward the canvas
  const placed = menuStyle && typeof menuStyle.left === 'number' && typeof menuStyle.width === 'number'
    ? {
      ...menuStyle, left: 'auto', right: Math.max(0, window.innerWidth - menuStyle.left - menuStyle.width),
      width: 'max-content', minWidth: menuStyle.width,
    }
    : menuStyle;

  // the face of the chosen family, and of every family once the list opens
  const load = useRef(metricsFor);
  load.current = metricsFor;
  useEffect(() => {
    load.current?.(value, weight);
  }, [value, weight]);
  useEffect(() => {
    if (!open) return;
    for (const f of FONT_FAMILIES) load.current?.(f.slug, weight);
  }, [open, weight]);
  // focus the list once it is placed: a hidden element takes no focus
  const shown = open && menuStyle?.visibility !== 'hidden';
  useEffect(() => {
    if (shown) listRef.current?.focus({ preventScroll: true });
  }, [shown]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!wrapRef.current?.contains(t) && !listRef.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open]);

  useEffect(() => {
    if (open) document.getElementById(optionId(active))?.scrollIntoView?.({ block: 'nearest' });
  }, [open, active]); // eslint-disable-line react-hooks/exhaustive-deps

  const openList = () => {
    if (disabled) return;
    setActive(Math.max(0, FONT_FAMILIES.findIndex((f) => f.slug === value)));
    setOpen(true);
  };

  const pick = (family: string) => {
    close(true);
    if (family !== value) onChange(family);
  };

  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      openList();
    }
  };

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const last = FONT_FAMILIES.length - 1;
    switch (e.key) {
      case 'ArrowDown': setActive((a) => Math.min(last, a + 1)); break;
      case 'ArrowUp': setActive((a) => Math.max(0, a - 1)); break;
      case 'Home': setActive(0); break;
      case 'End': setActive(last); break;
      case 'Enter':
      case ' ':
        pick(FONT_FAMILIES[active].slug);
        break;
      case 'Escape':
        close(true);
        break;
      case 'Tab':
        setOpen(false);
        return;
      default:
        return;
    }
    e.preventDefault();
  };

  const label = familyInfo(value)?.label ?? value;
  const menu = (
    <div ref={listRef} className={`combo-menu lbp-font-menu${dropUp ? ' drop-up' : ''}`} style={placed}
      role="listbox" tabIndex={-1} aria-label="Fonts" aria-activedescendant={optionId(active)} onKeyDown={onListKey}>
      {FONT_FAMILIES.map((f, i) => (
        <div key={f.slug} id={optionId(i)} role="option" aria-selected={f.slug === value} aria-label={f.label}
          className={`kbar-item lbp-font-option${i === active ? ' active' : ''}${f.slug === value ? ' selected' : ''}`}
          onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(f.slug)}>
          <Sample family={f.slug} weight={weight} />
          {(f.slug === DEFAULT_FAMILY || f.mono) && <span className="sub">{f.slug === DEFAULT_FAMILY ? 'default' : 'mono'}</span>}
        </div>
      ))}
    </div>
  );

  return (
    <div className="combo-wrap lbp-font-select" ref={wrapRef}>
      <button ref={triggerRef} type="button" id={id} className="org-select lbp-font-trigger" disabled={disabled}
        aria-haspopup="listbox" aria-expanded={open} aria-label={`Font: ${label}`}
        onClick={() => (open ? close(false) : openList())} onKeyDown={onTriggerKey}>
        <Sample family={value} weight={weight} />
        <span className="combo-caret" aria-hidden>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
        </span>
      </button>
      {open && createPortal(menu, portalHost)}
    </div>
  );
}
