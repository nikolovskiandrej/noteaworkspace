'use client';

import { LoaderCircle } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { useFormStatus } from 'react-dom';
import { cx } from './cx';

/**
 * A form's submit button that shows the server action is running: it disables itself
 * (so a slow action, like creating a workspace, cannot be sent twice) and swaps its
 * leading icon for a spinner. Must be rendered inside the <form> it submits.
 */
export function SubmitButton({
  children,
  icon,
  pendingLabel,
  className,
  disabled,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & {
  /** Leading icon, replaced by the spinner while pending. */
  icon?: ReactNode;
  /** Text shown while pending; defaults to the normal label. */
  pendingLabel?: ReactNode;
}) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      {...rest}
      disabled={disabled || pending}
      data-pending={pending ? '' : undefined}
      aria-busy={pending || undefined}
      className={cx('btn', className)}
    >
      {pending ? <LoaderCircle className="animate-spin" aria-hidden /> : icon}
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}
