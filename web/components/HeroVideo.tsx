'use client';

import { useEffect, useState } from 'react';

const SRC = '/hero/flizy-demo.mp4';
const POSTER = '/hero/flizy-demo-poster.jpg';

/**
 * The launch video, shown beside the landing headline. The file has no audio
 * track, so it autoplays muted and loops.
 *
 * Visitors who prefer reduced motion get the poster with player controls
 * instead of autoplay, and the clip is only fetched if they press play.
 *
 * It plays as part of the page, not as media to take away. The long-press and
 * right-click menu (save, copy link, open in new tab) and the iOS long-press
 * preview are suppressed, and the download, picture-in-picture and cast options
 * are turned off where the browser honours those attributes. This is cosmetic:
 * the file stays public at its URL like any other asset.
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
        className="block aspect-video w-full select-none bg-ink object-cover [-webkit-touch-callout:none]"
        src={SRC}
        poster={POSTER}
        aria-label="Flizy launch video: sending crypto from a chat message"
        muted
        playsInline
        loop={animate === true}
        autoPlay={animate === true}
        controls={animate === false}
        preload={animate ? 'auto' : 'none'}
        controlsList="nodownload noremoteplayback"
        disablePictureInPicture
        disableRemotePlayback
        onContextMenu={(event) => event.preventDefault()}
      />
    </div>
  );
}
