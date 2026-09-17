/**
 * Read-only inspection tools: `vision_info` reports one image's facts and
 * `vision_colors` reduces it to a palette. Neither produces an image block, so
 * both are useful before deciding which transform to ask for.
 * @module @deepseek-ai/dsh-node-vision/src/tools/inspect
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { VisionRuntime } from '../image-io.ts'
import { loadImage } from '../image-io.ts'
import { SHARP_DECODE_OPTIONS, decodeMetadata, loadSharp } from '../sharp-runtime.ts'

/** Palette entries returned when the caller does not name a count. */
const DEFAULT_PALETTE_COUNT = 8

/** Largest palette the tool returns; beyond this the list stops being a summary. */
const MAX_PALETTE_COUNT = 64

/**
 * Grid the palette extraction samples.
 *
 * Quantizing a downscaled grid keeps the palette a summary of the whole image
 * instead of the few pixels a corner happens to hold, and bounds the work at one
 * small decode regardless of the source resolution.
 */
const PALETTE_GRID = 64

/** Bits kept per channel when bucketing colours; 4 bits is 16 levels and reads as distinct. */
const PALETTE_CHANNEL_BITS = 4

/**
 * Register `vision_info` and `vision_colors`.
 * @param ctx - plugin context, used for filesystem access and observation events.
 * @param runtime - context and attachment store shared by the tool set.
 */
export function applyInspectTools(ctx: VisionRuntime['ctx'], runtime: VisionRuntime): void {
  ctx.tools.register(defineTool({
    name: 'vision_info',
    description: 'Report one image file\'s dimensions, format, byte size, channel count, and whether it carries alpha. '
      + 'Use this before a pixel operation when you need the current geometry, for example to check that a crop region fits, '
      + 'or to confirm the file really is an image. Returns text only. '
      + 'Use read_image instead when the goal is to look at the picture; this tool only measures it.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to the image file, resolved by the filesystem backend.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          width: { type: 'number', required: true },
          height: { type: 'number', required: true },
          format: { type: 'string', required: true },
          bytes: { type: 'number', required: true },
          channels: { type: 'number', required: true },
          hasAlpha: { type: 'boolean', required: true },
          space: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<path>${value.path}</path>
<type>image</type>
<content>
${value.format} image, ${value.width}x${value.height} px, ${value.bytes} bytes, ${value.channels} channels, alpha ${value.hasAlpha ? 'yes' : 'no'}, colour space ${value.space}
</content>`,
      }] satisfies ContentBlock[],
      presentationMeta: (_args, value) => ({ path: value.path }),
    },
    // Decoding is a pure read, so concurrent calls on one file cannot conflict.
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const loaded = await loadImage(runtime, exec, args.file_path)
      const factory = await loadSharp()
      const decoded = await decodeMetadata(factory, loaded.data)
      return {
        path: loaded.displayPath,
        width: decoded.width,
        height: decoded.height,
        format: decoded.format,
        bytes: loaded.data.byteLength,
        channels: decoded.channels,
        hasAlpha: decoded.hasAlpha,
        space: decoded.space,
      }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `Inspect image ${args.file_path}`, kind: 'read', locations: [{ path: args.file_path }] }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vision_colors',
    description: `Reduce one image to its dominant colours as a palette of at most ${String(MAX_PALETTE_COUNT)} entries, each a hex value with the share of pixels it covers. `
      + 'Use this to answer questions about an image\'s colour scheme, to pick a matching colour, or to check whether a design is monochrome. Returns text only. '
      + 'Ordinary image questions belong to read_image, which shows you the picture itself.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to the image file, resolved by the filesystem backend.' },
      count: { type: 'number', description: `How many palette entries to return. Defaults to ${String(DEFAULT_PALETTE_COUNT)}, maximum ${String(MAX_PALETTE_COUNT)}.` },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          palette: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                hex: { type: 'string', required: true },
                share: { type: 'number', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => {
        const lines = value.palette
          .map(entry => `${entry.hex}  ${(entry.share * 100).toFixed(1)}%`)
          .join('\n')
        return [{
          type: 'text',
          text: `<path>${value.path}</path>
<type>palette</type>
<content>
${lines}
</content>`,
        }] satisfies ContentBlock[]
      },
      presentationMeta: (_args, value) => ({ path: value.path }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const requested = args.count ?? DEFAULT_PALETTE_COUNT
      if (!Number.isInteger(requested) || requested < 1) {
        throw new Error('count must be a positive integer')
      }
      if (requested > MAX_PALETTE_COUNT) {
        throw new Error(`count must be at most ${String(MAX_PALETTE_COUNT)}`)
      }
      const loaded = await loadImage(runtime, exec, args.file_path)
      const palette = await extractPalette(loaded.data, requested, loaded.displayPath)
      return { path: loaded.displayPath, palette }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `Colours of ${args.file_path}`, kind: 'read', locations: [{ path: args.file_path }] }
    },
  }))
}

/** One palette entry: a hex colour and the share of sampled pixels it covers. */
interface PaletteEntry {
  readonly hex: string
  readonly share: number
}

/**
 * Reduce an image to its dominant colours.
 *
 * The image is downscaled to a fixed grid and its pixels bucketed by the top bits of
 * each channel; share counts a bucket's pixels over the sampled total, so entries
 * always sum to the whole image rather than to the returned subset.
 * @param data - encoded image bytes.
 * @param count - maximum entries to return.
 * @param displayPath - path rendered in refusal messages.
 * @returns palette entries ordered by descending share.
 */
async function extractPalette(data: Uint8Array, count: number, displayPath: string): Promise<PaletteEntry[]> {
  const factory = await loadSharp()
  let raw: Buffer
  try {
    raw = await factory(data, SHARP_DECODE_OPTIONS)
      .resize({ width: PALETTE_GRID, height: PALETTE_GRID, fit: 'inside' })
      .removeAlpha()
      .raw()
      .toBuffer()
  } catch (error: unknown) {
    throw new Error(
      `cannot read "${displayPath}": the bytes do not decode as an image (${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    )
  }

  const shift = 8 - PALETTE_CHANNEL_BITS
  const buckets = new Map<number, { pixels: number; r: number; g: number; b: number }>()
  const sampled = raw.length / 3
  for (let offset = 0; offset + 2 < raw.length; offset += 3) {
    const r = raw[offset] as number
    const g = raw[offset + 1] as number
    const b = raw[offset + 2] as number
    const key = ((r >> shift) << (PALETTE_CHANNEL_BITS * 2)) | ((g >> shift) << PALETTE_CHANNEL_BITS) | (b >> shift)
    const bucket = buckets.get(key)
    if (bucket === undefined) buckets.set(key, { pixels: 1, r, g, b })
    else {
      bucket.pixels += 1
      bucket.r += r
      bucket.g += g
      bucket.b += b
    }
  }

  return [...buckets.values()]
    // Averaging the bucket's own pixels keeps the reported colour inside the bucket
    // instead of at the bucket's corner, which matters for gradients.
    .map(bucket => ({
      hex: `#${[bucket.r, bucket.g, bucket.b]
        .map(sum => Math.round(sum / bucket.pixels).toString(16).padStart(2, '0'))
        .join('')}`,
      share: bucket.pixels / sampled,
    }))
    .sort((left, right) => right.share - left.share || left.hex.localeCompare(right.hex))
    .slice(0, count)
}
