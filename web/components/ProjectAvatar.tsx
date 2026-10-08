/**
 * A project's mark: its picture when it has one, otherwise two letters from
 * its name. One component so every surface shows the same thing.
 */

export function projectLetters(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => /[a-z0-9]/i.test(word));
  if (!words.length) return 'FZ';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

export function ProjectAvatar({
  name,
  image,
  size = 42,
  className = '',
}: {
  name: string;
  image?: string | null;
  size?: number;
  className?: string;
}) {
  const box = { width: size, height: size };
  // Only a data URL from the stored picture is drawn; anything else falls back
  // to the letters rather than loading an arbitrary address.
  if (image && image.startsWith('data:image/')) {
    return (
      <img
        src={image}
        alt={`${name} picture`}
        style={box}
        className={`shrink-0 rounded-[8px] border border-[#262626] object-cover ${className}`}
      />
    );
  }
  return (
    <span
      style={{ ...box, fontSize: Math.round(size * 0.31) }}
      className={`flex shrink-0 items-center justify-center rounded-[8px] border border-[#262626] bg-[#131313] font-sans font-semibold tracking-wide text-sun ${className}`}
      aria-hidden
    >
      {projectLetters(name)}
    </span>
  );
}
