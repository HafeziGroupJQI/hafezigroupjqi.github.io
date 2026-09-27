// The compute relay wire format, protocol v1 (the host's codec is the compute repo's
// hafezi_compute/tunnel/frames.py). Every frame is one binary WebSocket message: an 8-byte
// little-endian header `type u8 | flags u8 | reserved u16 | stream_id u32` and a payload of at
// most 256 KiB. test/fixtures/compute-vectors.json is shared with the host tunnel and pins the
// byte layouts.

export const FrameType = {
  OPEN_HTTP: 0x01,
  RESPONSE_HEAD: 0x02,
  DATA: 0x03,
  RESET: 0x04,
  WINDOW: 0x05,
  OPEN_WS: 0x06,
  WS_ACCEPT: 0x07,
  WS_MSG: 0x08,
  WS_CLOSE: 0x09,
  HELLO: 0x10,
  GOAWAY: 0x11,
  CONTROL: 0x12,
  CONTROL_RESULT: 0x13,
} as const
export type FrameType = (typeof FrameType)[keyof typeof FrameType]

/** Flag bits: BIN (binary WS message), FIN (last WS fragment), EOS (end of an HTTP body). */
export const Flag = { BIN: 1, FIN: 2, EOS: 4 } as const

export const HEADER_BYTES = 8
export const MAX_PAYLOAD = 256 * 1024
/** Credit each direction starts with, per stream. */
export const INITIAL_WINDOW = 512 * 1024
export const PROTOCOL_VERSION = 1

export interface Frame {
  type: number
  flags: number
  streamId: number
  payload: Uint8Array
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const EMPTY = new Uint8Array(0)

export function encodeFrame(
  type: number,
  streamId: number,
  payload: Uint8Array = EMPTY,
  flags = 0,
): Uint8Array {
  if (payload.byteLength > MAX_PAYLOAD) throw new RangeError("frame payload over 256 KiB")
  const out = new Uint8Array(HEADER_BYTES + payload.byteLength)
  const view = new DataView(out.buffer)
  view.setUint8(0, type)
  view.setUint8(1, flags)
  view.setUint16(2, 0, true)
  view.setUint32(4, streamId >>> 0, true)
  out.set(payload, HEADER_BYTES)
  return out
}

export function decodeFrame(message: ArrayBuffer | Uint8Array): Frame {
  const bytes = message instanceof Uint8Array ? message : new Uint8Array(message)
  if (bytes.byteLength < HEADER_BYTES) throw new RangeError("short frame")
  if (bytes.byteLength > HEADER_BYTES + MAX_PAYLOAD) throw new RangeError("oversize frame")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return {
    type: view.getUint8(0),
    flags: view.getUint8(1),
    streamId: view.getUint32(4, true),
    payload: bytes.subarray(HEADER_BYTES),
  }
}

// ---- payload helpers ----

export const jsonPayload = (value: unknown) => encoder.encode(JSON.stringify(value))

export const jsonFrame = (type: number, streamId: number, value: unknown, flags = 0) =>
  encodeFrame(type, streamId, jsonPayload(value), flags)

export function readJsonPayload<T>(frame: Frame): T {
  return JSON.parse(decoder.decode(frame.payload)) as T
}

export function windowPayload(credit: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, credit >>> 0, true)
  return out
}

export function readWindow(frame: Frame): number {
  if (frame.payload.byteLength < 4) return 0
  return new DataView(
    frame.payload.buffer,
    frame.payload.byteOffset,
    frame.payload.byteLength,
  ).getUint32(0, true)
}

export function closePayload(code: number, reason = ""): Uint8Array {
  const text = encoder.encode(reason)
  const out = new Uint8Array(2 + text.byteLength)
  new DataView(out.buffer).setUint16(0, code, true)
  out.set(text, 2)
  return out
}

export function readClose(frame: Frame): { code: number; reason: string } {
  if (frame.payload.byteLength < 2) return { code: 1005, reason: "" }
  const view = new DataView(frame.payload.buffer, frame.payload.byteOffset, 2)
  return { code: view.getUint16(0, true), reason: decoder.decode(frame.payload.subarray(2)) }
}

/** Split `bytes` into ≤ MAX_PAYLOAD slices (always at least one, possibly empty). */
export function fragments(bytes: Uint8Array, size = MAX_PAYLOAD): Uint8Array[] {
  if (bytes.byteLength <= size) return [bytes]
  const out: Uint8Array[] = []
  for (let offset = 0; offset < bytes.byteLength; offset += size)
    out.push(bytes.subarray(offset, offset + size))
  return out
}
