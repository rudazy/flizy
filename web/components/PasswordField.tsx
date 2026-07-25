'use client';

import { useId, useState } from 'react';

type PasswordFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  id?: string;
  placeholder?: string;
  autoComplete?: string;
  minLength?: number;
  required?: boolean;
  /** Helper copy under the field */
  hint?: string;
  /** Inline problem with this field, for example a mismatch */
  problem?: string;
};

/**
 * Password input with a show/hide toggle.
 *
 * The toggle is type="button" so it never submits the form, and it reports state
 * through aria-pressed for screen readers. Visibility resets on every mount, so a
 * password is never revealed by default.
 */
export function PasswordField({
  label,
  value,
  onChange,
  id,
  placeholder,
  autoComplete = 'new-password',
  minLength,
  required,
  hint,
  problem,
}: PasswordFieldProps) {
  const generatedId = useId();
  const inputId = id || generatedId;
  const [visible, setVisible] = useState(false);

  return (
    <div>
      <label className="label" htmlFor={inputId}>
        {label}
      </label>
      <div className="relative">
        <input
          id={inputId}
          className="input pr-16"
          type={visible ? 'text' : 'password'}
          required={required}
          minLength={minLength}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${inputId}-problem` : undefined}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute inset-y-0 right-0 flex items-center rounded-r px-3 text-[0.7rem] uppercase tracking-[0.08em] text-muted transition-colors hover:text-lime focus:text-lime focus:outline-none"
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
        >
          {visible ? 'Hide' : 'Show'}
        </button>
      </div>
      {problem ? (
        <p id={`${inputId}-problem`} className="mt-2 text-xs leading-relaxed text-gold">
          {problem}
        </p>
      ) : hint ? (
        <p className="mt-2 text-xs leading-relaxed text-muted">{hint}</p>
      ) : null}
    </div>
  );
}
