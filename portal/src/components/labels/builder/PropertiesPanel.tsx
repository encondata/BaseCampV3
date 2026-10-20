/**
 * The builder's right panel (spec §4.2, §4.6): every property of the
 * selected element in the design's JSON (model.ts), shown for the element
 * picked last. With several selected, a change goes to each of them that
 * has the property (builderEdits patchElements); a choice the selection
 * doesn't share shows none of its options pressed.
 *
 * Positions, sizes, strokes, barcode modules and inverted padding are in
 * dots at the DPI being viewed, and every number box takes arithmetic
 * (NumberBox). W and H go through the canvas's own resize rules, so a text
 * element's height scales its font size and a QR code stays square. A
 * barcode is as wide as it prints its sample (geometry.ts
 * withBarcodeWidths): its length is read-only, Module sets it, and H (W
 * when it is turned) is the bar height; every edit here keeps each
 * barcode's width in step. A text
 * field is refit whenever its font, size, weight, inverted or expected
 * length changes, keeping it as wide as it reserves. Display type Split
 * turns a placement into one placement per piece of its sample.
 *
 * An image (ID badges in ZPL only, `imagesAllowed`; spec
 * 2026-10-20-badge-templates §4.3): its Source (the sample person's photo
 * or logo, or a static picture from the label image library, with
 * Upload…), Fit, Look (a photo's dither or a logo's threshold),
 * Brightness, Contrast, the logo look's Threshold and Invert. Switching
 * the source takes that source's fit and look (builderEdits
 * imageSourcePatch). Anywhere else an image says it doesn't print there.
 */

import { useRef } from 'react';
import type { ReactNode } from 'react';

import {
  barcodeModuleDots, barcodeWidthIn, footprint, isBarcode, resize, withBarcodeWidths, type ResizeContext,
} from '../../../labels/builder/geometry';
import type { DitherMode } from '../../../labels/builder/dither';
import { imageName, samplePersonId } from '../../../labels/builder/image';
import {
  MAX_COUNT, MAX_LINES, elementValue, imageFit, imageParams, invertPadOf, renamePiece, replaceElements,
  type Align, type DesignV2, type ElementPatch, type ElementV2, type FieldElement, type ImageElement,
  type ImageFit, type ImageSource, type Rotation, type StripWhere, type Symbology, type TextElement, type Trim,
} from '../../../labels/builder/model';
import { QR_FO_OFFSET_IN, qrTooHigh } from '../../../labels/builder/qr';
import { toDots } from '../../../labels/builder/units';
import type { LabelFields } from '../../../lib/api';
import '../../../styles/directory.css';
import '../../../styles/labelBuilder.css';
import '../../../styles/settings.css';   /* .switch */
import ComboBox from '../../ComboBox';
import { Switch } from '../../Switch';
import {
  canSplit, fontOf, imageSourcePatch, isTypeset, patchElements, setDisplay, type DisplayChoice, type Patch,
} from './builderEdits';
import type { MetricsFor } from './Canvas';
import { Segmented, TextBox, type SegmentedOption } from './controls';
import { catalogGroups, fieldLabel, pieceNames, sampleOf } from './fieldCatalog';
import FontSelect from './FontSelect';
import ImageLibraryPicker from './ImageLibraryPicker';
import { useRasterProblem } from './imageRaster';
import NumberBox, { type NumberApply } from './NumberBox';

