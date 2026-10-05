import { PUBLIC_MAIL } from '../lib/publicMail';

/**
 * The four public mailboxes. `detailed` adds the one-line job of each
 * address, for the Terms and the Privacy policy. The footer and the account
 * slide use the short form: label and address.
 */
export function PublicMailList({
  detailed = false,
  className = '',
}: {
  detailed?: boolean;
  className?: string;
}) {
  return (
    <ul className={className}>
      {PUBLIC_MAIL.map((box) => (
        <li key={box.id} className="break-words">
          {detailed ? null : <span className="text-muted">{box.label} </span>}
          <a
            href={`mailto:${box.address}`}
            className="break-all text-paper no-underline hover:text-lime"
          >
            {box.address}
          </a>
          {detailed ? <span className="text-muted">. {box.use}</span> : null}
        </li>
      ))}
    </ul>
  );
}
