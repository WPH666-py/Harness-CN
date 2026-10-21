/**
 * Back control for phones.
 *
 * The shell's own pages are separate documents: opening one from the mobile menu replaces the
 * workspace page, and the only way back is the browser's chrome. A desktop window has a title bar
 * instead, so this script is injected only into pages served to a remote client.
 *
 * It is a separate same-origin file rather than an inline style and inline script because these
 * pages carry `style-src 'self'; script-src 'self'`: an inline `<style>` or `<script>` is blocked,
 * which is exactly how the first attempt at this control ended up as an unstyled, dead element at
 * the bottom of the document. Same-origin files pass that policy, and CSSOM writes
 * (`button.style.top = …`) are not covered by `style-src`.
 */
(function () {
  if (!/^\/shell\/[^/]+\.html$/.test(window.location.pathname)) return
  if (document.getElementById('shell-back') !== null) return
  var button = document.createElement('button')
  button.id = 'shell-back'
  button.type = 'button'
  button.textContent = '← 返回'
  button.setAttribute('aria-label', '返回')
  var style = button.style
  style.position = 'fixed'
  style.top = '12px'
  style.left = '12px'
  style.zIndex = '2147483647'
  style.display = 'flex'
  style.alignItems = 'center'
  style.justifyContent = 'center'
  style.boxSizing = 'border-box'
  style.minWidth = '96px'
  style.height = '44px'
  style.padding = '0 18px'
  style.border = '0'
  style.borderRadius = '22px'
  style.background = 'rgba(0, 0, 0, 0.72)'
  style.color = '#fff'
  style.font = '16px/1 system-ui, -apple-system, "Microsoft YaHei", sans-serif'
  style.boxShadow = '0 2px 12px rgba(0, 0, 0, 0.35)'
  style.cursor = 'pointer'
  style.webkitTapHighlightColor = 'transparent'
  button.addEventListener('click', function () {
    // A page opened as the first entry of a tab has no history to go back to, so the workspace is
    // the fallback destination rather than a dead button.
    if (window.history.length > 1) window.history.back()
    else window.location.assign('/')
  })
  document.body.appendChild(button)
})()
