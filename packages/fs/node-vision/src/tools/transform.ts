/**
 * Raster transform tools: `vision_crop`, `vision_resize`, and `vision_diff`.
 *
 * Every one of them returns the result as a durable attachment beside its summary,
 * so the model inspects the pixels it just produced instead of trusting the text.
 * `ctx.fs` writes text only, so a result is never written to a caller-named path;
 * the attachment reference is how an image leaves this package.
 * @module @deepseek-ai/dsh-node-vision/src/tools/transform
 */

import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { VisionRuntime } from '../image-io.ts'
import { commitImage, encode, imageBlocks, loadImage, outputName, writeImageOutput } from '../image-io.ts'
import { SHARP_DECODE_OPTIONS, loadSharp } from '../sharp-runtime.ts'
import type { SharpFactory } from '../sharp-runtime.ts'

/** Attachment-shaped fields carried by a tool result that produced an image. */
const IMAGE_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', required: true },
    bytes: { type: 'number', required: true },
    width: { type: 'number', required: true },
    height: { type: 'number', required: true },
    name: { type: 'string' },
  },
} as const

/** The same fields where the tool always produces an image, as crop and resize do. */
const REQUIRED_IMAGE_VALUE_SCHEMA = { ...IMAGE_VALUE_SCHEMA, required: true } as const

/** One produced image as the tool result carries it. */
interface ImageValue {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

/**
 * Re-brand a result's image fields back into the attachment reference an image block carries.
 * @param image - the image fields recorded in the tool result.
 * @returns the branded durable reference.
 */
function imageRefFromValue(image: ImageValue): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId(image.attachmentId),
    mediaType: image.mediaType as ImageMediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...image.name === undefined ? {} : { name: image.name },
  }
}

/**
 * Project one attachment reference into the serializable fields a result records.
 * @param ref - durable reference returned by the attachment store.
 * @returns the fields the result schema declares.
 */
function imageValueOf(ref: ImageAttachmentRef): ImageValue {
  return {
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...ref.name === undefined ? {} : { name: ref.name },
  }
}

/**
 * Register `vision_crop`, `vision_resize`, and `vision_diff`.
 * @param ctx - plugin context, used for filesystem access and observation events.
 * @param runtime - context and attachment store shared by the tool set.
 */
