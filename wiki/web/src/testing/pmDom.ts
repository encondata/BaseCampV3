/** jsdom lacks the layout APIs ProseMirror measures with (range rects,
 *  elementFromPoint). Import this from a DOM test that drives a real
 *  editor; the stand-ins report empty rects, which is all tests need. */
const zeroRect = () => ({
  x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0, toJSON: () => ({}),
}) as DOMRect;

if (typeof Range !== 'undefined') {
  Range.prototype.getBoundingClientRect ??= zeroRect;
  Range.prototype.getClientRects ??= () => {
    const list = [] as unknown as DOMRectList;
    Object.assign(list, { item: () => null });
    return list;
  };
}
if (typeof document !== 'undefined') {
  document.elementFromPoint ??= () => null;
}

export {};
