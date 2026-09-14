// Minimal protobuf wire-format codec — no schema needed.
// Field numbers are hand-mapped from the Connect-RPC message structure.

export function varint(n) {
  n = typeof n === "bigint" ? n : BigInt(Math.trunc(Number(n)));
  if (n < 0n) n &= (1n << 64n) - 1n; // int64 two's complement
  const out = [];
  while (true) {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n === 0n) { out.push(b); break; }
    out.push(b | 0x80);
  }
  return Buffer.from(out);
}

export function key(fieldNum, wireType) {
  return varint((fieldNum << 3) | wireType);
}

export const fVarint = (fn, v) => Buffer.concat([key(fn, 0), varint(v)]);
export const fStr = (fn, s) => {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([key(fn, 2), varint(b.length), b]);
};
export const fBytes = (fn, b) => Buffer.concat([key(fn, 2), varint(b.length), b]);
export const fMsg = fBytes;
export const fF64 = (fn, d) => {
  const b = Buffer.alloc(8);
  b.writeDoubleLE(d);
  return Buffer.concat([key(fn, 1), b]);
};

// ---- decoding ----

function readVarint(buf, i) {
  let result = 0n, shift = 0n;
  while (i < buf.length) {
    const b = buf[i++];
    result |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7n;
  }
  return [Number(result), i];
}

// Returns array of {f: fieldNum, wt: wireType, v: number|Buffer}
export function decodeMsg(buf) {
  const fields = [];
  let i = 0;
  while (i < buf.length) {
    const [k, j] = readVarint(buf, i);
    i = j;
    const f = k >> 3, wt = k & 7;
    if (f === 0) break;
    if (wt === 0) {
      const [v, j2] = readVarint(buf, i);
      i = j2;
      fields.push({ f, wt, v });
    } else if (wt === 1) {
      if (i + 8 > buf.length) break; // truncated
      fields.push({ f, wt, v: buf.subarray(i, i + 8) });
      i += 8;
    } else if (wt === 2) {
      const [ln, j2] = readVarint(buf, i);
      i = j2;
      if (i + ln > buf.length) break; // truncated
      fields.push({ f, wt, v: buf.subarray(i, i + ln) });
      i += ln;
    } else if (wt === 5) {
      if (i + 4 > buf.length) break; // truncated
      fields.push({ f, wt, v: buf.subarray(i, i + 4) });
      i += 4;
    } else {
      break; // unknown wire type — bail
    }
  }
  return fields;
}

