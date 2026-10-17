/** A flash color as the kiosk's own Appearance picker edits it
 *  (kiosk/src/components/HslPicker.tsx): a live swatch and hue / saturation
 *  / lightness sliders. The portal's ColorWheel isn't used here because it
 *  works in hex and has no saturation control, and the kiosk stores and
 *  edits all three channels. */

import { hslCss, type Hsl } from '../../../lib/kioskConfig';

const CHANNELS: { key: keyof Hsl; label: string; max: number; suffix: string }[] = [
  { key: 'h', label: 'Hue', max: 360, suffix: '°' },
  { key: 's', label: 'Saturation', max: 100, suffix: '%' },
  { key: 'l', label: 'Lightness', max: 100, suffix: '%' },
];

export default function HslControl({ name, value, onChange, disabled }: {
  name: string; value: Hsl; onChange: (next: Hsl) => void; disabled?: boolean;
}) {
  return (
    <div className="kd-hsl">
      <div className="kd-hsl-swatch" style={{ background: hslCss(value) }} aria-hidden="true" />
      <div className="kd-hsl-channels">
        {CHANNELS.map((c) => (
          <div key={c.key} className="kd-hsl-channel">
            <span>{c.label}</span>
            <input type="range" min={0} max={c.max} step={1} value={value[c.key]} disabled={disabled}
                   aria-label={`${name} ${c.label.toLowerCase()}`}
                   onChange={(e) => onChange({ ...value, [c.key]: Number(e.target.value) })} />
            <span className="mono">{Math.round(value[c.key])}{c.suffix}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