export interface PropertiesPanelProps {
  design: DesignV2;
  /** Selected ids in the order picked; the last one's values show. */
  selection: readonly string[];
  samples: Readonly<Record<string, string>>;
  fields: LabelFields | null;
  /** The DPI being viewed: positions and sizes show in its dots. */
  dpi: number;
  metricsFor: MetricsFor;
  onChange: (design: DesignV2) => void;
  /** An edit that lands later than the render it started in (a library
   *  upload's pick), worked out from the page's design as it is then. The
   *  page drops it while read-only. Without it the panel works it out from
   *  the latest design it was given and sends it through `onChange`. */
  onUpdate?: (edit: (present: DesignV2) => DesignV2) => void;
  /** The selection after Split replaced a placement with its pieces. */
  onSelect: (ids: string[]) => void;
  /** The template's label type (for a barcode's or QR code's field list). */
  labelType?: string;
  /** The template takes images: an ID badge in ZPL. */
  imagesAllowed?: boolean;
  readOnly?: boolean;
  /** A dialog of the panel's own opened (true) or closed (false): the
   *  image library's Delete…; the page turns the canvas keys off meanwhile. */
  onDialog?: (open: boolean) => void;
}

const DISPLAYS: SegmentedOption<DisplayChoice>[] = [
  { value: 'text', label: 'Text' }, { value: 'number', label: 'Number' },
  { value: 'barcode', label: 'Barcode' }, { value: 'qr', label: 'QR' },
];
const WEIGHTS: SegmentedOption<'regular' | 'bold'>[] = [{ value: 'regular', label: 'Normal' }, { value: 'bold', label: 'Bold' }];
const ALIGNS: SegmentedOption<Align>[] = [
  { value: 'left', label: 'Left' }, { value: 'center', label: 'Center' }, { value: 'right', label: 'Right' },
];
const TRIMS: SegmentedOption<Trim>[] = [{ value: 'front', label: 'Trim front' }, { value: 'rear', label: 'Trim rear' }];
const STRIP_WHERES: SegmentedOption<StripWhere>[] = [
  { value: 'front', label: 'Front' }, { value: 'rear', label: 'Rear' }, { value: 'anywhere', label: 'Anywhere' },
];
const SYMBOLOGIES: SegmentedOption<Symbology>[] = [{ value: 'code128', label: 'Code 128' }, { value: 'code39', label: 'Code 39' }];
const ROTATIONS: SegmentedOption<Rotation>[] = [0, 90, 180, 270].map((r) => ({ value: r as Rotation, label: `${r}°` }));
const SOURCES: SegmentedOption<'field' | 'data'>[] = [{ value: 'field', label: 'Field' }, { value: 'data', label: 'Static data' }];
const IMAGE_SOURCES: SegmentedOption<ImageSource>[] = [
  { value: 'photo', label: 'Photo', title: 'The sample person’s photo' },
  { value: 'logo', label: 'Logo', title: 'The sample person’s logo: the company’s for staff, the partner’s for a worker' },
  { value: 'static', label: 'Static image', title: 'A picture from the label image library, the same on every badge' },
];
const FITS: SegmentedOption<ImageFit>[] = [
  { value: 'cover', label: 'Fill', title: 'Fill the box, cropping what spills over' },
  { value: 'contain', label: 'Fit', title: 'Fit the whole picture inside the box, white round it' },
];
const LOOKS: SegmentedOption<DitherMode>[] = [
  { value: 'dither', label: 'Photo', title: 'Dots spread to show shades of gray' },
  { value: 'threshold', label: 'Logo', title: 'Each dot black or white at the threshold: crisp edges' },
];

const STATIC_DATA = '12345678';

const isFieldEl = (e: ElementV2) => e.type === 'field';
const isImage = (e: ElementV2): e is ImageElement => e.type === 'image';
const invertedText = (e: ElementV2) => isTypeset(e) && !!e.inverted;

function Prop({ label, children, note, warning }: {
  label: string; children: ReactNode; note?: ReactNode; warning?: ReactNode;
}) {
  return (
    <div className="lbp-prop">
      <div className="lbp-prop-label">{label}</div>
      <div className="lbp-prop-controls">{children}</div>
      {note && <div className="lbp-hint">{note}</div>}
      {warning && <div className="lbp-hint is-warning" role="status">{warning}</div>}
    </div>
  );
}

