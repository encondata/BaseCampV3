/** The editor's line icons (24×24, stroke = currentColor), one set shared
 *  by the toolbar, slash menu, bubble and node views. */
import type { ReactNode } from 'react';

const PATHS = {
  undo: <path d="M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3" />,
  redo: <path d="m15 14 5-5-5-5M20 9H9a5 5 0 0 0 0 10h3" />,
  bold: <path d="M7 5h6a3.5 3.5 0 0 1 0 7H7zM7 12h7a3.5 3.5 0 0 1 0 7H7z" />,
  italic: <path d="M11 5h6M7 19h6M14 5l-4 14" />,
  underline: <path d="M7 4v7a5 5 0 0 0 10 0V4M5 20h14" />,
  strike: <path d="M5 12h14M16.5 7.5C16 5.9 14.3 5 12 5c-2.8 0-4.5 1.3-4.5 3.2 0 1.4 1 2.3 2.6 2.8M8 16.3c.6 1.7 2.3 2.7 4.3 2.7 2.8 0 4.7-1.3 4.7-3.4 0-.8-.3-1.5-.8-2" />,
  code: <path d="m9 8-4 4 4 4M15 8l4 4-4 4" />,
  highlight: <><path d="m9 11-5 5v3h3l5-5" /><path d="m9 11 6-6 4 4-6 6z" /><path d="M14 20h6" /></>,
  bulletList: <><path d="M9 6h11M9 12h11M9 18h11" /><circle cx="4.5" cy="6" r="1" /><circle cx="4.5" cy="12" r="1" /><circle cx="4.5" cy="18" r="1" /></>,
  orderedList: <path d="M10 6h10M10 12h10M10 18h10M4 5l1.5-1v5M3.5 14.5c.3-.9 2.5-1.2 2.5.3 0 1-2.5 2-2.5 3.2h2.6" />,
  taskList: <><rect x="3.5" y="4.5" width="5" height="5" rx="1.2" /><path d="m4.8 17 1.4 1.4 2.6-2.8M12 7h8M12 17h8" /></>,
  alignLeft: <path d="M4 6h16M4 10h10M4 14h16M4 18h10" />,
  alignCenter: <path d="M4 6h16M7 10h10M4 14h16M7 18h10" />,
  alignRight: <path d="M4 6h16M10 10h10M4 14h16M10 18h10" />,
  alignJustify: <path d="M4 6h16M4 10h16M4 14h16M4 18h16" />,
  link: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />,
  unlink: <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1M4 4l16 16" />,
  image: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><circle cx="9" cy="10" r="1.6" /><path d="m20.5 16-5-5-9 8.5" /></>,
  file: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></>,
  paperclip: <path d="m20 11.5-7.8 7.8a5 5 0 0 1-7.1-7.1l8.3-8.3a3.4 3.4 0 0 1 4.8 4.8l-8.3 8.3a1.7 1.7 0 0 1-2.4-2.4l7.4-7.4" />,
  table: <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10M15 9.5v10" /></>,
  callout: <><rect x="3.5" y="4.5" width="17" height="15" rx="3" /><path d="M12 9v4M12 16h.01" /></>,
  codeBlock: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="m9.5 10-2 2 2 2M14.5 10l2 2-2 2" /></>,
  details: <path d="m6 8 4 4-4 4M13 8h7M13 12h7M13 16h5" />,
  divider: <path d="M4 12h16M8 7h8M8 17h8" strokeOpacity="1" />,
  pageLink: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M10.5 15.5a2 2 0 0 0 2.8 0l1.5-1.5a2 2 0 0 0-2.8-2.8l-.5.5" /></>,
  paragraph: <path d="M5 6h14M5 12h14M5 18h9" />,
  heading1: <path d="M4 6v12M12 6v12M4 12h8M16.5 10l2.5-2v10" />,
  heading2: <path d="M4 6v12M12 6v12M4 12h8M16 10c.4-1.3 4-1.7 4 .5 0 1.6-4 3.4-4 5.5h4" />,
  heading3: <path d="M4 6v12M12 6v12M4 12h8M16 9h4l-2.5 3a2.2 2.2 0 1 1-1.6 3.8" />,
  quote: <path d="M7 7h4v4c0 3-1.5 5-4 6M14 7h4v4c0 3-1.5 5-4 6" />,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronRight: <path d="m9 6 6 6-6 6" />,
  plus: <path d="M12 5v14M5 12h14" />,
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />,
  rowAbove: <><rect x="4" y="11" width="16" height="9" rx="1.5" /><path d="M12 3v6M9 6h6" /></>,
  rowBelow: <><rect x="4" y="4" width="16" height="9" rx="1.5" /><path d="M12 15v6M9 18h6" /></>,
  colLeft: <><rect x="11" y="4" width="9" height="16" rx="1.5" /><path d="M3 12h6M6 9v6" /></>,
  colRight: <><rect x="4" y="4" width="9" height="16" rx="1.5" /><path d="M15 12h6M18 9v6" /></>,
  rowDelete: <><rect x="4" y="8" width="16" height="8" rx="1.5" /><path d="m10 10 4 4M14 10l-4 4" /></>,
  colDelete: <><rect x="8" y="4" width="8" height="16" rx="1.5" /><path d="m10 10 4 4M14 10l-4 4" /></>,
  headerRow: <><rect x="4" y="4" width="16" height="16" rx="1.5" /><path d="M4 9.5h16" /><path d="M4 4h16v5.5H4z" fill="currentColor" fillOpacity="0.25" /></>,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5M12 8h.01" /></>,
  tip: <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z" />,
  warning: <path d="M12 4 2.8 19.5h18.4zM12 10v4M12 17h.01" />,
  danger: <><circle cx="12" cy="12" r="8.5" /><path d="m9 9 6 6M15 9l-6 6" /></>,
  external: <path d="M14 4h6v6M20 4l-9 9M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />,
  download: <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></>,
  upload: <path d="M12 16V4M7 9l5-5 5 5M5 20h14" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></>,
  star: <path d="m12 3.8 2.5 5.1 5.6.8-4 4 1 5.5-5.1-2.7-5 2.7.9-5.5-4-4 5.6-.8z" />,
  history: <path d="M3.5 12a8.5 8.5 0 1 0 2.5-6M3.5 4.5V9H8M12 8v4.5l3 2" />,
  more: <><circle cx="5.5" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="18.5" cy="12" r="1.3" /></>,
  text: <path d="M5 7V5h14v2M12 5v14M9 19h6" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg className={className ?? 'we-icon'} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
