/**
 * Shrink a picked image to the size a project stores it at.
 *
 * Runs in the browser. The file is centre-cropped to the target shape (a square
 * for the picture, 1200x630 for the banner), then encoded as WebP (JPEG where a
 * browser cannot encode WebP), so what reaches the server is a data URL inside
 * the projects_image_format and projects_banner_format limits whatever size
 * the original was.
 */

/** Mirror PROJECT_IMAGE_MAX_CHARS and PROJECT_BANNER_MAX_CHARS in lib/tasks.ts and the database checks. */
const PICTURE = { width: 256, height: 256, maxChars: 200000 };
const BANNER = { width: 1200, height: 630, maxChars: 300000 };
/** The largest original accepted, before shrinking. */
const SOURCE_MAX_BYTES = 8 * 1024 * 1024;

export function shrinkProjectImage(file: File): Promise<string> {
  return shrinkTo(file, PICTURE);
}

export function shrinkProjectBanner(file: File): Promise<string> {
  return shrinkTo(file, BANNER);
}

async function shrinkTo(file: File, target: { width: number; height: number; maxChars: number }): Promise<string> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Use a PNG, JPG, or WebP image.');
  if (file.size > SOURCE_MAX_BYTES) throw new Error('The image must be 8 MB or less.');

  const bitmap = await createImageBitmap(file);
  try {
    // The largest centred region of the original with the target's shape.
    const ratio = target.width / target.height;
    const srcW = Math.min(bitmap.width, bitmap.height * ratio);
    const srcH = srcW / ratio;
    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not read that image.');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      bitmap,
      (bitmap.width - srcW) / 2,
      (bitmap.height - srcH) / 2,
      srcW,
      srcH,
      0,
      0,
      target.width,
      target.height
    );

    for (const quality of [0.86, 0.72, 0.58, 0.45]) {
      let url = canvas.toDataURL('image/webp', quality);
      // A browser that cannot encode WebP silently returns PNG instead.
      if (!url.startsWith('data:image/webp')) url = canvas.toDataURL('image/jpeg', quality);
      if (url.length <= target.maxChars) return url;
    }
    throw new Error('That picture is too detailed. Try another.');
  } finally {
    bitmap.close();
  }
}
