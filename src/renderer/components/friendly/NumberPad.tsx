// NumberPad — on-screen digits for the Friendly build (PIN, cash counts,
// money received). It edits a string the parent owns, so the same value can
// also be typed on a physical keyboard into the paired input.
//
// Keys never take focus (mousedown is prevented), so a cashier can tap a few
// digits and carry on typing without clicking back into the field.

export function applyNumberPadKey(
  current: string,
  key: string,
  opts: { allowDecimal?: boolean; maxLength?: number; maxDecimals?: number } = {},
): string {
  const { allowDecimal = false, maxLength, maxDecimals = 2 } = opts;
  if (key === 'back') return current.slice(0, -1);
  if (key === 'clear') return '';
  if (key === '.') {
    if (!allowDecimal || current.includes('.')) return current;
    return current === '' ? '0.' : `${current}.`;
  }
  if (!/^\d$/.test(key)) return current;
  if (maxLength !== undefined && current.length >= maxLength) return current;
  const dot = current.indexOf('.');
  if (dot >= 0 && current.length - dot - 1 >= maxDecimals) return current;
  // Money fields: no leading zeros ("05" -> "5"). PINs may start with 0.
  if (allowDecimal && current === '0') return key;
  return current + key;
}

export function NumberPad({
  value, onChange, allowDecimal = false, maxLength, disabled = false, onEnter, enterLabel, enterDisabled = false, label,
}: {
  value: string;
  onChange: (next: string) => void;
  allowDecimal?: boolean;
  maxLength?: number;
  disabled?: boolean;
  /** When set, a wide confirm key is shown beneath the pad. */
  onEnter?: () => void;
  enterLabel?: string;
  enterDisabled?: boolean;
  /** Accessible name for the group, e.g. "PIN number pad". */
  label: string;
}) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', allowDecimal ? '.' : 'clear', '0', 'back'];
  const press = (k: string) => { if (!disabled) onChange(applyNumberPadKey(value, k, { allowDecimal, maxLength })); };

  return (
    <div role="group" aria-label={label} className="flex flex-col gap-2">
      <div className="grid grid-cols-3 gap-2">
        {keys.map((k) => (
          <button
            key={k}
            type="button"
            disabled={disabled}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => press(k)}
            aria-label={k === 'back' ? 'Delete last digit' : k === 'clear' ? 'Clear' : k === '.' ? 'Decimal point' : k}
            className="min-h-16 rounded-xl border-2 border-border bg-bg-elevated text-text-primary text-3xl font-semibold tnum hover:border-border-strong active:bg-bg-surface disabled:opacity-40"
          >
            {k === 'back' ? '⌫' : k === 'clear' ? <span className="text-lg">Clear</span> : k}
          </button>
        ))}
      </div>
      {onEnter && (
        <button
          type="button"
          disabled={disabled || enterDisabled}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onEnter}
          className="min-h-16 rounded-xl bg-accent text-ink text-xl font-semibold hover:bg-accent-light disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {enterLabel ?? 'OK'}
        </button>
      )}
    </div>
  );
}