export function applyTransformTools(ctx: VisionRuntime['ctx'], runtime: VisionRuntime): void {
  ctx.tools.register(defineTool({
    name: 'vision_crop',
    description: 'Crop a rectangle out of one image file and return the cropped image itself. '
      + 'Use this to zoom into a region you located, for example a detail of a screenshot or a diagram, when looking at the whole picture is not enough. '
      + 'Coordinates are pixels measured from the top-left of the file on disk, and the rectangle must fit inside the image. '
      + 'The result is returned as an image; give output_path to also save it as a file. '
      + 'Use read_image when you only need the original, and vision_resize when you need the whole frame at another size.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to the image file, resolved by the filesystem backend.' },
      left: { type: 'number', required: true, description: 'Left edge of the region in pixels, from the image\'s left edge.' },
      top: { type: 'number', required: true, description: 'Top edge of the region in pixels, from the image\'s top edge.' },
      width: { type: 'number', required: true, description: 'Region width in pixels.' },
      height: { type: 'number', required: true, description: 'Region height in pixels.' },
      output_path: { type: 'string', description: 'Optional file path to save the cropped image to, alongside returning it. The write is subject to the session\'s file permissions.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          width: { type: 'number', required: true },
          height: { type: 'number', required: true },
          sourceWidth: { type: 'number', required: true },
          sourceHeight: { type: 'number', required: true },
          writtenPath: { type: 'string' },
          writtenBytes: { type: 'number' },
          image: REQUIRED_IMAGE_VALUE_SCHEMA,
        },
      },
      render: (_args, value) => imageBlocks(
        `<path>${value.path}</path>
<type>image</type>
<content>
cropped ${value.width}x${value.height} px from ${value.sourceWidth}x${value.sourceHeight} px, returned as the attached image${savedNote(value.writtenPath, value.writtenBytes)}
</content>`,
        imageRefFromValue(value.image),
      ),
      presentationMeta: (_args, value) => ({ path: value.path }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      assertInteger('left', args.left)
      assertInteger('top', args.top)
      assertInteger('width', args.width)
      assertInteger('height', args.height)
      if (args.width < 1 || args.height < 1) throw new Error('width and height must be at least 1 pixel')
      const loaded = await loadImage(runtime, exec, args.file_path)
      assertRegionFits(loaded.displayPath, loaded.width, loaded.height, args.left, args.top, args.width, args.height)
      const factory = await loadSharp()
      const encoded = await encodeRegion(factory, loaded.data, loaded.mediaType, loaded.displayPath, {
        left: args.left,
        top: args.top,
        width: args.width,
        height: args.height,
      })
      const written = await writeIfRequested(runtime, exec, args.output_path, encoded.data)
      const ref = await commitImage(runtime, {
        data: encoded.data,
        mediaType: loaded.mediaType,
        name: outputName(loaded.displayPath, loaded.mediaType, 'crop'),
        width: encoded.width,
        height: encoded.height,
      })
      return {
        path: loaded.displayPath,
        width: encoded.width,
        height: encoded.height,
        sourceWidth: loaded.width,
        sourceHeight: loaded.height,
        ...written,
        image: imageValueOf(ref),
      }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `Crop ${args.file_path}`, kind: 'read', locations: [{ path: args.file_path }] }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vision_resize',
    description: 'Scale one image file and return the rescaled image itself. '
      + 'Use this when a picture is too large to take in, when you need two images at one size before comparing them, '
      + 'or when a detail only becomes readable at a higher magnification. Give width, height, or scale; '
      + 'giving only one of width or height preserves the aspect ratio, and scale multiplies both sides. '
      + 'The result is returned as an image; give output_path to also save it as a file. '
      + 'Use read_image when you only need the original, and vision_crop to enlarge one region instead of the whole frame.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to the image file, resolved by the filesystem backend.' },
      width: { type: 'number', description: 'Target width in pixels. With height omitted, the aspect ratio is preserved.' },
      height: { type: 'number', description: 'Target height in pixels. With width omitted, the aspect ratio is preserved.' },
      scale: { type: 'number', description: 'Multiplier applied to both sides, for example 0.5 for half size or 2 for double.' },
      output_path: { type: 'string', description: 'Optional file path to save the rescaled image to, alongside returning it. The write is subject to the session\'s file permissions.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          width: { type: 'number', required: true },
          height: { type: 'number', required: true },
          sourceWidth: { type: 'number', required: true },
          sourceHeight: { type: 'number', required: true },
          writtenPath: { type: 'string' },
          writtenBytes: { type: 'number' },
          image: REQUIRED_IMAGE_VALUE_SCHEMA,
        },
      },
      render: (_args, value) => imageBlocks(
        `<path>${value.path}</path>
<type>image</type>
<content>
rescaled from ${value.sourceWidth}x${value.sourceHeight} px to ${value.width}x${value.height} px, returned as the attached image${savedNote(value.writtenPath, value.writtenBytes)}
</content>`,
        imageRefFromValue(value.image),
      ),
      presentationMeta: (_args, value) => ({ path: value.path }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const wanted = requestedResize(args.width, args.height, args.scale)
      const loaded = await loadImage(runtime, exec, args.file_path)
      const box = resolveResizeBox(wanted, loaded.width, loaded.height)
      const factory = await loadSharp()
      let encoded: { data: Uint8Array; width: number; height: number }
      try {
        // `inside` fits the box while preserving the aspect ratio, which is what a
        // caller means by naming one side and expecting the other to follow.
        encoded = await encode(
          factory(loaded.data, SHARP_DECODE_OPTIONS).resize({ ...box, fit: 'inside' }),
          loaded.mediaType,
        )
      } catch (error: unknown) {
        throw new Error(
          `cannot resize "${loaded.displayPath}": ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        )
      }
      const written = await writeIfRequested(runtime, exec, args.output_path, encoded.data)
      const ref = await commitImage(runtime, {
        data: encoded.data,
        mediaType: loaded.mediaType,
        name: outputName(loaded.displayPath, loaded.mediaType, 'resized'),
        width: encoded.width,
        height: encoded.height,
      })
      return {
        path: loaded.displayPath,
        width: encoded.width,
        height: encoded.height,
        sourceWidth: loaded.width,
        sourceHeight: loaded.height,
        ...written,
        image: imageValueOf(ref),
      }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `Resize ${args.file_path}`, kind: 'read', locations: [{ path: args.file_path }] }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'vision_diff',
    description: 'Compare two image files pixel by pixel and report whether they differ, how many pixels differ, and the average and largest channel difference. '
      + 'Use this to check a visual change after an edit, to verify a screenshot against a baseline, or to confirm two files really are identical. '
      + 'Set visualize to also return a picture marking the differing pixels, which shows you where the change is rather than only how big it is. '
      + 'Giving output_path produces that same picture and saves it to the named file. '
      + 'When the two files have different dimensions only their overlapping region is compared, and the report says so.',
    parameters: {
      file_path: { type: 'string', required: true, description: 'Path to the first image file, resolved by the filesystem backend.' },
      against_path: { type: 'string', required: true, description: 'Path to the second image file to compare against.' },
      visualize: { type: 'boolean', description: 'Return a picture marking the differing pixels. Defaults to false.' },
      output_path: { type: 'string', description: 'Optional file path to save the difference picture to. Naming it produces the picture even when visualize is omitted. The write is subject to the session\'s file permissions.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          againstPath: { type: 'string', required: true },
          identical: { type: 'boolean', required: true },
          sameDimensions: { type: 'boolean', required: true },
          width: { type: 'number', required: true },
          height: { type: 'number', required: true },
          againstWidth: { type: 'number', required: true },
          againstHeight: { type: 'number', required: true },
          comparedPixels: { type: 'number', required: true },
          differingPixels: { type: 'number', required: true },
          differingShare: { type: 'number', required: true },
          meanChannelDelta: { type: 'number', required: true },
          maxChannelDelta: { type: 'number', required: true },
          writtenPath: { type: 'string' },
          writtenBytes: { type: 'number' },
          image: IMAGE_VALUE_SCHEMA,
        },
      },
      render: (_args, value) => {
        const sizeNote = value.sameDimensions
          ? `both ${value.width}x${value.height} px`
          : `different sizes: ${value.width}x${value.height} px against ${value.againstWidth}x${value.againstHeight} px, so only the overlapping region was compared`
        const summary = value.identical
          ? 'the compared pixels are identical'
          : `${value.differingPixels} of ${value.comparedPixels} compared pixels differ (${(value.differingShare * 100).toFixed(2)}%), `
            + `mean channel difference ${value.meanChannelDelta.toFixed(2)}, largest ${value.maxChannelDelta}`
        const text = `<path>${value.path}</path>
<against>${value.againstPath}</against>
<type>image-diff</type>
<content>
${sizeNote}; ${summary}${savedNote(value.writtenPath, value.writtenBytes)}
</content>`
        if (value.image === undefined) return [{ type: 'text', text }] satisfies ContentBlock[]
        return imageBlocks(text, imageRefFromValue(value.image))
      },
      presentationMeta: (_args, value) => ({ path: value.path }),
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const source = await loadImage(runtime, exec, args.file_path)
      const against = await loadImage(runtime, exec, args.against_path)
      const factory = await loadSharp()
      const left = await rawPixels(factory, source.data, source.displayPath)
      const right = await rawPixels(factory, against.data, against.displayPath)

      const width = Math.min(left.width, right.width)
      const height = Math.min(left.height, right.height)
      const sameDimensions = left.width === right.width && left.height === right.height
      const compared = compareOverlap(left, right, width, height)

      let image: ImageValue | undefined
      let written: { writtenPath?: string; writtenBytes?: number } = {}
      // Naming a destination is itself a request for the picture, so a caller that wants the
      // file does not have to set visualize as well.
      if (args.visualize === true || args.output_path !== undefined) {
        const highlight = renderDifference(left, right, width, height)
        // Raw input carries its own geometry, so it takes the `raw` descriptor
        // instead of the decode options encoded bytes use.
        const encoded = await encode(
          factory(highlight, { raw: { width, height, channels: 4 } }),
          'image/png',
        )
        written = await writeIfRequested(runtime, exec, args.output_path, encoded.data)
        image = imageValueOf(await commitImage(runtime, {
          data: encoded.data,
          mediaType: 'image/png',
          name: outputName(source.displayPath, 'image/png', 'diff'),
          width: encoded.width,
          height: encoded.height,
        }))
      }

      return {
        path: source.displayPath,
        againstPath: against.displayPath,
        identical: compared.differingPixels === 0 && sameDimensions,
        sameDimensions,
        width: left.width,
        height: left.height,
        againstWidth: right.width,
        againstHeight: right.height,
        comparedPixels: compared.comparedPixels,
        differingPixels: compared.differingPixels,
        differingShare: compared.differingShare,
        meanChannelDelta: compared.meanChannelDelta,
        maxChannelDelta: compared.maxChannelDelta,
        ...written,
        ...image === undefined ? {} : { image },
      }
    },
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: `Diff ${args.file_path} against ${args.against_path}`,
        kind: 'read',
        locations: [{ path: args.file_path }, { path: args.against_path }],
      }
    },
  }))
}

/** One decoded image as straight RGBA samples. */
interface RawPixels {
  readonly width: number
  readonly height: number
  readonly pixels: Uint8Array
}

/** Aggregate outcome of comparing two images over their overlapping region. */
interface Comparison {
  readonly comparedPixels: number
  readonly differingPixels: number
  readonly differingShare: number
  readonly meanChannelDelta: number
  readonly maxChannelDelta: number
}

/** A caller's resize request before the source dimensions are known. */
type ResizeRequest =
  | { readonly kind: 'box'; readonly width?: number; readonly height?: number }
  | { readonly kind: 'scale'; readonly scale: number }

function assertInteger(name: string, value: number): void {
  if (!Number.isInteger(value)) throw new Error(`${name} must be a whole number of pixels`)
}

/**
 * Describe a saved file in one clause, or nothing when no destination was requested.
 * @param writtenPath - destination the write published, when one was requested.
 * @param writtenBytes - bytes published, which is present whenever `writtenPath` is.
 * @returns a clause to append to the result summary, or an empty string.
 */
function savedNote(writtenPath: string | undefined, writtenBytes: number | undefined): string {
  if (writtenPath === undefined) return ''
  return `, and saved to ${writtenPath} (${String(writtenBytes ?? 0)} bytes)`
}

/**
 * Publish produced bytes when the caller named a destination.
 *
 * The file write runs before the attachment commit: a refused write is the outcome the
 * sandbox fence can produce, and refusing before the commit avoids leaving a durable
 * attachment that no result ever references.
 * @param runtime - context and attachment store.
 * @param exec - current tool execution.
 * @param outputPath - caller-named destination, if any.
 * @param data - encoded image bytes.
 * @returns the two result fields, or an empty object when no destination was named.
 */
async function writeIfRequested(
  runtime: VisionRuntime,
  exec: ToolExecution,
  outputPath: string | undefined,
  data: Uint8Array,
): Promise<{ writtenPath?: string; writtenBytes?: number }> {
  if (outputPath === undefined) return {}
  const written = await writeImageOutput(runtime, exec, outputPath, data)
  return { writtenPath: written.displayPath, writtenBytes: written.bytes }
}

/**
 * Refuse a crop rectangle the source cannot satisfy.
 *
 * sharp pads or shrinks an out-of-range extract instead of failing, which would return
 * an image the caller did not ask for; naming the bounds keeps the failure actionable.
 * @param displayPath - source path rendered in the message.
 * @param sourceWidth - source width in pixels.
 * @param sourceHeight - source height in pixels.
 * @param left - requested left edge.
 * @param top - requested top edge.
 * @param width - requested width.
 * @param height - requested height.
 */
function assertRegionFits(
  displayPath: string,
  sourceWidth: number,
  sourceHeight: number,
  left: number,
  top: number,
  width: number,
  height: number,
): void {
  if (left < 0 || top < 0) throw new Error('left and top must not be negative')
  if (left + width > sourceWidth || top + height > sourceHeight) {
    throw new Error(
      `the region ${String(left)},${String(top)} ${String(width)}x${String(height)} does not fit inside `
      + `"${displayPath}", which is ${String(sourceWidth)}x${String(sourceHeight)} px`,
    )
  }
}

/**
 * Validate the three resize inputs and keep the caller's intent.
 *
 * A scale is deliberately not turned into a box here: it multiplies the source's own
 * sides, which are only known after the file is read.
 * @param width - requested width, if any.
 * @param height - requested height, if any.
 * @param scale - requested multiplier, if any.
 * @returns either a pixel box or a scale factor.
 */
function requestedResize(width: number | undefined, height: number | undefined, scale: number | undefined): ResizeRequest {
  if (scale !== undefined) {
    if (width !== undefined || height !== undefined) throw new Error('give either scale or width/height, not both')
    if (!Number.isFinite(scale) || scale <= 0) throw new Error('scale must be a positive number')
    return { kind: 'scale', scale }
  }
  if (width === undefined && height === undefined) throw new Error('give width, height, or scale')
  if (width !== undefined) assertInteger('width', width)
  if (height !== undefined) assertInteger('height', height)
  if ((width !== undefined && width < 1) || (height !== undefined && height < 1)) {
    throw new Error('width and height must be at least 1 pixel')
  }
  return { kind: 'box', ...width === undefined ? {} : { width }, ...height === undefined ? {} : { height } }
}

/**
 * Turn a validated request plus the source dimensions into sharp's resize box.
 * @param request - validated caller intent.
 * @param sourceWidth - source width in pixels.
 * @param sourceHeight - source height in pixels.
 * @returns the box sharp fits the image into.
 */
function resolveResizeBox(
  request: ResizeRequest,
  sourceWidth: number,
  sourceHeight: number,
): { width?: number; height?: number } {
  if (request.kind === 'scale') {
    return {
      width: Math.max(1, Math.round(sourceWidth * request.scale)),
      height: Math.max(1, Math.round(sourceHeight * request.scale)),
    }
  }
  return {
    ...request.width === undefined ? {} : { width: request.width },
    ...request.height === undefined ? {} : { height: request.height },
  }
}

/**
 * Encode a region of one decoded image in its own format.
 * @param factory - loaded sharp entry point.
 * @param data - encoded source bytes.
 * @param mediaType - format to encode the region as.
 * @param displayPath - path rendered in refusal messages.
 * @param region - the rectangle to keep.
 * @returns encoded region bytes and their dimensions.
 */
async function encodeRegion(
  factory: SharpFactory,
  data: Uint8Array,
  mediaType: ImageMediaType,
  displayPath: string,
  region: { left: number; top: number; width: number; height: number },
): Promise<{ data: Uint8Array; width: number; height: number }> {
  try {
    return await encode(factory(data, SHARP_DECODE_OPTIONS).extract(region), mediaType)
  } catch (error: unknown) {
    throw new Error(
      `cannot crop "${displayPath}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

/**
 * Decode one image to straight RGBA samples.
 * @param factory - loaded sharp entry point.
 * @param data - encoded image bytes.
 * @param displayPath - path rendered in refusal messages.
 * @returns the decoded samples and dimensions.
 */
async function rawPixels(factory: SharpFactory, data: Uint8Array, displayPath: string): Promise<RawPixels> {
  let result: { data: Buffer; info: { width: number; height: number } }
  try {
    result = await factory(data, SHARP_DECODE_OPTIONS).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  } catch (error: unknown) {
    throw new Error(
      `cannot compare "${displayPath}": the bytes do not decode as an image (${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    )
  }
  return { width: result.info.width, height: result.info.height, pixels: result.data }
}

/**
 * Compare two decoded images over the top-left region they share.
 * @param left - first image.
 * @param right - second image.
 * @param width - overlapping width.
 * @param height - overlapping height.
 * @returns counts and deltas over the compared region only.
 */
function compareOverlap(left: RawPixels, right: RawPixels, width: number, height: number): Comparison {
  let differingPixels = 0
  let totalDelta = 0
  let maxChannelDelta = 0
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const leftOffset = (y * left.width + x) * 4
      const rightOffset = (y * right.width + x) * 4
      let pixelDiffers = false
      for (let channel = 0; channel < 4; channel += 1) {
        const delta = Math.abs((left.pixels[leftOffset + channel] as number) - (right.pixels[rightOffset + channel] as number))
        if (delta === 0) continue
        pixelDiffers = true
        totalDelta += delta
        if (delta > maxChannelDelta) maxChannelDelta = delta
      }
      if (pixelDiffers) differingPixels += 1
    }
  }
  const comparedPixels = width * height
  return {
    comparedPixels,
    differingPixels,
    differingShare: comparedPixels === 0 ? 0 : differingPixels / comparedPixels,
    meanChannelDelta: comparedPixels === 0 ? 0 : totalDelta / (comparedPixels * 4),
    maxChannelDelta,
  }
}

/**
 * Build a picture marking where two images differ.
 *
 * Unchanged pixels are dimmed grayscale so the changed ones carry the contrast, which
 * keeps a one-pixel change visible instead of leaving a nearly black frame.
 * @param left - first image.
 * @param right - second image.
 * @param width - overlapping width.
 * @param height - overlapping height.
 * @returns raw RGBA pixels of the difference picture.
 */
function renderDifference(left: RawPixels, right: RawPixels, width: number, height: number): Uint8Array {
  const output = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const leftOffset = (y * left.width + x) * 4
      const rightOffset = (y * right.width + x) * 4
      const target = (y * width + x) * 4
      let delta = 0
      for (let channel = 0; channel < 4; channel += 1) {
        delta = Math.max(delta, Math.abs((left.pixels[leftOffset + channel] as number) - (right.pixels[rightOffset + channel] as number)))
      }
      if (delta === 0) {
        const average = ((left.pixels[leftOffset] as number) + (left.pixels[leftOffset + 1] as number) + (left.pixels[leftOffset + 2] as number)) / 3
        const gray = Math.round(average / 4)
        output[target] = gray
        output[target + 1] = gray
        output[target + 2] = gray
        output[target + 3] = 255
        continue
      }
      output[target] = 255
      output[target + 1] = 0
      output[target + 2] = 0
      output[target + 3] = 255
    }
  }
  return output
}
