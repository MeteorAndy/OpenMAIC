/**
 * Upload a single blob to object storage and return its CDN URL.
 *
 * The server content-addresses the blob by sha256 (dedup), so re-uploading the
 * same bytes returns the same URL (makes callers idempotent). Returns `null` on
 * any failure or when storage is unconfigured (NoopStorageProvider) — callers
 * decide the fallback.
 */
export async function uploadBlobToStorage(
  blob: Blob,
  type: 'media' | 'audio' | 'poster',
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    const formData = new FormData();
    formData.append('type', type);
    formData.append('file', blob);
    const res = await fetch('/api/assets/upload', { method: 'POST', body: formData, signal });
    if (!res.ok) return null;
    const { url } = await res.json();
    return typeof url === 'string' && url.length > 0 ? url : null;
  } catch {
    return null;
  }
}
