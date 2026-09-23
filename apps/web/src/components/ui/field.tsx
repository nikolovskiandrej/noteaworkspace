import type { ReactNode } from 'react';
import { cx } from './cx';

/** A form field: a visible label above the control, and an optional hint below it. */
export function Field({
  label,
  htmlFor,
  hint,
  className,
  children,
}: {
  label: ReactNode;
  htmlFor: string;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cx('min-w-0', className)}>
      <label htmlFor={htmlFor} className="field-label">
        {label}
      </label>
      {children}
      {hint ? <p className="field-hint">{hint}</p> : null}
    </div>
  );
}
