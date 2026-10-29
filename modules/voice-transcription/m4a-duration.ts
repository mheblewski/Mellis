/**
 * Length of an MPEG-4 audio file (.m4a, what the iOS recorder writes) from its movie header (moov/mvhd), in seconds.
 * The server bounds the transcription cost by this length, so it is read from the file itself and never taken from the
 * client. Null when the file is not MPEG-4, has no movie header or states no length.
 */
export function m4aDurationSeconds(data: Buffer): number | null {
  if (!hasFileTypeBox(data)) return null;
  const moov = findBox(data, 0, data.length, 'moov');
  if (!moov) return null;
  const mvhd = findBox(data, moov.contentStart, moov.end, 'mvhd');
  if (!mvhd) return null;
  return readMovieHeaderDuration(data, mvhd.contentStart, mvhd.end);
}

interface Box {
  contentStart: number;
  end: number;
}

/** An MPEG-4 file starts with its "ftyp" box. */
function hasFileTypeBox(data: Buffer): boolean {
  return data.length >= 8 && data.toString('latin1', 4, 8) === 'ftyp';
}

/** The first box of `type` among the boxes between `start` and `end` (one level, no descent). */
function findBox(data: Buffer, start: number, end: number, type: string): Box | null {
  let offset = start;
  while (offset + 8 <= end) {
    let size = data.readUInt32BE(offset);
    const boxType = data.toString('latin1', offset + 4, offset + 8);
    let headerSize = 8;
    if (size === 1) {
      // 64-bit size after the type.
      if (offset + 16 > end) return null;
      const large = data.readBigUInt64BE(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(large);
      headerSize = 16;
    } else if (size === 0) {
      // The box runs to the end of its parent.
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) return null;
    if (boxType === type) return { contentStart: offset + headerSize, end: offset + size };
    offset += size;
  }
  return null;
}

/** mvhd: version (1 byte), flags (3), then creation and modification times, timescale and duration (32 or 64 bit). */
function readMovieHeaderDuration(data: Buffer, start: number, end: number): number | null {
  if (start + 4 > end) return null;
  const version = data.readUInt8(start);
  let timescale: number;
  let duration: number;
  if (version === 1) {
    if (start + 32 > end) return null;
    timescale = data.readUInt32BE(start + 20);
    const large = data.readBigUInt64BE(start + 24);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    duration = Number(large);
  } else if (version === 0) {
    if (start + 20 > end) return null;
    timescale = data.readUInt32BE(start + 12);
    duration = data.readUInt32BE(start + 16);
  } else {
    return null;
  }
  // All ones means "unknown length".
  if (timescale === 0 || duration === 0 || duration === 0xffffffff) return null;
  return duration / timescale;
}
