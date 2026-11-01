/**
 * The decode chain, exercised over the bytes each branch is about: a byte order
 * mark that names an encoding, plain UTF-8, the GB18030 fallback, and the
 * payloads that must land on the binary verdict instead of mojibake.
 */
import { describe, expect, it } from 'vitest'
import { decodeFile, isReadOnlyEncoding } from '../src/client/encoding.ts'

/** The four bytes of 中文 in GB18030, the encoding the text read verb refuses. */
const GB18030_CHINESE = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])

describe('decodeFile', () => {
  it('decodes plain UTF-8 as editable text', () => {
    expect(decodeFile(new Uint8Array([0x68, 0x65, 0x6c, 0x6c, 0x6f]))).toEqual({
      kind: 'text',
      text: 'hello',
      encoding: 'utf-8',
    })
  })

  it('decodes an empty file as an empty UTF-8 buffer', () => {
    expect(decodeFile(new Uint8Array([]))).toEqual({ kind: 'text', text: '', encoding: 'utf-8' })
  })

  it('drops the UTF-8 byte order mark instead of showing it', () => {
    expect(decodeFile(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]))).toEqual({
      kind: 'text',
      text: 'hi',
      encoding: 'utf-8',
    })
  })

  it('decodes a little-endian UTF-16 file with a byte order mark', () => {
    expect(decodeFile(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]))).toEqual({
      kind: 'text',
      text: 'hi',
      encoding: 'utf-16le',
    })
  })

  it('decodes a big-endian UTF-16 file with a byte order mark', () => {
    expect(decodeFile(new Uint8Array([0xfe, 0xff, 0x00, 0x68, 0x00, 0x69]))).toEqual({
      kind: 'text',
      text: 'hi',
      encoding: 'utf-16be',
    })
  })

  it('decodes GB18030 when the bytes are not valid UTF-8', () => {
    expect(decodeFile(GB18030_CHINESE)).toEqual({ kind: 'text', text: '中文', encoding: 'gb18030' })
  })

  it('calls a payload with a NUL byte binary', () => {
    expect(decodeFile(new Uint8Array([0x61, 0x00]))).toEqual({ kind: 'binary' })
  })

  it('calls a payload no encoding of the chain accepts binary', () => {
    expect(decodeFile(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0xff]))).toEqual({ kind: 'binary' })
  })

  it('calls a byte order mark with an undecodable body binary', () => {
    expect(decodeFile(new Uint8Array([0xef, 0xbb, 0xbf, 0xff]))).toEqual({ kind: 'binary' })
  })

  it('calls a UTF-16 byte order mark with an incomplete unit binary', () => {
    expect(decodeFile(new Uint8Array([0xff, 0xfe, 0x68]))).toEqual({ kind: 'binary' })
  })
})

describe('isReadOnlyEncoding', () => {
  it('writes back only the encoding the save verb reproduces', () => {
    expect(isReadOnlyEncoding('utf-8')).toBe(false)
    expect(isReadOnlyEncoding('utf-16le')).toBe(true)
    expect(isReadOnlyEncoding('utf-16be')).toBe(true)
    expect(isReadOnlyEncoding('gb18030')).toBe(true)
  })
})
