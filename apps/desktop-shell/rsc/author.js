/** Copy the WeChat id on click, so the reader does not have to retype 11 digits. */
const wechat = document.querySelector('#wechat')
const hint = document.querySelector('#copy-hint')
const WECHAT_ID = '18563982192'

/**
 * Report one line of feedback under the id.
 * @param text - message to show.
 * @param tone - optional colour tone, `ok` for success.
 */
function say(text, tone) {
  hint.textContent = text
  if (tone === undefined) hint.removeAttribute('data-tone')
  else hint.dataset.tone = tone
}

/**
 * Copy text, preferring the async clipboard API and falling back to a selection.
 * @param text - text to place on the clipboard.
 * @returns whether the copy succeeded.
 */
async function copy(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // The async API needs a permission the shell's origin may not hold, so the
    // selection-based path is the fallback rather than an error.
    try {
      const scratch = document.createElement('textarea')
      scratch.value = text
      scratch.setAttribute('readonly', '')
      scratch.style.position = 'fixed'
      scratch.style.opacity = '0'
      document.body.append(scratch)
      scratch.select()
      const copied = document.execCommand('copy')
      scratch.remove()
      return copied
    } catch {
      return false
    }
  }
}

wechat.addEventListener('click', () => {
  void copy(WECHAT_ID).then((copied) => {
    if (copied) say('微信号已复制', 'ok')
    else say('复制失败，请手动输入上面的号码')
  })
})

wechat.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    wechat.click()
  }
})
