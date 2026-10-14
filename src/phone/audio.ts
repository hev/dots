/** G.711 mu-law and little-endian PCM. Streaming downsampling keeps partial frames. */
export const decode64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
export function encode64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
export function decodeMuLaw(byte: number): number {
  const u = (~byte) & 255;
  const value = (((u & 15) << 3) + 132) << ((u >> 4) & 7);
  return (u & 128) ? 132 - value : value - 132;
}
export function encodeMuLaw(sample: number): number {
  const sign = sample < 0 ? 128 : 0;
  let value = Math.min(32635, Math.abs(sample)) + 132;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && !(value & mask); mask >>= 1) exponent--;
  return (~(sign | (exponent << 4) | ((value >> (exponent + 3)) & 15))) & 255;
}
/** 8 kHz mu-law -> 16 kHz PCM with linear interpolation. */
export function inputAudio() {
  let previous = 0;
  return (bytes: Uint8Array): Uint8Array => {
    const out = new Uint8Array(bytes.length * 4), view = new DataView(out.buffer);
    bytes.forEach((b, i) => {
      const sample = decodeMuLaw(b);
      view.setInt16(i * 4, Math.round((previous + sample) / 2), true);
      view.setInt16(i * 4 + 2, sample, true);
      previous = sample;
    });
    return out;
  };
}
/** 24 kHz PCM -> 8 kHz mu-law, averaging triples to reduce aliasing. */
export function outputAudio() {
  let pending: number[] = [];
  return (bytes: Uint8Array): Uint8Array => {
    for (const byte of bytes) pending.push(byte);
    const out: number[] = [];
    let i = 0;
    for (; i + 5 < pending.length; i += 6) {
      let sum = 0;
      for (let j = 0; j < 6; j += 2) {
        const n = pending[i + j]! | (pending[i + j + 1]! << 8);
        sum += n & 32768 ? n - 65536 : n;
      }
      out.push(encodeMuLaw(Math.round(sum / 3)));
    }
    pending = pending.slice(i);
    return Uint8Array.from(out);
  };
}
