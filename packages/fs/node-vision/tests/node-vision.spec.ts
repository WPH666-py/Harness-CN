/**
 * The node-vision tools over the REAL local filesystem, attachment store, and sharp:
 * inspection, cropping, rescaling, palette extraction, pixel comparison, the
 * image-modality gate every producing tool applies, and the refusals a caller can
 * actually hit. Fixtures are real images sharp writes to disk, so no decode is faked.
 *
 * A tool refusal is a successful execution carrying an error result, which is the
 * registry's contract, so refusals are asserted on the result rather than as throws.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { LlmAdapter, LlmRuntime, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import type {} from '@deepseek-ai/dsh-attachment'
import * as NodeVision from '../src/index.ts'

/** Exact-route fake adapter; `stream` is unreachable because no test generates. */
class CatalogAdapter extends LlmAdapter {
  constructor(private readonly models: LlmModelInfo[]) {
    super()
  }

  override listModels(_provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.models)
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const resolved = this.models.find(candidate => candidate.id === model)
    return Promise.resolve({
      provider,
      id: model,
      name: resolved?.name ?? model,
      ...resolved?.inputModalities === undefined ? {} : { inputModalities: [...resolved.inputModalities] },
    })
  }

  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('node-vision tests never stream')
  }
}

const MODELS: LlmModelInfo[] = [
  { provider: 'visual', id: 'vision-model', name: 'Vision', inputModalities: ['text', 'image'] },
  { provider: 'visual', id: 'text-model', name: 'Text', inputModalities: ['text'] },
]

const testToolSignal = new AbortController().signal

let dir: string
let home: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-node-vision-'))
  home = await mkdtemp(join(tmpdir(), 'dsh-node-vision-home-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(home, { recursive: true, force: true })
})

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  await ctx.plugin(LocalFileSystem, { cwd: dir })
  await ctx.plugin(FsPolicy)
  await ctx.plugin(LocalAttachmentStore, { dshHome: home })
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['visual'], new CatalogAdapter(MODELS))
  await ctx.plugin(NodeVision)
  return ctx
}

/** A fake calling agent pinned to one routed provider/model. */
function agentOn(model: string | undefined, provider = 'visual'): object {
  return {
    options: {},
    session: {
      header: { cwd: dir },
      requestHeader: () => (model === undefined ? undefined : { config: { provider, model } }),
      deriveMessages: () => [],
      append: () => undefined,
    },
  }
}

let callCounter = 0
function call(ctx: Context, name: string, args: unknown, agent?: object) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`nv-call-${++callCounter}`),
    name,
    arguments: args,
    ...agent ? { agent: agent as never } : {},
  })
}

interface ResultBlock {
  readonly type: string
  readonly text?: string
  readonly attachment?: {
    readonly width: number
    readonly height: number
    readonly mediaType: string
    readonly bytes: number
  }
}

type CallResult = Awaited<ReturnType<typeof call>>

function text(result: CallResult): string {
  return (result.content as ResultBlock[]).filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

function image(result: CallResult): ResultBlock['attachment'] {
  return (result.content as ResultBlock[]).find(block => block.type === 'image')?.attachment
}

/**
 * Run a tool expected to refuse and return its model-facing message.
 * @param ctx - composed context.
 * @param name - tool to invoke.
 * @param args - tool arguments.
 * @param agent - calling agent whose route the gate reads.
 * @returns the refusal text.
 */
async function refusal(ctx: Context, name: string, args: unknown, agent?: object): Promise<string> {
  const result = await call(ctx, name, args, agent)
  expect(result.isError).toBe(true)
  return text(result)
}

/** Write a solid-colour PNG and return its path. */
async function solidPng(
  name: string,
  width: number,
  height: number,
  colour: { r: number; g: number; b: number },
): Promise<string> {
  const path = join(dir, name)
  await sharp({ create: { width, height, channels: 3, background: colour } }).png().toFile(path)
  return path
}

/** Write a PNG whose left half is one colour and right half another. */
async function twoTonePng(
  name: string,
  size: number,
  left: [number, number, number],
  right: [number, number, number],
): Promise<string> {
  const path = join(dir, name)
  const pixels = Buffer.alloc(size * size * 3)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const source = x < size / 2 ? left : right
      const offset = (y * size + x) * 3
      pixels[offset] = source[0]
      pixels[offset + 1] = source[1]
      pixels[offset + 2] = source[2]
    }
  }
  await sharp(pixels, { raw: { width: size, height: size, channels: 3 } }).png().toFile(path)
  return path
}

