/**
 * CRC-32C (Castagnoli) — the checksum used by the 24-byte IPC frame header.
 *
 * Reflected polynomial 0x82F63B78, initial value 0xFFFFFFFF, final xor
 * 0xFFFFFFFF. The incremental entry point lets the codec hash
 * "header-with-crc-zeroed || body" without concatenating the two buffers.
 */

const CRC32C_POLYNOMIAL = 0x82f63b78;

function buildTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (value >>> 1) ^ CRC32C_POLYNOMIAL : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

const CRC32C_TABLE: Uint32Array = buildTable();

/**
 * Folds `data` into a running CRC-32C. Passing the previous return value as
 * `seed` yields the same checksum as hashing the concatenation of the inputs.
 */
export function crc32cUpdate(seed: number, data: Uint8Array): number {
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let index = 0; index < data.length; index += 1) {
    const byte = data[index];
    if (byte === undefined) {
      continue;
    }
    const slot = (crc ^ byte) & 0xff;
    const entry = CRC32C_TABLE[slot];
    crc = entry === undefined ? crc >>> 8 : (crc >>> 8) ^ entry;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** CRC-32C of a single buffer. Check vector: ASCII "123456789" -> 0xE3069283. */
export function crc32c(data: Uint8Array): number {
  return crc32cUpdate(0, data);
}
