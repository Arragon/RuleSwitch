// Minimal UTF-8 encode/decode for environments without DOM TextEncoder
// (core targets lib ES2023). Total functions: invalid input never throws.

export function utf8Encode(input: string): Uint8Array {
  const codePoints = Array.from(input, (char) => char.codePointAt(0) ?? 0);
  const octets: number[] = [];
  for (const codePoint of codePoints) {
    if (codePoint < 0x80) {
      octets.push(codePoint);
    } else if (codePoint < 0x800) {
      octets.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      octets.push(0xe0 | (codePoint >> 12), 0x80 | ((codePoint >> 6) & 0x3f), 0x80 | (codePoint & 0x3f));
    } else {
      octets.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f)
      );
    }
  }
  return Uint8Array.from(octets);
}

export function utf8Decode(bytes: Uint8Array): string {
  let result = "";
  let index = 0;
  while (index < bytes.length) {
    const byte = bytes[index] ?? 0;
    let codePoint: number;
    let width: number;
    if (byte < 0x80) {
      codePoint = byte;
      width = 1;
    } else if (byte < 0xe0) {
      codePoint = byte & 0x1f;
      width = 2;
    } else if (byte < 0xf0) {
      codePoint = byte & 0x0f;
      width = 3;
    } else {
      codePoint = byte & 0x07;
      width = 4;
    }
    for (let offset = 1; offset < width; offset += 1) {
      const continuation = bytes[index + offset] ?? 0;
      codePoint = (codePoint << 6) | (continuation & 0x3f);
    }
    result += String.fromCodePoint(codePoint);
    index += width;
  }
  return result;
}
