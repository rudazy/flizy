'use client';

import { useId, useState, type ReactNode } from 'react';

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
  /** Mark drawn inside the left of the field. */
  leading?: ReactNode;
  /** Extra classes on the input. */
  inputClassName?: string;
  /** Eye icon instead of the Show / Hide words. */
  iconToggle?: boolean;
  /** Label classes for the wide auth cards. */
  labelClassName?: string;
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
  leading,
  inputClassName = '',
  iconToggle = false,
  labelClassName = '',
}: PasswordFieldProps) {
  const generatedId = useId();
  const inputId = id || generatedId;
  const [visible, setVisible] = useState(false);

  return (
    <div>
      <label className={labelClassName || 'label'} htmlFor={inputId}>
        {label}
      </label>
      <div className="relative">
        {leading ? (
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#8f877c]">
            {leading}
          </span>
        ) : null}
        <input
          id={inputId}
          className={`input pr-16 ${leading ? 'pl-11' : ''} ${inputClassName}`.trim()}
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
          {iconToggle ? <EyeMark hidden={!visible} /> : visible ? 'Hide' : 'Show'}
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

function EyeMark({ hidden }: { hidden: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" aria-hidden>
      <path
        d="M3 12s3.2-6 9-6 9 6 9 6-3.2 6-9 6-9-6-9-6Z"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <circle cx="12" cy="12" r="2.4" stroke="currentColor" strokeWidth="1.6" />
      {hidden ? <path d="M5 19 19 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /> : null}
    </svg>
  );
}
