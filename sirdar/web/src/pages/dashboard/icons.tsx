/** Inline SVG icons for the Deployments dashboard. Decorative: every icon is
 *  aria-hidden; the text next to it carries the meaning. */
import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 16, children, ...rest }: P) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
         strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
         focusable="false" {...rest}>
      {children}
    </svg>
  );
}

export const RocketIcon = (p: P) => (
  <Svg {...p}>
    <path d="M5 15c-1.5 1.3-2 5-2 5s3.7-.5 5-2c.7-.8.7-2.1-.1-2.9a2.1 2.1 0 0 0-2.9-.1Z" />
    <path d="m12 15-3-3a22 22 0 0 1 2-3.9A12.9 12.9 0 0 1 22 2c0 2.7-.8 7.5-6 11a22.4 22.4 0 0 1-4 2Z" />
    <path d="M9 12H4s.6-3 2-4c1.6-1.1 5 0 5 0" />
    <path d="M12 15v5s3-.6 4-2c1.1-1.6 0-5 0-5" />
  </Svg>
);

export const CloudIcon = (p: P) => (
  <Svg {...p}>
    <path d="M17.5 19H8a6 6 0 1 1 1.3-11.86A6.5 6.5 0 0 1 21.5 11a4 4 0 0 1-4 8Z" fill="currentColor"
          fillOpacity={0.12} />
  </Svg>
);

/** A node with three branches. */
export const LoadBalancerIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="5" cy="12" r="2.6" fill="currentColor" fillOpacity={0.15} />
    <circle cx="19" cy="5" r="2.2" />
    <circle cx="19" cy="12" r="2.2" />
    <circle cx="19" cy="19" r="2.2" />
    <path d="M7.6 12h9.2M7.2 10.6 16.8 5.8M7.2 13.4l9.6 4.8" />
  </Svg>
);

export const ServerRackIcon = (p: P) => (
  <Svg {...p}>
    <rect x="3" y="3" width="18" height="8" rx="2" />
    <rect x="3" y="13" width="18" height="8" rx="2" />
    <path d="M7 7h.01M7 17h.01M11 7h6M11 17h6" />
  </Svg>
);

export const FolderIcon = (p: P) => (
  <Svg {...p}>
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"
          fill="currentColor" fillOpacity={0.15} />
  </Svg>
);

export const DropletIcon = ({ filled, ...p }: P & { filled?: boolean }) => (
  <Svg {...p}>
    <path d="M12 3s6 6.4 6 11a6 6 0 0 1-12 0c0-4.6 6-11 6-11Z"
          fill={filled ? 'currentColor' : 'none'} />
  </Svg>
);

export const DatabaseIcon = (p: P) => (
  <Svg {...p}>
    <ellipse cx="12" cy="5" rx="8" ry="3" />
    <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
    <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
  </Svg>
);

export const BucketIcon = (p: P) => (
  <Svg {...p}>
    <ellipse cx="12" cy="6" rx="8" ry="2.5" />
    <path d="M4 6l2 13c.2 1.2 2.8 2 6 2s5.8-.8 6-2l2-13" />
  </Svg>
);

export const BranchIcon = (p: P) => (
  <Svg {...p}>
    <circle cx="6" cy="6" r="2.2" />
    <circle cx="6" cy="18" r="2.2" />
    <circle cx="18" cy="8" r="2.2" />
    <path d="M6 8.2v7.6M18 10.2c0 4-6 3-11.2 6.2" />
  </Svg>
);

export const ChevronIcon = (p: P) => (
  <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>
);

export const RefreshIcon = (p: P) => (
  <Svg {...p}>
    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
    <path d="M21 3v6h-6" />
  </Svg>
);

export const ExpandIcon = (p: P) => (
  <Svg {...p}><path d="M12 19V5M6 11l6-6 6 6" /></Svg>
);

export const CollapseIcon = (p: P) => (
  <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>
);
