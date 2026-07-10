import { RoughBox } from './RoughBox';

interface BlankInputProps {
  value: number | null;
  onChange: (value: number | null) => void;
  placeholder?: string;
  min?: number;
  max?: number;
  step?: number;
  width?: number; // characters
  prefix?: string;
  seed?: number;
}

/** An inline numeric input sitting in prose, wrapped in a hand-drawn rough.js box. */
export function BlankInput({
  value,
  onChange,
  placeholder,
  min = 0,
  max,
  step = 1,
  width = 5,
  prefix,
  seed = 3,
}: BlankInputProps) {
  return (
    <RoughBox className="blank" seed={seed}>
      <span className="blank-input-wrap">
        {prefix && <span className="blank-prefix">{prefix}</span>}
        <input
          className="blank-input"
          type="number"
          inputMode="decimal"
          value={value ?? ''}
          placeholder={placeholder}
          min={min}
          max={max}
          step={step}
          style={{ width: `${width}ch` }}
          onChange={(e) => {
            const raw = e.target.value;
            onChange(raw === '' ? null : Number(raw));
          }}
        />
      </span>
    </RoughBox>
  );
}
