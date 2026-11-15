/**
 * CRC-32C (Castagnoli) used by journal frame headers (DD-FND-059).
 * Polynomial 0x1EDC6F41, reflected form 0x82F63B78.
 */

const CRC32C_TABLE: Uint32Array = buildTable();

function buildTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
    }
    table[index] = crc >>> 0;
  }
  return table;
}

/** Returns the unsigned CRC-32C of `bytes`. */
export function crc32c(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    const entry = CRC32C_TABLE[(crc ^ byte) & 0xff] ?? 0;
    crc = (crc >>> 8) ^ entry;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
