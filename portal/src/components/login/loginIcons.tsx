/**
 * Line icons from the login element sheet (2026-09-28). Decorative only:
 * every icon is aria-hidden, so the control or text beside it carries the
 * accessible name. Stroke uses currentColor; size comes from CSS.
 */
import type { ReactNode } from 'react';

type IconProps = { className?: string };

function Icon({ className, strokeWidth = 1.8, children }: IconProps & { strokeWidth?: number; children: ReactNode }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth}
         strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export function IconBox({ className }: IconProps) {
  return <Icon className={className}><path d="M12 2.5 3.5 7v10l8.5 4.5 8.5-4.5V7L12 2.5Z" /><path d="M3.5 7 12 11.5 20.5 7M12 11.5v10" /></Icon>;
}

export function IconBarChart({ className }: IconProps) {
  return <Icon className={className}><path d="M3 21h18" /><path d="M6 21v-6M10 21V9M14 21V4M18 21v-9" /></Icon>;
}

export function IconShield({ className }: IconProps) {
  return <Icon className={className}><path d="M12 2.5 4.5 5.5v6c0 4.6 3.1 8.4 7.5 10 4.4-1.6 7.5-5.4 7.5-10v-6L12 2.5Z" /><path d="m8.5 12 2.5 2.5 4.5-5" /></Icon>;
}

export function IconTarget({ className }: IconProps) {
  return <Icon className={className}><circle cx="12" cy="12" r="9.5" /><circle cx="12" cy="12" r="5.5" /><circle cx="12" cy="12" r="1.8" fill="currentColor" /></Icon>;
}

export function IconEye({ className }: IconProps) {
  return <Icon className={className}><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></Icon>;
}

export function IconEyeOff({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M3 3l18 18" />
      <path d="M10.6 5.1A10.8 10.8 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.9 0 3.6-.6 5-1.5" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
    </Icon>
  );
}

export function IconLink({ className }: IconProps) {
  return <Icon className={className} strokeWidth={2}><circle cx="17" cy="7" r="3.5" /><circle cx="7" cy="17" r="3.5" /><path d="m9.5 14.5 5-5" /></Icon>;
}

export function IconArrow({ className }: IconProps) {
  return <Icon className={className} strokeWidth={2.2}><path d="M5 12h14M13 6l6 6-6 6" /></Icon>;
}
