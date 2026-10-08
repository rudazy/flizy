/**
 * Shrink a picked picture to the square the project picture is stored at.
 *
 * Runs in the browser. The file is centre-cropped to a square and drawn at
 * 256x256, then encoded as WebP (JPEG where a browser cannot encode WebP), so
 * what reaches the server is a small data URL inside the projects_image_format
 * limit whatever size the original was.
 */

const PROJECT_IMAGE_SIZE = 256;
/** Mirrors PROJECT_IMAGE_MAX_CHARS in lib/tasks.ts and the database check. */
const MAX_CHARS = 200000;
/** The largest original accepted, before shrinking. */
const PROJECT_IMAGE_SOURCE_MAX_BYTES = 8 * 1024 * 1024;

export async function shrinkProjectImage(file: File): Promise<string> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('Use a PNG, JPG, or WebP image.');
  if (file.size > PROJECT_IMAGE_SOURCE_MAX_BYTES) throw new Error('The image must be 8 MB or less.');

  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = PROJECT_IMAGE_SIZE;
    canvas.height = PROJECT_IMAGE_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not read that image.');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      PROJECT_IMAGE_SIZE,
      PROJECT_IMAGE_SIZE
    );

    for (const quality of [0.86, 0.72, 0.58]) {
      let url = canvas.toDataURL('image/webp', quality);
      // A browser that cannot encode WebP silently returns PNG instead.
      if (!url.startsWith('data:image/webp')) url = canvas.toDataURL('image/jpeg', quality);
      if (url.length <= MAX_CHARS) return url;
    }
    throw new Error('That picture is too detailed. Try another.');
  } finally {
    bitmap.close();
  }
}
