import { RoughBox } from './RoughBox';

interface Option<T extends string | number> {
  value: T;
  label: string;
}

interface BlankSelectProps<T extends string | number> {
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
  /** Treat option values as numbers when calling onChange. */
  numeric?: boolean;
  seed?: number;
}

/** An inline <select> sitting in prose, wrapped in a hand-drawn rough.js box. */
export function BlankSelect<T extends string | number>({
  value,
  options,
  onChange,
  numeric,
  seed = 2,
}: BlankSelectProps<T>) {
  return (
    <RoughBox className="blank" seed={seed}>
      <select
        className="blank-select"
        value={String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          onChange((numeric ? Number(raw) : raw) as T);
        }}
      >
        {options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </RoughBox>
  );
}
