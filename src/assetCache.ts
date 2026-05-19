/**
 * Persistent cache for grok.com CDN assets.
 *
 * The first browser to load grok.com fetches each CDN asset through the proxy;
 * the body is saved to disk and memory, and every later request for the same
 * URL is served locally — costing no proxy bandwidth. CDN asset URLs are
 * content-hashed (immutable), so entries do not expire; a new Grok deploy
 * simply produces new URLs and new entries.
 */
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import config from './config';
import { logger } from './logger';

export interface CachedAsset {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

const memory = new Map<string, CachedAsset>();
let dirReady = false;

function keyFor(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

async function ensureDir(): Promise<void> {
  if (dirReady) return;
  await fs.mkdir(config.cdnCacheDir, { recursive: true });
  dirReady = true;
}

/** Return a cached asset (memory first, then disk), or null on a miss. */
export async function getAsset(url: string): Promise<CachedAsset | null> {
  const key = keyFor(url);
  const cached = memory.get(key);
  if (cached) return cached;
  try {
    const meta = JSON.parse(
      await fs.readFile(path.join(config.cdnCacheDir, `${key}.json`), 'utf8'),
    ) as { status: number; headers: Record<string, string> };
    const body = await fs.readFile(path.join(config.cdnCacheDir, `${key}.body`));
    const asset: CachedAsset = { status: meta.status, headers: meta.headers, body };
    memory.set(key, asset);
    return asset;
  } catch {
    return null;
  }
}

/** Persist an asset to memory and disk (atomic write via temp file + rename). */
export async function putAsset(url: string, asset: CachedAsset): Promise<void> {
  const key = keyFor(url);
  memory.set(key, asset);
  try {
    await ensureDir();
    const bodyPath = path.join(config.cdnCacheDir, `${key}.body`);
    const metaPath = path.join(config.cdnCacheDir, `${key}.json`);
    const tag = randomUUID();
    await fs.writeFile(`${bodyPath}.${tag}`, asset.body);
    await fs.writeFile(
      `${metaPath}.${tag}`,
      JSON.stringify({ url, status: asset.status, headers: asset.headers }),
    );
    await fs.rename(`${bodyPath}.${tag}`, bodyPath);
    await fs.rename(`${metaPath}.${tag}`, metaPath);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), url },
      'cdn cache write failed',
    );
  }
}
