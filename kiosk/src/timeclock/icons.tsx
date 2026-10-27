/**
 * The time clock's icons, drawn in code so they stay sharp at any size in
 * either orientation. Every one is decorative (`aria-hidden`): the button
 * or heading beside it carries the words.
 */

import type { ReactNode, SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function Svg({ children, viewBox = '0 0 48 48', ...rest }: IconProps & { children: ReactNode }) {
  return (
    <svg viewBox={viewBox} fill="none" aria-hidden="true" focusable="false" {...rest}>
      {children}
    </svg>
  );
}

export function IconQr(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 14V6h8M36 6h8v8M44 34v8h-8M12 42H4v-8" stroke="var(--tcx-amber)" strokeWidth="4" strokeLinecap="round" />
      <rect x="13" y="13" width="8" height="8" stroke="var(--tcx-ink)" strokeWidth="3" />
      <rect x="27" y="13" width="8" height="8" stroke="var(--tcx-ink)" strokeWidth="3" />
      <rect x="13" y="27" width="8" height="8" stroke="var(--tcx-ink)" strokeWidth="3" />
      <path d="M27 27h3v3h-3zM32 32h3v3h-3zM27 33h3v2h-3zM33 27h2v3h-2z" fill="var(--tcx-ink)" />
    </Svg>
  );
}

export function IconKeyboard(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="12" width="40" height="26" rx="4" stroke="var(--tcx-ink)" strokeWidth="3.5" />
      <g fill="var(--tcx-ink)">
        <rect x="10" y="18" width="4" height="4" /><rect x="17" y="18" width="4" height="4" />
        <rect x="24" y="18" width="4" height="4" /><rect x="31" y="18" width="4" height="4" />
        <rect x="10" y="25" width="4" height="4" /><rect x="17" y="25" width="4" height="4" />
        <rect x="24" y="25" width="4" height="4" /><rect x="31" y="25" width="4" height="4" />
        <rect x="15" y="31" width="18" height="3" />
      </g>
    </Svg>
  );
}

/** The Enter Your Name keyboard toggle: a small keyboard in the current
 *  text color, so it reads on both the light and the pressed (ink) button. */
export function IconKeyboardToggle(props: IconProps) {
  return (
    <Svg viewBox="0 0 24 24" {...props}>
      <rect x="2.5" y="6" width="19" height="12" rx="2.4" stroke="currentColor" strokeWidth="2" />
      <path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M6.5 13.5h.01M17.5 13.5h.01M9.5 14h5"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </Svg>
  );
}