const QR_TOO_HIGH = `Too close to the top edge: the printer can't print a QR code higher than ${QR_FO_OFFSET_IN} in from the top`;

/** A QR code (or a field shown as one) whose symbol the printer can't put
 *  where it is drawn: nearer the top edge than its ^FO offset (qr.ts). */
function qrWarning(el: ElementV2, value: string, dpi: number): string | undefined {
  const isQr = el.type === 'qr' || (el.type === 'field' && el.display === 'qr');
  return isQr && qrTooHigh(el, value, dpi) ? QR_TOO_HIGH : undefined;
}

function kindName(el: ElementV2): string {
  switch (el.type) {
    case 'field': return el.piece != null ? 'Split piece' : 'Field';
    case 'text': return 'Static text';
    case 'barcode': return 'Barcode';
    case 'qr': return 'QR code';
    case 'line': return 'Line';
    case 'image': return imageName(el);
    default: return 'Box';
  }
}

/** The hint under a barcode's position and size. */
function barcodeHint(el: ElementV2, value: string, dpi: number): string {
  const width = barcodeWidthIn(el, value, dpi);
  if (width === null) return 'Width follows the data: no sample value, so nothing prints.';
  const chars = [...value].length;
  return `Width follows the data: ${chars} character${chars === 1 ? '' : 's'} → ${toDots(width, dpi)} dots at this DPI.`;
}

