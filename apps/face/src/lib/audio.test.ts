import { describe, expect, it } from 'vitest';
import { encodeWav } from './audio.js';

/**
 * Sarvam rejects malformed WAV with an opaque error, so the header is worth
 * asserting byte by byte rather than discovering it is wrong over the network.
 */
async function headerOf(blob: Blob) {
  const view = new DataView(await blob.arrayBuffer());
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...Array.from({ length }, (_, i) => view.getUint8(offset + i)));

  return {
    riff: ascii(0, 4),
    wave: ascii(8, 4),
    fmt: ascii(12, 4),
    audioFormat: view.getUint16(20, true),
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    byteRate: view.getUint32(28, true),
    blockAlign: view.getUint16(32, true),
    bitsPerSample: view.getUint16(34, true),
    data: ascii(36, 4),
    dataSize: view.getUint32(40, true),
    riffSize: view.getUint32(4, true),
    view,
  };
}

describe('encodeWav', () => {
  it('writes a valid 16-bit mono PCM header', async () => {
    const frames = [new Float32Array(128), new Float32Array(128)];
    const h = await headerOf(encodeWav(frames, 16000));

    expect(h.riff).toBe('RIFF');
    expect(h.wave).toBe('WAVE');
    expect(h.fmt).toBe('fmt ');
    expect(h.data).toBe('data');
    expect(h.audioFormat).toBe(1); // PCM
    expect(h.channels).toBe(1);
    expect(h.sampleRate).toBe(16000);
    expect(h.bitsPerSample).toBe(16);
    expect(h.blockAlign).toBe(2);
    expect(h.byteRate).toBe(16000 * 2);
  });

  it('reports sizes consistent with the payload', async () => {
    const frames = [new Float32Array(100), new Float32Array(56)];
    const blob = encodeWav(frames, 16000);
    const h = await headerOf(blob);

    expect(h.dataSize).toBe(156 * 2);
    expect(h.riffSize).toBe(36 + 156 * 2);
    expect(blob.size).toBe(44 + 156 * 2);
  });

  it('maps full-scale samples to the 16-bit extremes', async () => {
    const h = await headerOf(encodeWav([Float32Array.from([1, -1, 0])], 16000));

    expect(h.view.getInt16(44, true)).toBe(32767);
    expect(h.view.getInt16(46, true)).toBe(-32768);
    expect(h.view.getInt16(48, true)).toBe(0);
  });

  it('clamps out-of-range samples instead of wrapping them', async () => {
    // Wrapping would turn a loud peak into a loud opposite-phase click.
    const h = await headerOf(encodeWav([Float32Array.from([4.2, -3.7])], 16000));

    expect(h.view.getInt16(44, true)).toBe(32767);
    expect(h.view.getInt16(46, true)).toBe(-32768);
  });

  it('produces a header-only file for no audio', () => {
    expect(encodeWav([], 16000).size).toBe(44);
  });
});
