/**
 * Focus for the task sheet (`.pln-sheet`) that isn't a Tab into it: a
 * toolbar command handing focus back (usePlanCommands' focusSheet), a
 * dialog closing on the sheet that opened it (PlanModal). The sheet's focus
 * handler selects the first row when nothing is selected, as a Tab in
 * should, and scrolls up to it; `data-quiet-focus`, set for the length of
 * the focus() call, tells it this focus isn't one. No scroll either.
 */
export function focusQuietly(el: HTMLElement): void {
  el.dataset.quietFocus = '1';
  try {
    el.focus({ preventScroll: true });
  } finally {
    delete el.dataset.quietFocus;
  }
}