export function IconChevron(props: IconProps) {
  return (
    <Svg viewBox="0 0 24 24" {...props}>
      <path d="M9 5l7 7-7 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function IconArrowLeft(props: IconProps) {
  return (
    <Svg viewBox="0 0 24 24" {...props}>
      <path d="M19 12H5m6-6l-6 6 6 6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function IconArrowRight(props: IconProps) {
  return (
    <Svg viewBox="0 0 24 24" {...props}>
      <path d="M5 12h14m-6-6l6 6-6 6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function IconSearch(props: IconProps) {
  return (
    <Svg viewBox="0 0 24 24" {...props}>
      <circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" strokeWidth="2.4" />
      <path d="M15.5 15.5L21 21" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </Svg>
  );
}

export function IconGear(props: IconProps) {
  return (
    <Svg viewBox="0 0 24 24" {...props}>
      <circle cx="12" cy="12" r="3.2" stroke="currentColor" strokeWidth="2" />
      <path
        d="M12 2.5v2.6M12 18.9v2.6M21.5 12h-2.6M5.1 12H2.5M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8M18.7 18.7l-1.8-1.8M7.1 7.1L5.3 5.3"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round"
      />
      <circle cx="12" cy="12" r="6.6" stroke="currentColor" strokeWidth="2" />
    </Svg>
  );
}

export function IconShift(props: IconProps) {
  return (
    <Svg viewBox="0 0 24 24" {...props}>
      <path d="M12 4l8 8h-4.5v8h-7v-8H4z" fill="currentColor" />
    </Svg>
  );
}

export function IconBackspace(props: IconProps) {
  return (
    <Svg viewBox="0 0 24 24" {...props}>
      <path d="M8 5h12a1 1 0 011 1v12a1 1 0 01-1 1H8l-6-7z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M11 9l6 6m0-6l-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </Svg>
  );
}

/** A clock face: green on the Clock In tile. */
export function IconClockIn(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="24" cy="24" r="18" stroke="currentColor" strokeWidth="4" />
      <path d="M24 13v12l7 4" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

/** A clock face with a turning arrow: red on the Clock Out tile. */
export function IconClockOut(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M41 26a17 17 0 11-5-14" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
      <path d="M38 4v9h-9" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M24 15v11l6 4" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="24" cy="24" r="22" fill="var(--tcx-green)" />
      <path d="M14 25l7 7 13-15" stroke="#fff" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function IconPrinter(props: IconProps) {
  return (
    <Svg viewBox="0 0 64 64" {...props}>
      <rect x="18" y="6" width="28" height="16" rx="2" fill="#fff" stroke="var(--tcx-ink)" strokeWidth="3" />
      <rect x="6" y="20" width="52" height="26" rx="6" fill="var(--tcx-ink)" />
      <rect x="16" y="36" width="32" height="24" rx="2" fill="#fff" stroke="var(--tcx-ink)" strokeWidth="3" />
      <circle cx="32" cy="45" r="4" fill="var(--tcx-ink)" />
      <path d="M24 56c1-5 4-7 8-7s7 2 8 7" fill="var(--tcx-ink)" />
      <circle cx="50" cy="28" r="2.5" fill="var(--tcx-amber)" />
    </Svg>
  );
}

export function IconBadgeTap(props: IconProps) {
  return (
    <Svg viewBox="0 0 64 64" {...props}>
      <rect x="6" y="10" width="30" height="44" rx="5" fill="#334155" />
      <path d="M15 26a9 9 0 0112 0M12 22a14 14 0 0118 0M18 30a4 4 0 016 0" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
      <rect x="28" y="20" width="26" height="36" rx="4" fill="#fff" stroke="var(--tcx-ink)" strokeWidth="2.5" transform="rotate(12 41 38)" />
      <circle cx="42" cy="34" r="4" fill="var(--tcx-ink)" />
      <path d="M35 46c1.5-4 4-6 7-6s5.5 2 7 6" fill="var(--tcx-ink)" />
      <path d="M50 8l-4 6M56 14l-6 3" stroke="var(--tcx-blue)" strokeWidth="2.4" strokeLinecap="round" />
    </Svg>
  );
}

export function IconAlert(props: IconProps) {
  return (
    <Svg viewBox="0 0 24 24" {...props}>
      <path d="M12 4l9 16H3L12 4z" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
      <path d="M12 10v4.5M12 17.2v.1" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </Svg>
  );
}

export function IconMail(props: IconProps) {
  return (
    <Svg viewBox="0 0 24 24" {...props}>
      <rect x="3" y="5.5" width="18" height="13" rx="2.5" stroke="currentColor" strokeWidth="2.2" />
      <path d="M4 7.5l8 6 8-6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function IconShield(props: IconProps) {
  return (
    <Svg viewBox="0 0 24 24" {...props}>
      <path d="M12 3l7.5 3v5.5c0 4.6-3.1 8-7.5 9.5-4.4-1.5-7.5-4.9-7.5-9.5V6L12 3z" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
      <path d="M8.8 12.2l2.2 2.2 4.2-4.6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

export function IconClose(props: IconProps) {
  return (
    <Svg viewBox="0 0 24 24" {...props}>
      <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </Svg>
  );
}
