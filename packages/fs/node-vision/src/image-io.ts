/**
 * Filesystem reads, sharp pipelines, and durable image commits shared by every
 * node-vision tool.
 *
 * Images are persisted through the attachment store so the model can inspect them:
 * the attachment reference a tool returns is how an image reaches the conversation.
 * A caller that also wants the result as a file names `output_path`, which publishes
 * the same bytes through `ctx.fs.writeBytes` and therefore passes the same sandbox
 * fence a text write does. The route gate and the
 * regular-file resolution are `read_image`'s, so a model that cannot see images is
 * refused identically by both tools.
 * @module @deepseek-ai/dsh-node-vision/src/image-io
 */

import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { assertImageCapableRoute, resolveRegularReadTarget, sessionResolveOptions } from '@deepseek-ai/dsh-tool-fs'
import type { Sharp } from 'sharp'
import { SHARP_DECODE_OPTIONS, loadSharp } from './sharp-runtime.ts'
import type { SharpFactory } from './sharp-runtime.ts'

/** Media types the attachment store accepts, keyed by the format sharp reports. */
const ACCEPTED_MEDIA_TYPES: Readonly<Record<string, ImageMediaType>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
}

/** Services every node-vision tool execution needs. */
export interface VisionRuntime {
  /** Plugin context owning `fs`, the optional `llm`, and observation events. */
  readonly ctx: Context
  /** Durable image store; the composition mounts this tool set only with one present. */
  readonly attachments: AttachmentStore
}

/** One image read through the mounted filesystem backend. */
export interface LoadedImage {
  /** Backend-resolved display path used in every model-facing message. */
  readonly displayPath: string
  /** Encoded bytes exactly as stored on disk. */
  readonly data: Uint8Array
  /** Media type the attachment store accepts for these bytes. */
  readonly mediaType: ImageMediaType
  /** Decoded dimensions, available without a second decode. */
  readonly width: number
  readonly height: number
}

/** One freshly produced raster awaiting a durable commit. */
export interface ProducedImage {
  readonly data: Uint8Array
  readonly mediaType: ImageMediaType
  readonly name: string
  readonly width: number
  readonly height: number
}

/**
 * Assert a non-empty path, then read it as an image the calling route can inspect.
 *
 * Both gates run before any filesystem I/O, so a refusal never performs a read.
 * @param runtime - context and attachment store.
 * @param exec - current tool execution carrying the calling route and cancellation.
 * @param filePath - model-supplied path.
 * @returns the display path, encoded bytes, media type, and decoded dimensions.
 * @throws {Error} when the path is empty, the route cannot inspect images, the path is not a regular file, or the bytes are not an accepted image.
 */
export async function loadImage(
  runtime: VisionRuntime,
  exec: ToolExecution,
  filePath: string,
): Promise<LoadedImage> {
  if (filePath.trim().length === 0) throw new Error('file_path must be a non-empty string')
  await assertImageCapableRoute(runtime.ctx, exec, filePath)
  const { target, info } = await resolveRegularReadTarget(runtime.ctx, exec, filePath)
  const byteCap = Math.min(
    runtime.attachments.imageLimits.maxImageBytes,
    runtime.attachments.imageLimits.maxMessageImageBytes,
  )
  const data = await runtime.ctx.fs.readBytes(target, exec.signal, byteCap)
  const factory = await loadSharp()
  const decoded = await decodeDimensions(factory, data, target.displayPath)
  runtime.ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
  return {
    displayPath: target.displayPath,
    data,
    mediaType: decoded.mediaType,
    width: decoded.width,
    height: decoded.height,
  }
}

/**
 * Decode one image's dimensions and map its format onto an accepted media type.
 * @param factory - loaded sharp entry point.
 * @param data - encoded image bytes.
 * @param displayPath - path rendered in refusal messages.
 * @returns decoded dimensions and the accepted media type.
 * @throws {Error} when sharp cannot decode the bytes or the format is not one the attachment store accepts.
 */
