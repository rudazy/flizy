import { PUBLIC_MAIL, type PublicMailId } from '../lib/publicMail';

/**
 * Public mailboxes from the one list. `detailed` adds the one-line job of
 * each address, for the Terms and the Privacy policy. `ids` limits the list
 * when a surface only needs some of them. The short form is label and address.
 */
export function PublicMailList({
  detailed = false,
  className = '',
  ids,
}: {
  detailed?: boolean;
  className?: string;
  ids?: readonly PublicMailId[];
}) {
  const boxes = ids ? PUBLIC_MAIL.filter((box) => ids.includes(box.id)) : PUBLIC_MAIL;
  return (
    <ul className={className}>
      {boxes.map((box) => (
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
