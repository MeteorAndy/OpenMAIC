import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';

import { rawToPngBuffer } from '@/lib/pdf/raw-to-png';

// tsconfig has allowJs:true, so TS infers pngjs's types from its JS source and
// drops `sync.read` from the inferred shape (shadows @types/pngjs). `read`
// exists at runtime; restore the documented signature for round-trip checks.
const readPng = (
  PNG.sync as typeof PNG.sync & {
    read: (buffer: Buffer) => { width: number; height: number; data: Buffer };
  }
).read;

describe('rawToPngBuffer', () => {
  it('encodes a 3-channel RGB buffer to a valid opaque-RGBA PNG', () => {
    // 2x1 image: red pixel, green pixel
    const rgb = Buffer.from([255, 0, 0, 0, 255, 0]);
    const png = rawToPngBuffer(rgb, 2, 1, 3);

    // PNG signature
    expect(png[0]).toBe(0x89);
    expect(png[1]).toBe(0x50); // 'P'

    const decoded = readPng(png);
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(1);
    expect(Array.from(decoded.data as Uint8Array)).toEqual([
      255, 0, 0, 255, 0, 255, 0, 255,
    ]);
  });

  it('passes a 4-channel RGBA buffer through unchanged', () => {
    const rgba = Buffer.from([10, 20, 30, 40, 50, 60, 70, 80]);
    const png = rawToPngBuffer(rgba, 2, 1, 4);
    const decoded = readPng(png);
    expect(Array.from(decoded.data as Uint8Array)).toEqual([
      10, 20, 30, 40, 50, 60, 70, 80,
    ]);
  });

  it('expands a 1-channel grayscale buffer to opaque RGBA', () => {
    const gray = Buffer.from([128, 200]);
    const png = rawToPngBuffer(gray, 2, 1, 1);
    const decoded = readPng(png);
    expect(Array.from(decoded.data as Uint8Array)).toEqual([
      128, 128, 128, 255, 200, 200, 200, 255,
    ]);
  });

  it('expands a 2-channel gray+alpha buffer to RGBA', () => {
    const ga = Buffer.from([128, 200, 50, 255]); // (gray,alpha) × 2 pixels
    const png = rawToPngBuffer(ga, 2, 1, 2);
    const decoded = readPng(png);
    expect(Array.from(decoded.data as Uint8Array)).toEqual([
      128, 128, 128, 200, 50, 50, 50, 255,
    ]);
  });

  it('throws on unsupported channel counts', () => {
    expect(() => rawToPngBuffer(Buffer.from([]), 1, 1, 5)).toThrow(/channel/i);
  });

  it('rejects oversized dimensions that would exhaust memory', () => {
    // width beyond MAX_DIMENSION
    expect(() => rawToPngBuffer(Buffer.from([]), 50000, 1, 4)).toThrow(/dimension/i);
    // height beyond MAX_DIMENSION
    expect(() => rawToPngBuffer(Buffer.from([]), 1, 50000, 4)).toThrow(/dimension/i);
    // within per-side limit but pixel count over MAX_PIXELS (20000x20000 = 400M)
    expect(() => rawToPngBuffer(Buffer.from([]), 20000, 20000, 4)).toThrow(/dimension/i);
    // zero / negative rejected
    expect(() => rawToPngBuffer(Buffer.from([]), 0, 1, 4)).toThrow(/dimension/i);
  });
});
