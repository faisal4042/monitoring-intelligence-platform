/** Studio form controls. Every value they produce is validated by the template schema before it is saved. */
import { useEffect, useId, useState, type ReactNode } from 'react';

interface Base { label: string; error?: string; disabled?: boolean; hint?: ReactNode }

function Field({ label, error, hint, children, htmlFor }: Base & { children: ReactNode; htmlFor?: string }) {
  return (
    <div className="studio-field" data-invalid={error ? 'true' : undefined}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {hint && !error && <small className="muted">{hint}</small>}
      {error && <small className="studio-error" role="alert">{error}</small>}
    </div>
  );
}

/** Colour picker plus a HEX box; the box accepts any typing and only commits a valid #RRGGBB. */
export function ColorField({ label, value, onChange, error, disabled }: Base & { value: string; onChange: (v: string) => void }) {
  const id = useId();
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const valid = /^#[0-9a-fA-F]{6}$/.test(text);
  return (
    <Field label={label} error={error ?? (!valid ? 'لون HEX بصيغة ‎#RRGGBB' : undefined)} htmlFor={id}>
      <div className="studio-color">
        <input type="color" value={value} disabled={disabled} aria-label={`${label} — منتقي اللون`} onChange={(e) => onChange(e.target.value)} />
        <input id={id} className="input num" dir="ltr" value={text} disabled={disabled} maxLength={7} spellCheck={false}
          onChange={(e) => { setText(e.target.value); if (/^#[0-9a-fA-F]{6}$/.test(e.target.value)) onChange(e.target.value.toLowerCase()); }} />
      </div>
    </Field>
  );
}

export function RangeField({ label, value, min, max, step = 1, unit = '', onChange, error, disabled, hint }: Base & {
  value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void;
}) {
  const id = useId();
  const clamp = (v: number) => Math.min(max, Math.max(min, Math.round(v / step) * step));
  return (
    <Field label={label} error={error} htmlFor={id} hint={hint}>
      <div className="studio-range">
        <input type="range" min={min} max={max} step={step} value={value} disabled={disabled} aria-label={label}
          onChange={(e) => onChange(clamp(Number(e.target.value)))} />
        <input id={id} className="input num" type="number" dir="ltr" min={min} max={max} step={step} value={value} disabled={disabled}
          onChange={(e) => { const v = Number(e.target.value); if (Number.isFinite(v)) onChange(clamp(v)); }} />
        {unit && <span className="muted text-xs">{unit}</span>}
      </div>
    </Field>
  );
}

export function SelectField<T extends string | number>({ label, value, options, onChange, error, disabled, hint }: Base & {
  value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void;
}) {
  const id = useId();
  return (
    <Field label={label} error={error} htmlFor={id} hint={hint}>
      <select id={id} className="input" value={String(value)} disabled={disabled}
        onChange={(e) => onChange(options.find((o) => String(o.value) === e.target.value)!.value)}>
        {options.map((o) => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
      </select>
    </Field>
  );
}

export function ToggleField({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="studio-toggle">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

export function TextField({ label, value, onChange, maxLength, error, disabled, hint, dir }: Base & {
  value: string; onChange: (v: string) => void; maxLength: number; dir?: 'rtl' | 'ltr' | 'auto';
}) {
  const id = useId();
  return (
    <Field label={label} error={error} htmlFor={id} hint={hint ?? <span className="num">{value.length}/{maxLength}</span>}>
      <input id={id} className="input" value={value} maxLength={maxLength} disabled={disabled} dir={dir ?? 'auto'} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}