describe('vision_info', () => {
  it('reports one image\'s geometry, format, and size as text only', async () => {
    const ctx = await setup()
    const path = await solidPng('plain.png', 8, 6, { r: 10, g: 20, b: 30 })
    const result = await call(ctx, 'vision_info', { file_path: path }, agentOn('vision-model'))
    expect(result.isError).toBe(false)
    expect((result.content as ResultBlock[]).every(block => block.type === 'text')).toBe(true)
    const body = text(result)
    expect(body).toContain('8x6 px')
    expect(body).toContain('png image')
    expect(body).toContain('3 channels')
    expect(body).toContain('alpha no')
  })

  it('refuses a route whose model does not declare image input', async () => {
    const ctx = await setup()
    const path = await solidPng('plain.png', 4, 4, { r: 0, g: 0, b: 0 })
    expect(await refusal(ctx, 'vision_info', { file_path: path }, agentOn('text-model')))
      .toMatch(/does not declare image input/u)
  })

  it('refuses a route it cannot resolve at all', async () => {
    const ctx = await setup()
    const path = await solidPng('plain.png', 4, 4, { r: 0, g: 0, b: 0 })
    expect(await refusal(ctx, 'vision_info', { file_path: path }, agentOn(undefined)))
      .toMatch(/model route could not be resolved/u)
  })

  it('refuses a format the attachment store does not accept', async () => {
    const ctx = await setup()
    const path = join(dir, 'plain.tiff')
    await sharp({ create: { width: 4, height: 4, channels: 3, background: { r: 1, g: 2, b: 3 } } }).tiff().toFile(path)
    expect(await refusal(ctx, 'vision_info', { file_path: path }, agentOn('vision-model')))
      .toMatch(/not accepted here; use PNG, JPEG, WebP, or GIF/u)
  })

  it('refuses an empty path', async () => {
    const ctx = await setup()
    expect(await refusal(ctx, 'vision_info', { file_path: '   ' }, agentOn('vision-model')))
      .toMatch(/file_path must be a non-empty string/u)
  })
})

describe('vision_crop', () => {
  it('returns the cropped pixels as an image beside its summary', async () => {
    const ctx = await setup()
    const path = await solidPng('source.png', 12, 10, { r: 200, g: 100, b: 50 })
    const result = await call(ctx, 'vision_crop', {
      file_path: path, left: 2, top: 3, width: 5, height: 4,
    }, agentOn('vision-model'))
    expect(result.isError).toBe(false)
    expect(text(result)).toContain('cropped 5x4 px from 12x10 px')
    const attachment = image(result)
    expect(attachment?.width).toBe(5)
    expect(attachment?.height).toBe(4)
    expect(attachment?.mediaType).toBe('image/png')
    expect(attachment?.bytes).toBeGreaterThan(0)
  })

  it('refuses a region that does not fit inside the source', async () => {
    const ctx = await setup()
    const path = await solidPng('source.png', 8, 8, { r: 0, g: 0, b: 0 })
    expect(await refusal(ctx, 'vision_crop', {
      file_path: path, left: 4, top: 4, width: 8, height: 8,
    }, agentOn('vision-model'))).toMatch(/does not fit inside/u)
  })

  it('refuses a negative origin', async () => {
    const ctx = await setup()
    const path = await solidPng('source.png', 8, 8, { r: 0, g: 0, b: 0 })
    expect(await refusal(ctx, 'vision_crop', {
      file_path: path, left: -1, top: 0, width: 2, height: 2,
    }, agentOn('vision-model'))).toMatch(/must not be negative/u)
  })

  it('refuses a non-integer edge', async () => {
    const ctx = await setup()
    const path = await solidPng('source.png', 8, 8, { r: 0, g: 0, b: 0 })
    expect(await refusal(ctx, 'vision_crop', {
      file_path: path, left: 1.5, top: 0, width: 2, height: 2,
    }, agentOn('vision-model'))).toMatch(/left must be a whole number of pixels/u)
  })
})

