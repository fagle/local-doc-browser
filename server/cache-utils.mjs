import { readdir, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";

export function parseByteSize(value, fallback) {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  const match = raw.match(/^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb|tb)?$/i);
  if (!match) return fallback;
  const number = Number(match[1]);
  if (!Number.isFinite(number) || number < 0) return fallback;
  const unit = (match[2] || "b").toLowerCase();
  const multipliers = {
    b: 1,
    kb: 1024,
    mb: 1024 ** 2,
    gb: 1024 ** 3,
    tb: 1024 ** 4,
  };
  return Math.floor(number * (multipliers[unit] || 1));
}

export async function touchCacheFile(filePath) {
  const now = new Date();
  await utimes(filePath, now, now).catch(() => {});
}

export function createCacheCleanupScheduler() {
  const timers = new Map();

  function scheduleCacheCleanup(name, root, maxBytes) {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0 || timers.has(name)) return;
    const timer = setTimeout(() => {
      timers.delete(name);
      enforceCacheLimit(root, maxBytes).catch((error) => {
        console.warn(`[cache] ${name} cleanup failed: ${error.message}`);
      });
    }, 5000);
    timer.unref?.();
    timers.set(name, timer);
  }

  return { scheduleCacheCleanup };
}

export async function enforceCacheLimit(root, maxBytes) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const files = [];
  let totalBytes = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(jpe?g|webp)$/i.test(entry.name)) continue;
    const filePath = join(root, entry.name);
    const fileStat = await stat(filePath).catch(() => null);
    if (!fileStat?.isFile()) continue;
    totalBytes += fileStat.size;
    files.push({ path: filePath, size: fileStat.size, mtimeMs: fileStat.mtimeMs });
  }

  if (totalBytes <= maxBytes) return;
  files.sort((left, right) => left.mtimeMs - right.mtimeMs);
  const targetBytes = Math.floor(maxBytes * 0.9);
  for (const file of files) {
    if (totalBytes <= targetBytes) break;
    await rm(file.path, { force: true }).catch(() => {});
    totalBytes -= file.size;
  }
}

export async function cacheDirectoryUsage(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !/\.(jpe?g|webp)$/i.test(entry.name)) continue;
    const fileStat = await stat(join(root, entry.name)).catch(() => null);
    if (!fileStat?.isFile()) continue;
    files += 1;
    bytes += fileStat.size;
  }
  return { files, bytes };
}
