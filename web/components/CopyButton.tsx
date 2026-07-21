'use client';

import { useState } from 'react';

export function CopyButton({
  value,
  label = 'Copy',
  className = '',
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [done, setDone] = useState(false);

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(value);
      setDone(true);
      setTimeout(() => setDone(false), 1600);
    } catch {
      setDone(false);
    }
  }

  return (
    <button type="button" className={`btn btn-ghost text-sm ${className}`} onClick={onCopy}>
      {done ? 'Copied' : label}
    </button>
  );
}
