/**
 * Downsize a screenshot in the browser before it is sent: longest side ≤ MAX_SIDE px, JPEG. Keeps a
 * phone/desktop screenshot to a few hundred KB (server limit: lib/operator-chat/images.ts).
 */

const MAX_SIDE = 1600;
const QUALITY = 0.85;
export const MAX_IMAGES = 4;

export async function fileToDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error(`${file.name || 'file'} is not an image`);
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas unavailable');
    ctx.fillStyle = '#fff'; // transparent PNG areas → white, not black, in JPEG
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', QUALITY);
  } finally {
    bitmap.close();
  }
}
