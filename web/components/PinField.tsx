'use client';

import { useId } from 'react';

/**
 * The PIN that approves a payment. Money actions on the site ask for the PIN,
 * not the account password (web/lib/stepUp.ts); the password stays for account
 * changes. Digits only, masked, and never offered to a password manager.
 */
export function PinField({
  value,
  onChange,
  id,
  label = 'Your PIN',
}: {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  label?: string;
}) {
  const generatedId = useId();
  const inputId = id || generatedId;
  return (
    <div>
      <label className="label" htmlFor={inputId}>
        {label}
      </label>
      <input
        id={inputId}
        className="input font-mono"
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={12}
        placeholder="4 to 12 digits"
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 12))}
      />
    </div>
  );
}

/** A PIN that can be sent: 4 to 12 digits. */
export function pinReady(pin: string): boolean {
  return /^\d{4,12}$/.test(pin);
}
