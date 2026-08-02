import { PNG } from 'pngjs';

// Guard against malicious PDFs with extreme image dimensions: pngjs allocates
// width*height*4 bytes upfront, so unbounded dimensions = memory exhaustion (DoS).
// sharp/libvips enforced similar limits internally; we must too after going pure-JS.
const MAX_DIMENSION = 30000;
const MAX_PIXELS = 50_000_000; // ~50 megapixels (~200MB RGBA) — tight DoS guard

/**
 * Encode raw pixel data (width × height × channels) into a PNG Buffer.
 *
 * Replaces `sharp(buf, { raw: { width, height, channels } }).png().toBuffer()`
 * with a pure-JS encoder so the server has ZERO native addons — a prerequisite
 * for bundling OpenMAIC as a Tauri desktop app (no per-platform prebuilt matrix,
 * no Next standalone tracing issues, no Cairo/Pango system libs).
 *
 * Output is always RGBA. 1/2/3-channel inputs are expanded with alpha:
 *  - 1 (gray)        -> gray,gray,gray,255
 *  - 2 (gray+alpha)  -> gray,gray,gray,alpha
 *  - 3 (rgb)         -> r,g,b,255
 *  - 4 (rgba)        -> passthrough
 */
export function rawToPngBuffer(
  data: Uint8Array | Uint8ClampedArray | Buffer,
  width: number,
  height: number,
  channels: number,
): Buffer {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_DIMENSION ||
    height > MAX_DIMENSION ||
    width * height > MAX_PIXELS
  ) {
    throw new Error(`Invalid or oversized image dimensions: ${width}x${height}`);
  }

  const png = new PNG({ width, height });
  const src = Buffer.from(data);
  const dst = png.data; // Uint8Array, length = width * height * 4

  switch (channels) {
    case 4:
      src.copy(dst);
      break;
    case 3:
      for (let i = 0, j = 0; i < src.length; i += 3, j += 4) {
        dst[j] = src[i]!;
        dst[j + 1] = src[i + 1]!;
        dst[j + 2] = src[i + 2]!;
        dst[j + 3] = 255;
      }
      break;
    case 2: // gray + alpha
      for (let i = 0, j = 0; i < src.length; i += 2, j += 4) {
        const g = src[i]!;
        dst[j] = g;
        dst[j + 1] = g;
        dst[j + 2] = g;
        dst[j + 3] = src[i + 1]!;
      }
      break;
    case 1:
      for (let i = 0, j = 0; i < src.length; i += 1, j += 4) {
        const g = src[i]!;
        dst[j] = g;
        dst[j + 1] = g;
        dst[j + 2] = g;
        dst[j + 3] = 255;
      }
      break;
    default:
      throw new Error(`Unsupported channel count: ${channels}`);
  }

  return PNG.sync.write(png) as Buffer;
}
