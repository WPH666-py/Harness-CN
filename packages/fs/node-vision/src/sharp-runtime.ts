/** Lazy loader for the optional sharp raster engine. @module @deepseek-ai/dsh-node-vision/src/sharp-runtime */

import type { Sharp } from 'sharp'

/**
 * Input options accepted by this package's pipelines.
 *
 * Encoded bytes are decoded strictly, so `failOn: 'error'` refuses truncated input
 * instead of decoding a partial image, and `limitInputPixels: false` defers the
 * decoded-size bound to the attachment store, which owns the deployment's
 * authoritative pixel limit. Raw input carries the pixels a tool just produced, and
 * takes the `raw` descriptor instead of the decode options.
 */
export interface SharpInputOptions {
  readonly failOn?: 'error'
  readonly limitInputPixels?: boolean
  readonly raw?: {
    readonly width: number
    readonly height: number
    readonly channels: 1 | 2 | 3 | 4
  }
}

/** The sharp entry point: one pipeline constructed from encoded or raw pixels. */
export type SharpFactory = (input: Uint8Array, options?: SharpInputOptions) => Sharp

/** Options this package passes to every decode of encoded bytes. */
export const SHARP_DECODE_OPTIONS: SharpInputOptions = { failOn: 'error', limitInputPixels: false }

let loaded: Promise<SharpFactory> | undefined

/**
 * Load `sharp` once and translate a failed load into an actionable error.
 *
 * sharp ships a prebuilt native binary per platform, so an installed package can
 * still fail to import when that binary is absent, built for another platform, or
 * blocked by a local policy. A static import would fail the whole plugin at module
 * load with a bare resolution error; this reports the cause at the call that needs
 * it, beside the operation the user asked for.
 * @returns the sharp entry point, shared by every later call.
 */
export function loadSharp(): Promise<SharpFactory> {
  loaded ??= import('sharp').then(
    (module) => {
      // sharp is CommonJS: an ESM namespace carries the factory on `default`, and a
      // loader that already unwrapped it hands the factory itself.
      const candidate = (module as { default?: SharpFactory }).default ?? (module as unknown as SharpFactory)
      if (typeof candidate !== 'function') {
        throw new Error('node-vision: the sharp module loaded without a callable entry point')
      }
      return candidate
    },
    (error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(
        'node-vision: the sharp raster engine could not be loaded. '
        + 'sharp ships a prebuilt native binary, so this usually means the binary for this platform is missing '
        + `or blocked by a local policy. Cause: ${reason}`,
        { cause: error },
      )
    },
  )
  return loaded
}

/**
 * Read one image's metadata, refusing bytes sharp cannot decode.
 * @param factory - loaded sharp entry point.
 * @param data - encoded image bytes.
 * @returns decoded metadata carrying at least width and height.
 */
export async function decodeMetadata(
  factory: SharpFactory,
  data: Uint8Array,
): Promise<{ width: number; height: number; format: string; channels: number; hasAlpha: boolean; space: string }> {
  const pipeline = factory(data, SHARP_DECODE_OPTIONS)
  let metadata: Awaited<ReturnType<Sharp['metadata']>>
  try {
    metadata = await pipeline.metadata()
  } catch (error: unknown) {
    throw new Error(
      `node-vision: the file could not be decoded as an image: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
  const { width, height, format, channels, space } = metadata
  if (width === undefined || height === undefined || format === undefined) {
    throw new Error('node-vision: the image decoded without usable dimensions; the file may be truncated or not an image')
  }
  return {
    width,
    height,
    format,
    channels: channels ?? 0,
    hasAlpha: metadata.hasAlpha === true,
    space: space ?? 'unknown',
  }
}
