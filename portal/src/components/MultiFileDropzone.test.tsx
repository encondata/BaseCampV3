// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { isEml } from '../lib/macropoint';
import MultiFileDropzone from './MultiFileDropzone';

afterEach(cleanup);

function Harness({ onRejected }: { onRejected?: (n: string[]) => void }) {
  const [files, setFiles] = useState<File[]>([]);
  return <MultiFileDropzone files={files} onFiles={setFiles} busy={false} accept=".eml"
                            filter={isEml} onRejected={onRejected} />;
}

const eml = (name: string) => new File(['x'], name, { lastModified: 1 });

it('adds dropped files, rejects others, removes and clears', () => {
  const onRejected = vi.fn();
  const { container } = render(<Harness onRejected={onRejected} />);
  const zone = container.querySelector('.imp-dropzone')!;
  fireEvent.drop(zone, { dataTransfer: { files: [eml('a.eml'), eml('b.eml'), eml('c.pdf')] } });
  expect(screen.getByText('a.eml')).not.toBeNull();
  expect(screen.getByText('b.eml')).not.toBeNull();
  expect(screen.queryByText('c.pdf')).toBeNull();
  expect(onRejected).toHaveBeenCalledWith(['c.pdf']);

  fireEvent.click(screen.getByRole('button', { name: 'Remove a.eml' }));
  expect(screen.queryByText('a.eml')).toBeNull();

  const input = container.querySelector('input[type=file]') as HTMLInputElement;
  expect(input.multiple).toBe(true);
  fireEvent.change(input, { target: { files: [eml('d.eml')] } });
  fireEvent.click(screen.getByRole('button', { name: 'Clear all' }));
  expect(container.querySelectorAll('.imp-file-list li')).toHaveLength(0);
});