export async function decodeDimensions(
  factory: SharpFactory,
  data: Uint8Array,
  displayPath: string,
): Promise<{ width: number; height: number; mediaType: ImageMediaType }> {
  let metadata: Awaited<ReturnType<Sharp['metadata']>>
  try {
    metadata = await factory(data, SHARP_DECODE_OPTIONS).metadata()
  } catch (error: unknown) {
    throw new Error(
      `cannot use "${displayPath}": the bytes do not decode as an image (${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    )
  }
  const mediaType = metadata.format === undefined ? undefined : ACCEPTED_MEDIA_TYPES[metadata.format]
  if (mediaType === undefined) {
    throw new Error(
      `cannot use "${displayPath}": ${metadata.format ?? 'the detected'} images are not accepted here; use PNG, JPEG, WebP, or GIF`,
    )
  }
  if (metadata.width === undefined || metadata.height === undefined) {
    throw new Error(`cannot use "${displayPath}": the image decoded without usable dimensions`)
  }
  return { width: metadata.width, height: metadata.height, mediaType }
}

/**
 * Encode one pipeline in the requested accepted format.
 *
 * A sharp pipeline is single-use, so this is the only read of it: the encoded bytes
 * and the dimensions they actually carry come back together.
 * @param pipeline - sharp pipeline carrying the transformed pixels.
 * @param mediaType - accepted media type to encode as.
 * @returns encoded bytes plus the output width and height.
 */
export async function encode(
  pipeline: Sharp,
  mediaType: ImageMediaType,
): Promise<{ data: Uint8Array; width: number; height: number }> {
  const encoded = mediaType === 'image/png'
    ? await pipeline.png().toBuffer({ resolveWithObject: true })
    : mediaType === 'image/jpeg'
      ? await pipeline.jpeg({ quality: 90 }).toBuffer({ resolveWithObject: true })
      : mediaType === 'image/webp'
        ? await pipeline.webp({ quality: 90 }).toBuffer({ resolveWithObject: true })
        : await pipeline.gif().toBuffer({ resolveWithObject: true })
  const { data, info } = encoded
  return {
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    width: info.width,
    height: info.height,
  }
}

/**
 * Commit produced pixels to the durable attachment store.
 *
 * Persisting before the tool returns means the image block references an object the
 * store already owns by the time the result event is appended.
 * @param runtime - context and attachment store.
 * @param produced - encoded pixels, format, display name, and dimensions.
 * @returns the durable reference the image block carries.
 * @throws {Error} when the deployment's image limits refuse the result, naming the limit that applied.
 */
export async function commitImage(
  runtime: VisionRuntime,
  produced: ProducedImage,
): Promise<ImageAttachmentRef> {
  try {
    return await runtime.attachments.saveImage({
      data: produced.data,
      mediaType: produced.mediaType,
      name: produced.name,
    })
  } catch (error: unknown) {
    if (!(error instanceof AttachmentError)) throw error
    const limits = runtime.attachments.imageLimits
    if (error.code === 'IMAGE_DIMENSION_TOO_LARGE') {
      throw new Error(
        `the result is ${produced.width}x${produced.height} px, and at least one side exceeds the deployment's `
        + `${limits.maxImageDimension}px limit; request a smaller output`,
        { cause: error },
      )
    }
    if (error.code === 'IMAGE_TOO_MANY_PIXELS') {
      throw new Error(
        `the result exceeds the deployment's ${limits.maxImagePixels}-pixel decoded-size limit; request a smaller output`,
        { cause: error },
      )
    }
    if (error.code === 'IMAGE_TOO_LARGE') {
      throw new Error(
        "the result cannot be stored within the deployment's byte limits; request a smaller output",
        { cause: error },
      )
    }
    throw error
  }
}

/**
 * Build the two content blocks one produced image is reported with.
 * @param text - model-facing summary of the operation and its result.
 * @param ref - durable reference returned by the attachment store.
 * @returns the summary block followed by the image block.
 */
export function imageBlocks(text: string, ref: ImageAttachmentRef): ContentBlock[] {
  return [
    { type: 'text', text },
    { type: 'image', attachment: ref },
  ]
}

/**
 * Name one produced image after the file it came from, keeping the output format's extension.
 * @param displayPath - source path the operation read.
 * @param mediaType - format the result was encoded as.
 * @param suffix - operation marker distinguishing related outputs.
 * @returns a path-free display name for the attachment store.
 */
export function outputName(displayPath: string, mediaType: ImageMediaType, suffix: string): string {
  const extension = mediaType === 'image/jpeg' ? '.jpg' : mediaType === 'image/webp' ? '.webp' : mediaType === 'image/gif' ? '.gif' : '.png'
  const stem = basename(displayPath).replace(/\.[^.]*$/u, '')
  return `${stem === '' ? 'image' : stem}-${suffix}${extension}`
}

/** One produced image published to a caller-named path. */
export interface WrittenImage {
  /** Backend-resolved display path of the file the write created or replaced. */
  readonly displayPath: string
  /** Bytes published. */
  readonly bytes: number
}

/**
 * Publish produced image bytes to a caller-named path through `ctx.fs`.
 *
 * The tool result already carries the image as an attachment, so this exists for callers
 * that also need the result as a file. The bytes travel `ctx.fs.writeBytes`, the same seam
 * `write` uses, so the mounted backend fences them: `fs-sandbox` resolves the session's own
 * policy when no per-call one is supplied, which means a read-only session refuses this
 * write rather than letting it through. The one difference from `write` is the absence of a
 * `sandbox_permissions` parameter, so a caller cannot request an escalation here and the
 * session's own mode is what applies.
 * @param runtime - context and attachment store.
 * @param exec - current tool execution carrying the session cwd and cancellation.
 * @param outputPath - caller-named destination.
 * @param data - encoded image bytes.
 * @returns the resolved display path and the byte count published.
 * @throws {Error} when the path is empty or the backend refuses the write.
 */
export async function writeImageOutput(
  runtime: VisionRuntime,
  exec: ToolExecution,
  outputPath: string,
  data: Uint8Array,
): Promise<WrittenImage> {
  if (outputPath.trim().length === 0) throw new Error('output_path must be a non-empty string')
  const target = await runtime.ctx.fs.resolve(outputPath, sessionResolveOptions(exec, outputPath))
  const outcome = await runtime.ctx.fs.writeBytes(target, data, undefined, exec.signal)
  // Publishing the observation is what lets the read-before-write policy see this file at
  // the version the write produced, exactly as the `write` tool does after its own write.
  runtime.ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
  return { displayPath: target.displayPath, bytes: outcome.bytes }
}
