/** Inline SVG icons for tree rows and lists: folder, page, and a file drawn
 *  by its type (PDF, image, video, office document, anything else). */
import type { NodeOut, SpaceOut } from '../lib/types';

export type FileType = 'pdf' | 'image' | 'video' | 'doc' | 'sheet' | 'slides' | 'other';

const EXT: Record<string, FileType> = {
  pdf: 'pdf',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', svg: 'image', heic: 'image',
  mp4: 'video', mov: 'video', webm: 'video', m4v: 'video', avi: 'video',
  doc: 'doc', docx: 'doc', odt: 'doc', rtf: 'doc', txt: 'doc', md: 'doc',
  xls: 'sheet', xlsx: 'sheet', ods: 'sheet', csv: 'sheet',
  ppt: 'slides', pptx: 'slides', odp: 'slides',
};

export function fileType(contentType: string | null | undefined, filename?: string | null): FileType {
  const ct = (contentType ?? '').toLowerCase();
  if (ct === 'application/pdf') return 'pdf';
  if (ct.startsWith('image/')) return 'image';
  if (ct.startsWith('video/')) return 'video';
  if (ct.includes('spreadsheet') || ct.includes('excel') || ct === 'text/csv') return 'sheet';
  if (ct.includes('presentation') || ct.includes('powerpoint')) return 'slides';
  if (ct.includes('wordprocessing') || ct === 'application/msword') return 'doc';
  const ext = (filename ?? '').split('.').pop()?.toLowerCase() ?? '';
  return EXT[ext] ?? 'other';
}

const FILE_LABEL: Record<FileType, string> = {
  pdf: 'PDF', image: 'Image', video: 'Video', doc: 'Document', sheet: 'Spreadsheet',
  slides: 'Presentation', other: 'File',
};

/** "Folder", "Page", or the file's type ("PDF", "Image", …). */
export function nodeTypeLabel(node: Pick<NodeOut, 'kind' | 'file' | 'title'>): string {
  if (node.kind === 'folder') return 'Folder';
  if (node.kind === 'page') return 'Page';
  const v = node.file?.current_version;
  return FILE_LABEL[fileType(v?.content_type, v?.filename ?? node.title)];
}

const S = {
  fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
  strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
};

/** The dog-eared sheet every file icon starts from. */
const SHEET = <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></>;

function glyph(kind: NodeOut['kind'], type: FileType) {
  if (kind === 'folder') {
    return <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />;
  }
  if (kind === 'page') {
    return <>{SHEET}<path d="M8.5 13h7M8.5 16.5h5" /></>;
  }
  switch (type) {
    case 'pdf':
      return <>{SHEET}<path d="M8.5 17v-4h1.5a1.2 1.2 0 0 1 0 2.4H8.5M13 13v4h1a2 2 0 0 0 0-4z" /></>;
    case 'image':
      return <><rect x="3.5" y="4.5" width="17" height="15" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="m20.5 16-4.5-4.5L6 19.5" /></>;
    case 'video':
      return <><rect x="3" y="5.5" width="13" height="13" rx="2" /><path d="m16 10 5-3v10l-5-3z" /></>;
    case 'sheet':
      return <>{SHEET}<path d="M8 12h8M8 15.5h8M12 12v6" /></>;
    case 'slides':
      return <>{SHEET}<rect x="8" y="12" width="8" height="5" rx="0.8" /></>;
    case 'doc':
      return <>{SHEET}<path d="M8.5 12h7M8.5 14.8h7M8.5 17.6h4" /></>;
    default:
      return SHEET;
  }
}

export default function NodeIcon({ node, className }: {
  node: Pick<NodeOut, 'kind' | 'file' | 'title'>;
  className?: string;
}) {
  const v = node.file?.current_version;
  const type = node.kind === 'file' ? fileType(v?.content_type, v?.filename ?? node.title) : 'other';
  const variant = node.kind === 'file' ? `file-${type}` : node.kind;
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={`node-icon node-icon-${variant}${className ? ` ${className}` : ''}`} {...S}>
      {glyph(node.kind, type)}
    </svg>
  );
}

/** A space's emoji (or initial) on its color. */
export function SpaceBadge({ space, size }: { space: Pick<SpaceOut, 'icon' | 'name' | 'color'>; size?: 'lg' | 'sm' }) {
  return (
    <span className={`wiki-space-badge${size ? ` ${size}` : ''}`}
          style={{ ['--space-color' as string]: space.color ?? undefined }} aria-hidden="true">
      {space.icon || space.name.slice(0, 1).toUpperCase()}
    </span>
  );
}
