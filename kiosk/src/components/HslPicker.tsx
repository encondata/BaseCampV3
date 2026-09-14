/** One color on the Appearance tab: a live swatch, three channel
 *  sliders, the `hsl(...)` readout, and a Preview flash button that
 *  fires the real overlay — for the configured flash duration, so the
 *  preview is the real thing — so the color can be judged full-screen
 *  rather than from a 40px square. Controlled — the Appearance tab owns the
 *  value and persists every change immediately. */

import { hslCss, type Hsl } from '../lib/appearance';
import { flash } from '../lib/flash';

interface Channel { key: keyof Hsl; label: string; max: number; suffix: string }

const CHANNELS: Channel[] = [
  { key: 'h', label: 'hue', max: 360, suffix: '°' },
  { key: 's', label: 'saturation', max: 100, suffix: '%' },
  { key: 'l', label: 'lightness', max: 100, suffix: '%' },
];

export default function HslPicker({
  name, value, onChange, flashMs,
}: { name: string; value: Hsl; onChange: (next: Hsl) => void; flashMs?: number }) {
  const css = hslCss(value);
  return (
    <div className="hsl-picker">
      <div className="hsl-swatch" style={{ background: css }} aria-hidden="true" />
      <div className="hsl-channels">
        {CHANNELS.map((c) => (
          <label key={c.key} className="hsl-channel">
            <span className="hsl-channel-name">{c.label[0].toUpperCase() + c.label.slice(1)}</span>
            <input
              type="range"
              min={0}
              max={c.max}
              step={1}
              value={value[c.key]}
              aria-label={`${name} ${c.label}`}
              onChange={(e) => onChange({ ...value, [c.key]: Number(e.target.value) })}
            />
            <span className="hsl-channel-value mono">{Math.round(value[c.key])}{c.suffix}</span>
          </label>
        ))}
      </div>
      <div className="hsl-foot">
        <code className="hsl-readout">{css}</code>
        <button type="button" className="mini-btn" onClick={() => flash(css, flashMs)}>Preview flash</button>
      </div>
    </div>
  );
}