describe('vision_resize', () => {
  it('preserves the aspect ratio when only one side is given', async () => {
    const ctx = await setup()
    const path = await solidPng('source.png', 40, 20, { r: 0, g: 0, b: 0 })
    const result = await call(ctx, 'vision_resize', { file_path: path, width: 20 }, agentOn('vision-model'))
    const attachment = image(result)
    expect(attachment?.width).toBe(20)
    expect(attachment?.height).toBe(10)
    expect(text(result)).toContain('rescaled from 40x20 px to 20x10 px')
  })

  it('applies a scale to both sides', async () => {
    const ctx = await setup()
    const path = await solidPng('source.png', 30, 20, { r: 0, g: 0, b: 0 })
    const result = await call(ctx, 'vision_resize', { file_path: path, scale: 0.5 }, agentOn('vision-model'))
    const attachment = image(result)
    expect(attachment?.width).toBe(15)
    expect(attachment?.height).toBe(10)
  })

  it('refuses scale combined with an explicit side', async () => {
    const ctx = await setup()
    const path = await solidPng('source.png', 10, 10, { r: 0, g: 0, b: 0 })
    expect(await refusal(ctx, 'vision_resize', { file_path: path, width: 5, scale: 2 }, agentOn('vision-model')))
      .toMatch(/either scale or width\/height, not both/u)
  })

  it('refuses a request naming no target size', async () => {
    const ctx = await setup()
    const path = await solidPng('source.png', 10, 10, { r: 0, g: 0, b: 0 })
    expect(await refusal(ctx, 'vision_resize', { file_path: path }, agentOn('vision-model')))
      .toMatch(/give width, height, or scale/u)
  })

  it('refuses a non-positive scale', async () => {
    const ctx = await setup()
    const path = await solidPng('source.png', 10, 10, { r: 0, g: 0, b: 0 })
    expect(await refusal(ctx, 'vision_resize', { file_path: path, scale: 0 }, agentOn('vision-model')))
      .toMatch(/scale must be a positive number/u)
  })
})

describe('vision_colors', () => {
  it('reports the dominant colours of a two-colour image with their shares', async () => {
    const ctx = await setup()
    const path = await twoTonePng('two.png', 16, [255, 0, 0], [0, 0, 255])
    const result = await call(ctx, 'vision_colors', { file_path: path, count: 4 }, agentOn('vision-model'))
    expect(result.isError).toBe(false)
    expect(result.content.every(block => block.type === 'text')).toBe(true)
    const body = text(result)
    expect(body).toContain('#ff0000')
    expect(body).toContain('#0000ff')
    const shares = [...body.matchAll(/(\d+\.\d+)%/gu)].map(match => Number(match[1]))
    expect(shares.length).toBeGreaterThanOrEqual(2)
    // Only the returned entries are counted, and interpolation along the two-tone
    // boundary leaves pixels in buckets this request did not ask for, so the shares
    // cover most of the image rather than exactly all of it.
    expect(shares.reduce((total, share) => total + share, 0)).toBeGreaterThan(90)
    expect(shares.reduce((total, share) => total + share, 0)).toBeLessThanOrEqual(100.01)
  })

  it('honours a smaller requested count', async () => {
    const ctx = await setup()
    const path = await twoTonePng('two.png', 16, [10, 10, 10], [240, 240, 240])
    const result = await call(ctx, 'vision_colors', { file_path: path, count: 1 }, agentOn('vision-model'))
    const lines = text(result).split('\n').filter(line => line.includes('#'))
    expect(lines).toHaveLength(1)
  })

  it('refuses a count beyond the ceiling', async () => {
    const ctx = await setup()
    const path = await twoTonePng('two.png', 8, [10, 10, 10], [240, 240, 240])
    expect(await refusal(ctx, 'vision_colors', { file_path: path, count: 999 }, agentOn('vision-model')))
      .toMatch(/at most 64/u)
  })

  it('refuses a non-positive count', async () => {
    const ctx = await setup()
    const path = await twoTonePng('two.png', 8, [10, 10, 10], [240, 240, 240])
    expect(await refusal(ctx, 'vision_colors', { file_path: path, count: 0 }, agentOn('vision-model')))
      .toMatch(/count must be a positive integer/u)
  })
})

