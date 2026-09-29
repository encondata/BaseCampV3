/** What was dropped from the operating system, as files with the folder
 *  path they sat in: dropped folders are walked (File and Directory
 *  Entries API, `webkitGetAsEntry`) so the upload can recreate them as
 *  wiki folders. Browsers without entries hand over the plain file list. */

export interface WalkedFile {
  /** Folder names from the drop down to the file ([] = dropped loose). */
  path: string[];
  file: File;
}

/** Operating-system clutter never worth uploading. */
const SKIPPED = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

interface Entry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
}
interface FileEntry extends Entry {
  file: (ok: (file: File) => void, fail: (err: unknown) => void) => void;
}
interface DirectoryEntry extends Entry {
  createReader: () => { readEntries: (ok: (entries: Entry[]) => void, fail: (err: unknown) => void) => void };
}

function readFile(entry: FileEntry): Promise<File | null> {
  return new Promise((resolve) => entry.file(resolve, () => resolve(null)));
}

/** Every child: readEntries hands them over in batches until an empty one. */
async function readAll(dir: DirectoryEntry): Promise<Entry[]> {
  const reader = dir.createReader();
  const all: Entry[] = [];
  for (;;) {
    const batch = await new Promise<Entry[]>((resolve) => reader.readEntries(resolve, () => resolve([])));
    if (!batch.length) return all;
    all.push(...batch);
  }
}

async function walk(entry: Entry, path: string[], out: WalkedFile[]): Promise<void> {
  if (entry.isFile) {
    if (SKIPPED.has(entry.name)) return;
    const file = await readFile(entry as FileEntry);
    if (file) out.push({ path, file });
  } else if (entry.isDirectory) {
    const inner = [...path, entry.name];
    for (const child of await readAll(entry as DirectoryEntry)) await walk(child, inner, out);
  }
}

/** The dropped files, folders walked. Call it from the drop handler
 *  itself: a DataTransfer's entries are only readable during the event. */
export function walkDrop(data: DataTransfer): Promise<WalkedFile[]> {
  const items = Array.from(data.items ?? []).filter((item) => item.kind === 'file');
  const entries = items.map((item) => (item.webkitGetAsEntry?.() ?? null) as Entry | null);
  if (!entries.length || entries.some((e) => e === null)) {
    return Promise.resolve(Array.from(data.files ?? []).map((file) => ({ path: [], file })));
  }
  return (async () => {
    const out: WalkedFile[] = [];
    for (const entry of entries as Entry[]) await walk(entry, [], out);
    return out;
  })();
}