export default function PropertiesPanel({
  design: given, selection, samples, fields, dpi, metricsFor, onChange: emit, onUpdate, onSelect, labelType,
  imagesAllowed = false, readOnly = false, onDialog,
}: PropertiesPanelProps) {
  // every barcode as wide as it prints, here and in every edit sent up
  const design = withBarcodeWidths(given, samples, dpi);
  const onChange = (next: DesignV2) => emit(withBarcodeWidths(next, samples, dpi));
  // what an edit that lands later works from: this render's, read when it lands
  const latest = useRef({ design, onChange, readOnly });
  latest.current = { design, onChange, readOnly };
  const update = (edit: (present: DesignV2) => DesignV2) => {
    if (onUpdate) {
      onUpdate(edit);
      return;
    }
    const now = latest.current;
    if (now.readOnly) return;
    const next = edit(now.design);
    if (next !== now.design) now.onChange(next);
  };
  const byId = new Map(design.elements.map((e) => [e.id, e]));
  const picked = selection.map((id) => byId.get(id)).filter((e): e is ElementV2 => !!e);
  const el = picked[picked.length - 1];
  const ids = picked.map((e) => e.id);
  // why the canvas can't draw the selected picture, said here too (the
  // canvas's own note is a tooltip only)
  const rasterProblem = useRasterProblem(el && isImage(el) ? el : null, dpi, samplePersonId(samples));

  const apply = (p: Patch) => {
    if (readOnly) return;
    const next = patchElements(design, ids, p, metricsFor);
    if (next !== design) onChange(next);
  };

  /** A library picture for the static images among `forIds` (the
   *  selection when the pick began: an upload lands later), patched into
   *  the design as it is then, so nothing done meanwhile is undone. */
  const pickImage = (imageId: string, forIds: readonly string[]) => {
    if (readOnly) return;
    update((d) => patchElements(d, forIds,
      (e) => (isImage(e) && e.source === 'static' ? { imageId } : null), metricsFor));
  };

  /** True when the selection doesn't share `of`'s value. */
  const mixed = (of: (e: ElementV2) => unknown, among: (e: ElementV2) => boolean = () => true) => {
    const values = picked.filter(among).map((e) => JSON.stringify(of(e) ?? null));
    return values.some((v) => v !== values[0]);
  };

  const resizeCtx: ResizeContext = {
    dpi,
    metricsFor: (e) => {
      const f = fontOf(e);
      return metricsFor(f.family, f.weight)?.metrics ?? null;
    },
    valueFor: (e) => elementValue(e, samples),
  };

  /** A number property over the selection (the elements `has` picks): the
   *  last-picked one's value, Mixed when theirs differ, and an edit worked
   *  out from each element's own value, so `+15` adds 15 to each. */
  const numberOf = (has: (e: ElementV2) => boolean, get: (e: ElementV2) => number | null,
    set: (e: ElementV2, v: number | null) => ElementPatch | null) => {
    const values = picked.filter(has).map(get);
    return {
      value: el && has(el) ? get(el) : values[0] ?? null,
      mixed: values.some((v) => v !== values[0]),
      onCommitEach: (edit: NumberApply) => apply((e) => (has(e) ? set(e, edit(get(e))) : null)),
    };
  };

  /** Each unlocked element's footprint W or H in dots, resized by the
   *  canvas's rules (geometry.ts) exactly as a drag of the E or S handle: a
   *  text height scales the font size, a QR code stays square. */
  const sizeOf = (dim: 'w' | 'h') => {
    const dotsOf = (e: ElementV2) => toDots(footprint(e)[dim], dpi);
    const values = picked.map(dotsOf);
    return {
      value: el ? dotsOf(el) : null,
      mixed: values.some((v) => v !== values[0]),
      onCommitEach: (edit: NumberApply) => {
        if (readOnly) return;
        const changed = picked.filter((e) => !e.locked).flatMap((e) => {
          const fp = footprint(e);
          const want = Math.max(1, edit(dotsOf(e)) ?? 1) / dpi;
          // the side handle for the one dimension: the corner takes the larger
          // of the two, so a QR code could only grow
          const out = dim === 'w'
            ? resize(e, 'e', want - fp.w, 0, resizeCtx)
            : resize(e, 's', 0, want - fp.h, resizeCtx);
          return JSON.stringify(out) === JSON.stringify(e) ? [] : [out];
        });
        if (changed.length) onChange(replaceElements(design, changed));
      },
    };
  };

  if (!el) {
    return (
      <aside className="lbp lbp-props" aria-label="Properties">
        <div className="lbp-title"><span>Properties</span></div>
        <div className="lbp-empty">Select something on the label to edit it here. ⇧-click or drag a box to select several.</div>
      </aside>
    );
  }

  const isField = el.type === 'field';
  const field = isField ? el as FieldElement : null;
  const textEl = el.type === 'text' ? el as TextElement : null;
  const typeset = isTypeset(el);
  const font = fontOf(el);
  const pieces = field ? pieceNames(design, field.field) : [];

  const title = field
    ? (field.piece != null ? pieces[field.piece] ?? `Piece ${field.piece + 1}` : fieldLabel(fields, field.field))
    : (el.type === 'barcode' || el.type === 'qr') && el.field ? fieldLabel(fields, el.field) : kindName(el);

  const setDisplayTo = (choice: DisplayChoice) => {
    if (readOnly) return;
    const out = setDisplay(design, ids, choice, samples, metricsFor);
    if (out.design === design) return;
    onChange(out.design);
    if (choice === 'split') onSelect(out.ids);
  };

  const displayOptions: SegmentedOption<DisplayChoice>[] = field && field.piece == null
    ? [...DISPLAYS, {
      value: 'split', label: 'Split', disabled: !canSplit(design, field, samples),
      title: canSplit(design, field, samples) ? 'One placement per piece of the sample, split on “.”'
        : 'Split needs a sample with dots in it, such as 14.01.07C.02.03',
    }]
    : DISPLAYS;

  const allFields = catalogGroups(fields, design, labelType).flatMap((g) => g.fields
    .map((f) => ({ value: f.key, label: f.label, sub: g.label })));

  const sourceOf = (e: ElementV2) => ((e.type === 'barcode' || e.type === 'qr') && e.field ? 'field' : 'data');
  const barcodeOptions = isBarcode(el);
  // a barcode's length (W, or H when turned) follows its data
  const turned = el.rotation === 90 || el.rotation === 270;
  const lengthBox = barcodeOptions ? (turned ? 'h' : 'w') : null;
  const symbology = 'symbology' in el ? el.symbology ?? 'code128' : 'code128';
  const image = isImage(el) ? el : null;
  const look = image ? imageParams(image) : null;
  const hides = isField || el.type === 'barcode' || el.type === 'qr' || el.type === 'image';
  const noPerson = !!image && image.source !== 'static' && !samplePersonId(samples);

  return (
    <aside className="lbp lbp-props" aria-label="Properties">
      <div className="lbp-title">
        <span>Properties</span>
        {picked.length > 1 && <span className="lbp-hint">{picked.length} selected</span>}
      </div>
      <div className="lbp-scroll">
        <div className="lbp-props-top">
          <h3 className="lbp-subject">{title}</h3>
          <span className="lbp-hint">{picked.length > 1 ? 'Last picked · changes go to all' : kindName(el)}</span>
        </div>

        {field && (
          <Prop label="Field">
            <span className="lbp-static">
              {field.piece != null
                ? `${fieldLabel(fields, field.field)} › piece ${field.piece + 1}`
                : fieldLabel(fields, field.field)}
            </span>
          </Prop>
        )}
        {field && field.piece != null && (
          <Prop label="Name of this piece" note="The name shows wherever this piece is placed.">
            <TextBox ariaLabel="Name of this piece" value={pieces[field.piece] ?? ''} disabled={readOnly}
              onCommit={(name) => {
                if (name.trim()) onChange(renamePiece(design, field.field, field.piece!, name.trim()));
              }} />
          </Prop>
        )}
        {field && (
          <Prop label="Display type">
            <Segmented label="Display type" options={displayOptions} value={field.display} disabled={readOnly}
              mixed={mixed((e) => (e.type === 'field' ? e.display : null), (e) => e.type === 'field')}
              onChange={setDisplayTo} />
          </Prop>
        )}

        {textEl && (
          <>
            <Prop label="Content">
              <TextBox multiline ariaLabel="Content" value={textEl.content} disabled={readOnly}
                onCommit={(content) => apply({ content })} />
            </Prop>
            <Prop label="Lines" note="More than one wraps the text in its box (^FB).">
              <NumberBox ariaLabel="Lines" integer min={1} max={MAX_LINES} disabled={readOnly}
                {...numberOf((e) => e.type === 'text', (e) => (e.type === 'text' ? e.lines ?? 1 : null),
                  (_, v) => ({ lines: v ?? 1 }))} />
            </Prop>
          </>
        )}

        {typeset && (
          <>
            <Prop label="Font">
              <FontSelect value={font.family} weight={font.weight} metricsFor={metricsFor} disabled={readOnly}
                onChange={(family) => apply((e) => ({ font: { family, weight: fontOf(e).weight } }))} />
            </Prop>
            <Prop label="Size · Weight · Inverted">
              <NumberBox ariaLabel="Size (pt)" min={1} max={400} disabled={readOnly}
                {...numberOf(isTypeset, (e) => (e.type === 'text' || e.type === 'field' ? e.sizePt ?? null : null),
                  (_, v) => (v ? { sizePt: v } : null))} />
              <span className="lbp-unit">pt</span>
              <Segmented label="Weight" options={WEIGHTS} value={font.weight} disabled={readOnly}
                mixed={mixed((e) => fontOf(e).weight, isTypeset)}
                onChange={(weight) => apply((e) => ({ font: { ...fontOf(e), weight } }))} />
              <label className="lbp-switch">
                <Switch label="Inverted" checked={'inverted' in el && !!el.inverted} disabled={readOnly}
                  onChange={(inverted) => apply({ inverted })} />
                <span>Inverted</span>
              </label>
            </Prop>
            {'inverted' in el && el.inverted && (
              <Prop label="Inverted padding (dots)" note="Black box around the reserved width.">
                <span className="lbp-unit">Sides</span>
                <NumberBox ariaLabel="Side padding (dots)" integer min={0} max={200} disabled={readOnly}
                  {...numberOf(invertedText, (e) => (isTypeset(e) ? toDots(invertPadOf(e).x, dpi) : null),
                    (e, v) => (isTypeset(e) ? { invertPad: { ...invertPadOf(e), x: (v ?? 0) / dpi } } : null))} />
                <span className="lbp-unit">Top</span>
                <NumberBox ariaLabel="Top padding (dots)" integer min={0} max={200} disabled={readOnly}
                  {...numberOf(invertedText, (e) => (isTypeset(e) ? toDots(invertPadOf(e).y, dpi) : null),
                    (e, v) => (isTypeset(e) ? { invertPad: { ...invertPadOf(e), y: (v ?? 0) / dpi } } : null))} />
              </Prop>
            )}
            <Prop label={field ? 'Expected length · Align' : 'Align'}
              note={field?.expectedLength ? 'The box reserves this many of the widest characters.' : undefined}>
              {field && (
                <>
                  <NumberBox ariaLabel="Expected length" allowEmpty integer min={1} max={MAX_COUNT} disabled={readOnly}
                    {...numberOf(isFieldEl, (e) => (e.type === 'field' ? e.expectedLength ?? null : null),
                      (_, v) => ({ expectedLength: v }))} />
                  <span className="lbp-unit">chars</span>
                </>
              )}
              <Segmented label="Align" options={ALIGNS} value={'align' in el ? el.align ?? 'left' : 'left'} disabled={readOnly}
                mixed={mixed((e) => ('align' in e ? e.align ?? 'left' : null), isTypeset)}
                onChange={(align) => apply({ align })} />
            </Prop>
          </>
        )}

        {field && (
          <>
            <Prop label="Max characters">
              <NumberBox ariaLabel="Max characters" allowEmpty integer min={1} max={MAX_COUNT} disabled={readOnly}
                placeholder="Off"
                {...numberOf(isFieldEl, (e) => (e.type === 'field' ? e.maxChars ?? null : null),
                  (e, v) => (e.type !== 'field' ? null
                    : v === null ? { maxChars: null, trim: null } : { maxChars: v, trim: e.trim ?? 'rear' }))} />
              {field.maxChars ? (
                <Segmented label="Trim" options={TRIMS} value={field.trim ?? 'rear'} disabled={readOnly}
                  mixed={mixed((e) => (e.type === 'field' ? e.trim ?? 'rear' : null), (e) => e.type === 'field')}
                  onChange={(trim) => apply({ trim })} />
              ) : null}
            </Prop>
            <Prop label="Strip" note={field.strip ? `Removes “${field.strip}” before anything else.` : undefined}>
              <TextBox ariaLabel="Strip" value={field.strip ?? ''} placeholder="Off" disabled={readOnly}
                className="lbp-text lbp-strip-text"
                onCommit={(v) => apply((e) => (e.type !== 'field' ? null
                  : v ? { strip: v, stripWhere: e.stripWhere ?? 'front' } : { strip: null, stripWhere: null }))} />
              {field.strip ? (
                <Segmented label="Strip from" options={STRIP_WHERES} value={field.stripWhere ?? 'front'} disabled={readOnly}
                  onChange={(stripWhere) => apply({ stripWhere })} />
              ) : null}
            </Prop>
          </>
        )}

        {(el.type === 'barcode' || el.type === 'qr') && (
          <Prop label="Data">
            <Segmented label="Source" options={SOURCES} value={sourceOf(el)} disabled={readOnly}
              onChange={(source) => apply((e) => {
                if (e.type !== 'barcode' && e.type !== 'qr') return null;
                if (source === 'field') return { field: allFields[0]?.value ?? 'asset_id', data: undefined };
                return { data: (e.field && sampleOf(samples, e.field)) || STATIC_DATA, field: undefined };
              })} />
            {el.field
              ? <ComboBox portal ariaLabel="Bound field" options={allFields} value={el.field} disabled={readOnly}
                  onChange={(v) => { if (v) apply({ field: v }); }} />
              : <TextBox ariaLabel="Data" value={el.data ?? ''} disabled={readOnly}
                  onCommit={(data) => { if (data) apply({ data }); }} />}
          </Prop>
        )}

        {image && look && !imagesAllowed && (
          <Prop label="Image" warning="Images print on ID Badge templates in ZPL only. Remove this one.">
            <span className="lbp-static">{imageName(image)}</span>
          </Prop>
        )}
        {image && look && imagesAllowed && (
          <>
            <Prop label="Source"
              note={noPerson ? 'No sample person: the canvas shows where the picture goes until one is loaded.' : undefined}
              warning={rasterProblem ?? undefined}>
              <Segmented label="Source" options={IMAGE_SOURCES} value={image.source} disabled={readOnly}
                mixed={mixed((e) => (isImage(e) ? e.source : null), isImage)}
                onChange={(source) => apply((e) => imageSourcePatch(e, source))} />
            </Prop>
            {image.source === 'static' && (
              <Prop label="Static image">
                <ImageLibraryPicker value={image.imageId ?? null} disabled={readOnly} onDialog={onDialog}
                  target={ids} onPick={pickImage} />
              </Prop>
            )}
            <Prop label="Fit · Look">
              <Segmented label="Fit" options={FITS} value={imageFit(image)} disabled={readOnly}
                mixed={mixed((e) => (isImage(e) ? imageFit(e) : null), isImage)}
                onChange={(fit) => apply({ fit })} />
              <Segmented label="Look" options={LOOKS} value={look.mode} disabled={readOnly}
                mixed={mixed((e) => (isImage(e) ? imageParams(e).mode : null), isImage)}
                onChange={(mode) => apply({ mode })} />
            </Prop>
            <Prop label="Brightness · Contrast">
              <NumberBox ariaLabel="Brightness" className="lbp-num is-small" integer signed min={-100} max={100}
                disabled={readOnly}
                {...numberOf(isImage, (e) => (isImage(e) ? imageParams(e).brightness : null),
                  (_, v) => ({ brightness: v ?? 0 }))} />
              <NumberBox ariaLabel="Contrast (%)" className="lbp-num is-small" integer min={0} max={300}
                disabled={readOnly}
                {...numberOf(isImage, (e) => (isImage(e) ? imageParams(e).contrast : null),
                  (_, v) => ({ contrast: v ?? 100 }))} />
              <span className="lbp-unit">%</span>
            </Prop>
            <Prop label={look.mode === 'threshold' ? 'Threshold · Invert' : 'Invert'}
              note={look.mode === 'threshold' ? 'Darker than the threshold prints black (1–254).' : undefined}>
              {look.mode === 'threshold' && (
                <NumberBox ariaLabel="Threshold" className="lbp-num is-small" integer min={1} max={254}
                  disabled={readOnly}
                  {...numberOf((e) => isImage(e) && imageParams(e).mode === 'threshold',
                    (e) => (isImage(e) ? imageParams(e).threshold : null), (_, v) => ({ threshold: v ?? 128 }))} />
              )}
              <label className="lbp-switch">
                <Switch label="Invert" checked={look.invert} disabled={readOnly} onChange={(invert) => apply({ invert })} />
                <span>Invert</span>
              </label>
            </Prop>
          </>
        )}

        {barcodeOptions && (
          <Prop label="Barcode">
            <Segmented label="Symbology" options={SYMBOLOGIES} value={symbology} disabled={readOnly}
              onChange={(v) => apply({ symbology: v })} />
            <span className="lbp-unit">Module</span>
            <NumberBox ariaLabel="Module width (dots)" integer min={1} max={10} disabled={readOnly}
              {...numberOf(isBarcode, (e) => barcodeModuleDots('moduleIn' in e ? e.moduleIn : null, dpi),
                (_, v) => ({ moduleIn: (v ?? 2) / dpi }))} />
            <label className="lbp-switch">
              <Switch label="Human-readable line" checked={'showText' in el ? el.showText ?? true : true} disabled={readOnly}
                onChange={(showText) => apply({ showText })} />
              <span>Text line</span>
            </label>
          </Prop>
        )}

        {(el.type === 'line' || el.type === 'box') && (
          <Prop label={el.type === 'box' ? 'Stroke · Fill' : 'Stroke'}>
            <NumberBox ariaLabel="Stroke (dots)" integer min={1} max={200} disabled={readOnly}
              {...numberOf((e) => e.type === 'line' || e.type === 'box',
                (e) => (e.type === 'line' || e.type === 'box' ? toDots(e.strokeIn, dpi) : null),
                (_, v) => ({ strokeIn: Math.max(1, v ?? 1) / dpi }))} />
            <span className="lbp-unit">dots</span>
            {el.type === 'box' && (
              <label className="lbp-switch">
                <Switch label="Fill" checked={!!el.fill} disabled={readOnly} onChange={(fill) => apply({ fill })} />
                <span>Fill</span>
              </label>
            )}
          </Prop>
        )}

        <Prop label="Position & size (dots)"
          note={barcodeOptions ? barcodeHint(el, elementValue(el, samples), dpi) : undefined}
          warning={qrWarning(el, elementValue(el, samples), dpi)}>
          <span className="lbp-unit">X</span>
          <NumberBox ariaLabel="X" className="lbp-num is-small" integer min={0} disabled={readOnly || !!el.locked}
            {...numberOf(() => true, (e) => toDots(footprint(e).x, dpi), (e, v) => (e.locked ? null : { x: (v ?? 0) / dpi }))} />
          <span className="lbp-unit">Y</span>
          <NumberBox ariaLabel="Y" className="lbp-num is-small" integer min={0} disabled={readOnly || !!el.locked}
            {...numberOf(() => true, (e) => toDots(footprint(e).y, dpi), (e, v) => (e.locked ? null : { y: (v ?? 0) / dpi }))} />
          <span className="lbp-unit">W</span>
          <NumberBox ariaLabel="W" className="lbp-num is-small" integer min={1}
            disabled={readOnly || !!el.locked || lengthBox === 'w'} {...sizeOf('w')} />
          <span className="lbp-unit">H</span>
          <NumberBox ariaLabel="H" className="lbp-num is-small" integer min={1}
            disabled={readOnly || !!el.locked || lengthBox === 'h'} {...sizeOf('h')} />
        </Prop>
        <Prop label={hides ? 'Rotation · Hide when empty · Lock' : 'Rotation · Lock'}
          note={image && image.hideWhenEmpty === false ? 'With no picture, an outlined box prints.' : undefined}>
          <Segmented label="Rotation" options={ROTATIONS} value={el.rotation} disabled={readOnly}
            mixed={mixed((e) => e.rotation)} onChange={(rotation) => apply({ rotation })} />
          {hides && (
            <label className="lbp-switch">
              <Switch label="Hide when empty"
                checked={image ? image.hideWhenEmpty !== false : 'hideWhenEmpty' in el && !!el.hideWhenEmpty}
                disabled={readOnly} onChange={(hideWhenEmpty) => apply({ hideWhenEmpty })} />
              <span>Hide when empty</span>
            </label>
          )}
          <label className="lbp-switch">
            <Switch label="Locked" checked={!!el.locked} disabled={readOnly} onChange={(locked) => apply({ locked })} />
            <span>Locked</span>
          </label>
        </Prop>
      </div>
    </aside>
  );
}