describe('vision_diff', () => {
  it('reports identical pixels for the same picture written twice, with no image', async () => {
    const ctx = await setup()
    const first = await solidPng('a.png', 10, 10, { r: 7, g: 8, b: 9 })
    const second = await solidPng('b.png', 10, 10, { r: 7, g: 8, b: 9 })
    const result = await call(ctx, 'vision_diff', { file_path: first, against_path: second }, agentOn('vision-model'))
    const body = text(result)
    expect(body).toContain('both 10x10 px')
    expect(body).toContain('identical')
    expect(image(result)).toBeUndefined()
  })

  it('counts the differing pixels and reports the largest channel delta', async () => {
    const ctx = await setup()
    const first = await twoTonePng('a.png', 8, [255, 255, 255], [0, 0, 0])
    const second = await twoTonePng('b.png', 8, [255, 255, 255], [255, 255, 255])
    const result = await call(ctx, 'vision_diff', { file_path: first, against_path: second }, agentOn('vision-model'))
    const body = text(result)
    expect(body).toContain('32 of 64 compared pixels differ')
    expect(body).toContain('largest 255')
  })

  it('returns a difference picture when visualize is set', async () => {
    const ctx = await setup()
    const first = await solidPng('a.png', 6, 6, { r: 0, g: 0, b: 0 })
    const second = await solidPng('b.png', 6, 6, { r: 255, g: 255, b: 255 })
    const result = await call(ctx, 'vision_diff', {
      file_path: first, against_path: second, visualize: true,
    }, agentOn('vision-model'))
    const attachment = image(result)
    expect(attachment?.width).toBe(6)
    expect(attachment?.height).toBe(6)
    expect(attachment?.mediaType).toBe('image/png')
  })

  it('compares only the overlap of two differently sized images and says so', async () => {
    const ctx = await setup()
    const source = await solidPng('source.png', 8, 8, { r: 255, g: 0, b: 0 })
    const taller = join(dir, 'taller.png')
    await sharp(source).resize({ width: 8, height: 12, fit: 'fill' }).png().toFile(taller)
    const result = await call(ctx, 'vision_diff', { file_path: source, against_path: taller }, agentOn('vision-model'))
    const body = text(result)
    expect(body).toContain('different sizes: 8x8 px against 8x12 px')
    expect(body).toContain('only the overlapping region was compared')
  })

  it('refuses when one side is not an image at all', async () => {
    const ctx = await setup()
    const good = await solidPng('a.png', 4, 4, { r: 1, g: 2, b: 3 })
    const bad = join(dir, 'notes.png')
    await writeFile(bad, 'this file is plain text, not an image')
    expect(await refusal(ctx, 'vision_diff', { file_path: good, against_path: bad }, agentOn('vision-model')))
      .toMatch(/do not decode as an image/u)
  })
})

