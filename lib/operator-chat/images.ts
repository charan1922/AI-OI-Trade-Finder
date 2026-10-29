/**
 * Screenshots the operator attaches in the chat (Commentary v2). Kept as files under
 * data/chat-images/ (the persistent data volume on the box) — never inline in operator_chat, so the
 * thread the page polls every few seconds stays small. Only the chat model sees them; the auto-trader
 * reads the operator's TEXT only.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MAX_IMAGES = 4;
/** Decoded bytes per image. The page downsizes to ≤ 1600px JPEG first, so real ones are far smaller. */
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

const DATA_URL = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/;
const NAME = /^(\d+)-(\d)\.(jpg|png|webp)$/;
const EXT: Record<string, string> = { jpeg: 'jpg', png: 'png', webp: 'webp' };
const TYPE: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

const dir = () => join(process.cwd(), 'data', 'chat-images');

/** Validate the request's images. Returns the clean list, or a plain-English refusal. */
export function parseImages(raw: unknown): { ok: true; images: string[] } | { ok: false; error: string } {
  if (raw == null) return { ok: true, images: [] };
  if (!Array.isArray(raw)) return { ok: false, error: 'images must be a list.' };
  if (raw.length > MAX_IMAGES) return { ok: false, error: `At most ${MAX_IMAGES} images per message.` };
  for (const img of raw) {
    const m = typeof img === 'string' ? DATA_URL.exec(img) : null;
    if (!m) return { ok: false, error: 'Images must be PNG, JPEG or WebP.' };
    if (Buffer.byteLength(m[2], 'base64') > MAX_IMAGE_BYTES) {
      return { ok: false, error: `An image is over ${MAX_IMAGE_BYTES / 1024 / 1024} MB.` };
    }
  }
  return { ok: true, images: raw as string[] };
}

/** Write a message's images to disk; returns their file names (`<messageId>-<n>.<ext>`). */
export async function saveImages(messageId: number, images: readonly string[]): Promise<string[]> {
  if (images.length === 0) return [];
  await mkdir(dir(), { recursive: true });
  const names: string[] = [];
  for (const [i, img] of images.entries()) {
    const m = DATA_URL.exec(img);
    if (!m) continue;
    const name = `${messageId}-${i}.${EXT[m[1]]}`;
    await writeFile(join(dir(), name), Buffer.from(m[2], 'base64'));
    names.push(name);
  }
  return names;
}

/** Read one stored image by its file name; null for anything that is not one of ours. */
export async function readImage(name: string): Promise<{ bytes: Buffer; type: string } | null> {
  const m = NAME.exec(name);
  if (!m) return null;
  try {
    return { bytes: await readFile(join(dir(), name)), type: TYPE[m[3]] };
  } catch {
    return null;
  }
}
