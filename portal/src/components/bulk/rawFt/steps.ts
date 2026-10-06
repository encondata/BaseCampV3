/**
 * RAW_FT_STEPS — the three steps of Bulk Actions › Convert Raw F-T
 * (/bulk/convert-raw-ft): key, step-row label, page title and description.
 * Spec: docs/superpowers/specs/2026-10-06-convert-raw-ft-steps-design.md
 */
export type RawFtStepKey = 'upload' | 'match' | 'download';

export const RAW_FT_STEPS: readonly { key: RawFtStepKey; label: string; title: string; description: string }[] = [
  {
    key: 'upload', label: 'Upload', title: 'Upload the raw F-T',
    description: "Drop in the customer's file. It's read in this browser and never uploaded.",
  },
  {
    key: 'match', label: 'Match', title: 'Match columns',
    description: 'Pick which of our columns each of theirs fills. Suggestions are filled in; change any of them.',
  },
  {
    key: 'download', label: 'Download', title: 'Preview and download',
    description: 'Check the converted rows, then download a file ready for the From-To import.',
  },
];
