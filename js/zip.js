/*
 * Minimal zip reader shared by the export parsers (and used on the page to tell
 * export types apart). Like messageLib, it is serialized into the worker source, so
 * it must be self-contained.
 *
 * Only the central directory and the entries actually asked for are read. Entries
 * are inflated with the native DecompressionStream, and ZIP64 archives (> 4 GB, as
 * Google Takeout often produces) are supported.
 */
function zipLib() {
  'use strict';

  const SIG_EOCD = 0x06054b50;
  const SIG_EOCD64 = 0x06064b50;
  const SIG_EOCD64_LOC = 0x07064b50;
  const SIG_CENTRAL = 0x02014b50;
  const SIG_LOCAL = 0x04034b50;
  const utf8 = new TextDecoder('utf-8');

  const u64 = (v, p) => v.getUint32(p, true) + v.getUint32(p + 4, true) * 4294967296;

  async function readBytes(file, start, end) {
    return new DataView(await file.slice(start, end).arrayBuffer());
  }

  /** List the entries of one zip file: { name, method, csize, usize, offset, file }. */
  async function listZip(file) {
    const tailStart = Math.max(0, file.size - (65535 + 22 + 20));
    const tail = await readBytes(file, tailStart, file.size);
    let eocd = -1;
    for (let p = tail.byteLength - 22; p >= 0; p--) {
      if (tail.getUint32(p, true) === SIG_EOCD) { eocd = p; break; }
    }
    if (eocd < 0) throw new Error(`${file.name} is not a zip file`);

    let count = tail.getUint16(eocd + 10, true);
    let cdSize = tail.getUint32(eocd + 12, true);
    let cdOffset = tail.getUint32(eocd + 16, true);
    if (eocd >= 20 && tail.getUint32(eocd - 20, true) === SIG_EOCD64_LOC) {
      const at = u64(tail, eocd - 20 + 8);
      const rec = await readBytes(file, at, at + 56);
      if (rec.getUint32(0, true) !== SIG_EOCD64) throw new Error(`${file.name}: damaged ZIP64 directory`);
      count = u64(rec, 32);
      cdSize = u64(rec, 40);
      cdOffset = u64(rec, 48);
    }

    const cd = await readBytes(file, cdOffset, cdOffset + cdSize);
    const bytes = new Uint8Array(cd.buffer, cd.byteOffset, cd.byteLength);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count && p + 46 <= cd.byteLength; i++) {
      if (cd.getUint32(p, true) !== SIG_CENTRAL) throw new Error(`${file.name}: damaged zip directory`);
      const method = cd.getUint16(p + 10, true);
      let csize = cd.getUint32(p + 20, true);
      let usize = cd.getUint32(p + 24, true);
      const nameLen = cd.getUint16(p + 28, true);
      const extraLen = cd.getUint16(p + 30, true);
      const commentLen = cd.getUint16(p + 32, true);
      let offset = cd.getUint32(p + 42, true);
      const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen));

      // ZIP64 extra field: only the values that overflowed are present, in this order.
      let x = p + 46 + nameLen;
      const xEnd = x + extraLen;
      while (x + 4 <= xEnd) {
        const id = cd.getUint16(x, true);
        const len = cd.getUint16(x + 2, true);
        if (id === 0x0001) {
          let q = x + 4;
          if (usize === 0xffffffff) { usize = u64(cd, q); q += 8; }
          if (csize === 0xffffffff) { csize = u64(cd, q); q += 8; }
          if (offset === 0xffffffff) { offset = u64(cd, q); q += 8; }
        }
        x += 4 + len;
      }

      entries.push({ name, method, csize, usize, offset, file });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  async function readEntryText(e) {
    const head = await readBytes(e.file, e.offset, e.offset + 30);
    if (head.getUint32(0, true) !== SIG_LOCAL) throw new Error(`${e.file.name}: damaged entry ${e.name}`);
    const start = e.offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
    const data = e.file.slice(start, start + e.csize);
    if (e.method === 0) return data.text();
    if (e.method !== 8) throw new Error(`${e.name}: unsupported zip compression method ${e.method}`);
    return new Response(data.stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
  }

  return { listZip, readEntryText };
}
