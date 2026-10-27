'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { profilePath } from '../lib/follows.ts';
import { validateUsername } from '../lib/username.ts';

/**
 * A username or avatar that opens that person's profile.
 * Anything that is not a Flizy username is left as plain text.
 */
export function ProfileLink({
  username,
  className,
  children,
}: {
  username: string;
  className?: string;
  children: ReactNode;
}) {
  const checked = validateUsername(username);
  if (!checked.ok) return <>{children}</>;
  return (
    <Link href={profilePath(checked.username)} className={className}>
      {children}
    </Link>
  );
}
