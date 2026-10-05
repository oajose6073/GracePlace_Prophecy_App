"use client";

import { useFormStatus } from "react-dom";

/**
 * A submit button that asks before it does something irreversible.
 *
 * Deleting a word or a segment takes its audio with it, and the spec is
 * explicit that deletion is the only undo — so there is nothing to fall back
 * on if it was a misclick.
 *
 * It stays a plain submit button, so the server action still runs through
 * normal form submission. Declining just cancels that submit.
 */
export function ConfirmButton({
  message,
  children,
  className,
  formAction,
  formNoValidate,
}: {
  message: string;
  children: React.ReactNode;
  className?: string;
  /** Omit to use the enclosing form's own action. */
  formAction?: (formData: FormData) => void | Promise<void>;
  formNoValidate?: boolean;
}) {
  const { pending } = useFormStatus();

  return (
    <button
      type="submit"
      formAction={formAction}
      formNoValidate={formNoValidate}
      disabled={pending}
      onClick={(event) => {
        if (!window.confirm(message)) event.preventDefault();
      }}
      className={className}
    >
      {children}
    </button>
  );
}
