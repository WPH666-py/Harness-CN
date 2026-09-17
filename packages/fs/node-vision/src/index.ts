/**
 * Node-native image inspection and pixel-operation tools over `sharp`.
 *
 * This package answers "what is in this image, and how do I change those pixels"
 * without a Python runtime and without an external vision provider: the model
 * performs the understanding itself, and every tool that produces pixels returns
 * them as an image block so the model inspects what it just made.
 *
 * It complements `read_image` rather than replacing it. `read_image` shows the model
 * a picture; these tools measure and transform one. Both apply the same route gate,
 * so a model that cannot accept image input is refused identically.
 * @module @deepseek-ai/dsh-node-vision
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-fs'
import { applyInspectTools } from './tools/inspect.ts'
import { applyTransformTools } from './tools/transform.ts'
import type { VisionRuntime } from './image-io.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'node-vision'

/** Services required by the vision tool suite. */
export const inject = ['tools', 'fs']

/**
 * Register the vision tools.
 *
 * The whole set is composition-conditional on `attachments`: every producing tool
 * hands its result back as a durable image, so without a store that can commit image
 * bytes the tools cannot do their job and never register. The mounted `fs` service
 * owns path resolution and reads, and the optional `llm` service answers the route
 * gate, which each execution re-reads so a mid-session model switch is honoured.
 * @param ctx - the plugin context providing `tools` and `fs`.
 */
export function apply(ctx: Context): void {
  ctx.inject(['attachments'], (imageCtx) => {
    const runtime: VisionRuntime = { ctx: imageCtx, attachments: imageCtx.attachments }
    applyInspectTools(imageCtx, runtime)
    applyTransformTools(imageCtx, runtime)
  })
}
