# @deepseek-ai/dsh-node-vision

Model-facing image inspection and pixel operations over [sharp](https://sharp.pixelplumbing.com/), with no Python runtime and no external vision provider.

The model does the understanding itself: `read_image` shows it a picture, and these tools measure and transform one. Every tool that produces pixels returns them as an `image` content block, so the model inspects what it just produced instead of trusting a summary.

## Tools

| Tool | Produces | Purpose |
|---|---|---|
| `vision_info` | text | Dimensions, format, byte size, channels, alpha, colour space. |
| `vision_crop` | image | Keep one rectangle; the rectangle must fit inside the source. |
| `vision_resize` | image | Scale by width, height, or a multiplier; one given side preserves the aspect ratio. |
| `vision_colors` | text | Dominant colours as hex values with the share of pixels each covers. |
| `vision_diff` | text, optional image | Pixel comparison with counts and deltas; `visualize` returns a picture marking the changed pixels. |

Every producing tool also accepts `output_path` and saves the same bytes to that file, through `ctx.fs.writeBytes`, so the mounted backend fences the write exactly as it fences a text write.

Coordinates are pixels measured from the top-left of the file on disk. Results are encoded in the source's own format when the attachment store accepts it, so a JPEG crop stays a JPEG.

## Model Experience

Each call adds one tool result. A producing call carries a short summary plus one image, so it costs the pixels of its output rather than of its input. `vision_info` and `vision_colors` add text only.

No tool echoes image bytes into the transcript, and none of them re-reads the source image into the model's context, so a sequence of pixel operations does not accumulate pictures of the original. The image a producing tool attaches is the operation's result at the size the caller asked for; `vision_resize` is the way to shrink a large result before a later step reads it.

Prompt cacheability is unaffected: the package contributes no prompt sections and no system-prompt text.

## Requirements

- The current model route must declare `image` input. Every execution resolves the calling session's routed provider and model and refuses with a named error otherwise, so the failure is visible rather than silent.
- A mounted `attachments` service. The tools never register without one, because a produced image has nowhere durable to live.

## Known Limitations and Deferred Work

- **A writing call has no `sandbox_permissions` parameter.** `output_path` travels `ctx.fs.writeBytes`, and `fs-sandbox` resolves the session's own policy when no per-call one is supplied, so a read-only session refuses the write. What the tools do not offer is the per-call escalation the `write` tool exposes, so a caller that needs to write outside the workspace must change the session's mode rather than stamp one call.
- **`vision_diff` compares alpha as a fourth channel.** A transparency-only change is reported as a difference, which is usually wanted but is not configurable.
- **Different-sized images are compared over their top-left overlap.** The report names both sizes and says the comparison was partial, so the result is never silently partial; refusing instead would leave "do they differ" unanswered.
- **No rotation, compositing, format conversion, or vector tracing.** Cropping, scaling, palette extraction, and pixel comparison cover the operations a model needs to inspect and adjust an image; the rest belong to a caller with a concrete need.
