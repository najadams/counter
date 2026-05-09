// Photo storage on disk. Photos for breakage (and later void evidence,
// stocktake disputes, etc) live under userData/photos/<kind>/.
//
// We DO NOT store images in the DB. The DB stores the relative path
// (e.g. "photos/breakage/abc-123.jpg") and the renderer is given a
// file:// URL to render. Backups should include this directory.

import fs from 'node:fs';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';

export type PhotoKind = 'breakage' | 'void' | 'stocktake' | 'misc';

export interface SavePhotoInput {
  /** raw bytes (e.g. JPEG, PNG) */
  bytes: Buffer | Uint8Array;
  /** lowercase extension WITHOUT a dot, e.g. 'jpg' or 'png' */
  extension: string;
  kind: PhotoKind;
  /** root dir, typically app.getPath('userData') */
  userDataDir: string;
}

export interface SavedPhoto {
  /** relative path stored in DB columns, e.g. 'photos/breakage/<uuid>.jpg' */
  relativePath: string;
  /** absolute filesystem path */
  absolutePath: string;
  /** size in bytes (after write) */
  bytes: number;
}

const ALLOWED_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp']);
const MAX_BYTES = 5 * 1024 * 1024; // 5 MB cap; phone shots are usually 1–3 MB

export function savePhoto(input: SavePhotoInput): SavedPhoto {
  const ext = input.extension.toLowerCase().replace(/^\./, '');
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`savePhoto: unsupported extension '${ext}' (allowed: ${[...ALLOWED_EXTENSIONS].join(', ')})`);
  }
  const buf = input.bytes instanceof Buffer ? input.bytes : Buffer.from(input.bytes);
  if (buf.byteLength === 0) throw new Error('savePhoto: empty buffer');
  if (buf.byteLength > MAX_BYTES) {
    throw new Error(`savePhoto: photo too large (${buf.byteLength} bytes, max ${MAX_BYTES})`);
  }

  const dir = path.join(input.userDataDir, 'photos', input.kind);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const filename = `${uuidv4()}.${ext}`;
  const absolutePath = path.join(dir, filename);
  fs.writeFileSync(absolutePath, buf);

  return {
    relativePath: path.posix.join('photos', input.kind, filename),
    absolutePath,
    bytes: buf.byteLength,
  };
}

/** Convert a stored relativePath into a file:// URL the renderer can show. */
export function photoUrlForDisplay(userDataDir: string, relativePath: string): string {
  const abs = path.join(userDataDir, relativePath);
  // file:// URLs need forward-slash paths, percent-encoded.
  const encoded = abs.split(path.sep).map(encodeURIComponent).join('/');
  return `file://${encoded.startsWith('/') ? '' : '/'}${encoded}`;
}

/** Read a photo and return base64-encoded data + mime type for the renderer.
 *  Used by the photo review screen — renderers can't read disk directly. */
export function readPhotoAsDataUri(userDataDir: string, relativePath: string): {
  dataUri: string; bytes: number;
} | null {
  // Refuse anything that escapes the photos dir.
  const photosRoot = path.resolve(userDataDir, 'photos');
  const abs = path.resolve(userDataDir, relativePath);
  if (!abs.startsWith(photosRoot + path.sep) && abs !== photosRoot) {
    throw new Error(`readPhotoAsDataUri: path '${relativePath}' escapes photos directory`);
  }
  if (!fs.existsSync(abs)) return null;
  const buf = fs.readFileSync(abs);
  const ext = path.extname(abs).slice(1).toLowerCase();
  const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
    : ext === 'png' ? 'image/png'
    : ext === 'webp' ? 'image/webp'
    : 'application/octet-stream';
  return {
    dataUri: `data:${mime};base64,${buf.toString('base64')}`,
    bytes: buf.byteLength,
  };
}
