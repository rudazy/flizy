'use client';

import { useEffect, useState } from 'react';

const SRC = '/hero/brag-loop.mp4';
const POSTER = '/hero/brag-poster.jpg';

/**
 * The launch video, shown beside the landing headline. The file has no audio
 * track, so it autoplays muted and loops.
 *
 * Visitors who prefer reduced motion get the poster with player controls
 * instead of autoplay, and the clip is only fetched if they press play.
 */
export function HeroVideo() {
  // null until the motion preference is read, so the server render and the
  // first paint show the bare poster, without controls flashing in and out.
  const [animate, setAnimate] = useState<boolean | null>(null);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const sync = () => setAnimate(!query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  return (
    <div className="card overflow-hidden">
      <video
        key={animate ? 'autoplay' : 'still'}
        className="block aspect-video w-full bg-ink object-cover"
        src={SRC}
        poster={POSTER}
        aria-label="Flizy launch video: sending crypto from a chat message"
        muted
        playsInline
        loop={animate === true}
        autoPlay={animate === true}
        controls={animate === false}
        preload={animate ? 'auto' : 'none'}
      />
    </div>
  );
}