describe('output_path', () => {
  it('saves a cropped image and names the file in its summary', async () => {
    const ctx = await setup()
    const source = await solidPng('source.png', 12, 10, { r: 200, g: 100, b: 50 })
    const destination = join(dir, 'crop.png')
    const result = await call(ctx, 'vision_crop', {
      file_path: source, left: 2, top: 3, width: 5, height: 4, output_path: destination,
    }, agentOn('vision-model'))
    expect(result.isError).toBe(false)
    const written = await readFile(destination)
    const metadata = await sharp(written).metadata()
    expect(metadata.width).toBe(5)
    expect(metadata.height).toBe(4)
    expect(text(result)).toContain(`saved to ${destination} (${written.byteLength} bytes)`)
    // The file and the attached image are the same encoding, so their byte counts agree.
    expect(image(result)?.bytes).toBe(written.byteLength)
  })

  it('saves a rescaled image', async () => {
    const ctx = await setup()
    const source = await solidPng('source.png', 40, 20, { r: 0, g: 0, b: 0 })
    const destination = join(dir, 'small.png')
    const result = await call(ctx, 'vision_resize', {
      file_path: source, scale: 0.5, output_path: destination,
    }, agentOn('vision-model'))
    expect(result.isError).toBe(false)
    expect(text(result)).toContain(`saved to ${destination}`)
    const metadata = await sharp(await readFile(destination)).metadata()
    expect(metadata.width).toBe(20)
    expect(metadata.height).toBe(10)
  })

  it('produces and saves the difference picture from output_path alone', async () => {
    const ctx = await setup()
    const first = await solidPng('a.png', 6, 6, { r: 0, g: 0, b: 0 })
    const second = await solidPng('b.png', 6, 6, { r: 255, g: 255, b: 255 })
    const destination = join(dir, 'diff.png')
    const result = await call(ctx, 'vision_diff', {
      file_path: first, against_path: second, output_path: destination,
    }, agentOn('vision-model'))
    expect(result.isError).toBe(false)
    expect(text(result)).toContain(`saved to ${destination}`)
    // Naming a destination is itself a request for the picture, so visualize was not needed.
    expect(image(result)?.width).toBe(6)
    expect((await sharp(await readFile(destination)).metadata()).width).toBe(6)
  })

  it('overwrites an existing destination', async () => {
    const ctx = await setup()
    const source = await solidPng('source.png', 8, 8, { r: 0, g: 0, b: 0 })
    const destination = join(dir, 'existing.png')
    await writeFile(destination, 'not an image')
    const result = await call(ctx, 'vision_crop', {
      file_path: source, left: 0, top: 0, width: 2, height: 2, output_path: destination,
    }, agentOn('vision-model'))
    expect(result.isError).toBe(false)
    expect((await sharp(await readFile(destination)).metadata()).width).toBe(2)
  })

  it('publishes the written version as an observation', async () => {
    // The read-before-write policy reads `fs/observed`; a producing tool that skipped this
    // emit would leave the file invisible to the policy that guards the next mutation.
    const ctx = await setup()
    const source = await solidPng('source.png', 8, 8, { r: 0, g: 0, b: 0 })
    const destination = join(dir, 'observed.png')
    const observed: { path: string; kind: string }[] = []
    ctx.on('fs/observed', (target: { displayPath: string }, observation: { kind: string }) => {
      observed.push({ path: target.displayPath, kind: observation.kind })
    })
    await call(ctx, 'vision_crop', {
      file_path: source, left: 0, top: 0, width: 2, height: 2, output_path: destination,
    }, agentOn('vision-model'))
    expect(observed.some(entry => entry.path === destination && entry.kind === 'present')).toBe(true)
  })

  it('leaves the result text-only when diff is given neither visualize nor output_path', async () => {
    const ctx = await setup()
    const first = await solidPng('a.png', 4, 4, { r: 1, g: 1, b: 1 })
    const second = await solidPng('b.png', 4, 4, { r: 1, g: 1, b: 1 })
    const result = await call(ctx, 'vision_diff', { file_path: first, against_path: second }, agentOn('vision-model'))
    expect(image(result)).toBeUndefined()
    expect(text(result)).not.toContain('saved to')
  })

  it('refuses a blank output_path', async () => {
    const ctx = await setup()
    const source = await solidPng('source.png', 8, 8, { r: 0, g: 0, b: 0 })
    expect(await refusal(ctx, 'vision_crop', {
      file_path: source, left: 0, top: 0, width: 2, height: 2, output_path: '   ',
    }, agentOn('vision-model'))).toMatch(/output_path must be a non-empty string/u)
  })

  it('refuses a destination the model cannot see images through, before writing it', async () => {
    const ctx = await setup()
    const source = await solidPng('source.png', 8, 8, { r: 0, g: 0, b: 0 })
    const destination = join(dir, 'unwritten.png')
    expect(await refusal(ctx, 'vision_crop', {
      file_path: source, left: 0, top: 0, width: 2, height: 2, output_path: destination,
    }, agentOn('text-model'))).toMatch(/does not declare image input/u)
    // The route gate runs before the read, so the producing path never reached the write.
    await expect(readFile(destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
