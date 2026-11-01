/**
 * Product identity for this build.
 *
 * One source tree now ships two products — the office-oriented `Harness-CN` and the
 * science-oriented `HarScience` — and the difference between them is branding plus the bundled
 * plugin set, not a code fork. The release driver bakes the product name into the shell
 * (`HARNESS_CN_PRODUCT`) and into the sidecar it spawns, and everything user-facing that the shell
 * itself renders takes the name from here.
 *
 * The name is read once at import time on purpose: it arrives from the process environment the
 * launcher sets, so it cannot change while the process runs, and reading it on every call would only
 * make the branding look optional to its callers.
 */
import type { DesktopLocale, DesktopMessages } from './locale.ts'

export const PRODUCT_NAME = process.env.HARNESS_CN_PRODUCT?.trim() || 'Harness-CN'

/** Marks the unbranded product, whose copy the locale dictionary already carries. */
const DEFAULT_PRODUCT = 'Harness-CN'

/**
 * Rewrites the startup copy to name this product.
 *
 * The startup page and the splash window take their text from the shell's locale endpoint, so a
 * branded build only has to replace the strings that name the product; every other line stays as the
 * locale dictionary wrote it. When the product is the unbranded default the dictionary is returned
 * untouched, so Harness-CN keeps reading exactly as before.
 *
 * @param messages - locale dictionary resolved for this launch.
 * @param localeId - locale the dictionary was chosen for.
 * @returns the same dictionary with the product-naming entries replaced.
 */
export function productMessages(
  messages: DesktopMessages,
  localeId: DesktopLocale['id'],
): DesktopMessages {
  if (PRODUCT_NAME === DEFAULT_PRODUCT) return messages
  const chinese = localeId === 'zh-CN'
  return {
    ...messages,
    startupTitle: PRODUCT_NAME,
    startupWindowTitle: chinese ? `${PRODUCT_NAME} — 正在启动` : `${PRODUCT_NAME} — Starting`,
    startupFailed: chinese ? `${PRODUCT_NAME} 无法启动` : `${PRODUCT_NAME} could not start`,
    updateTitle: chinese ? `${PRODUCT_NAME} 更新` : `${PRODUCT_NAME} update`,
    pluginWindowTitle: chinese ? `${PRODUCT_NAME} — 内置插件` : `${PRODUCT_NAME} — Bundled plugins`,
  }
}
