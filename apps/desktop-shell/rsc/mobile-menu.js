/*
 * The phone menu: the window menu's mobile half, injected by the shell into any page it forwards
 * to a paired phone.
 *
 * The ball is draggable and remembers where the user left it, because a fixed corner is wrong on
 * some device: a phone in portrait wants it above the composer, a tablet wants it off to the side,
 * and the GUI's own top bar already owns both top corners. It also carries the one control the
 * Host's settings dialog lacks on a phone — a way out of a full-screen panel.
 *
 * Only the operations a phone can genuinely finish appear here. Restart comes back through the
 * control surface; the other five are shell pages the same listener already serves. Everything the
 * window menu offers but a phone should not drive — update install, API key, devtools, quit — is
 * absent on purpose, and the control surface refuses it from a LAN address regardless of what this
 * file asks for.
 */
(() => {
  const STORAGE_KEY = 'hcn-mm-position'
  const ITEMS = [
    { label: '重启', icon: '⟳', action: 'restart' },
    { label: '运行日志', icon: '▤', href: '/shell/log-viewer.html' },
    { label: '插件管理', icon: '⧉', href: '/shell/plugin-manager.html' },
    { label: '作者信息', icon: '☺', href: '/shell/author.html' },
    { label: '休闲食品商城', icon: '🛒', href: '/shell/shop.html' },
    { label: '评价与反馈', icon: '✉', href: '/shell/feedback.html' },
  ]

  if (document.querySelector('.hcn-mm-button') !== null) return

  /** Viewport width decides the ball's size and how far the sheet opens. */
  const viewport = () => ({ width: window.innerWidth, height: window.innerHeight })

  const button = document.createElement('button')
  button.className = 'hcn-mm-button'
  button.type = 'button'
  button.setAttribute('aria-label', '菜单')
  button.textContent = '☰'

  const scrim = document.createElement('div')
  scrim.className = 'hcn-mm-scrim'
  scrim.hidden = true

  const sheet = document.createElement('div')
  sheet.className = 'hcn-mm-sheet'
  sheet.setAttribute('role', 'menu')
  sheet.hidden = true

  const title = document.createElement('div')
  title.className = 'hcn-mm-title'
  title.textContent = 'Harness-CN'
  sheet.append(title)

  const note = document.createElement('div')
  note.className = 'hcn-mm-note'
  note.setAttribute('role', 'status')

  const close = document.createElement('button')
  close.className = 'hcn-mm-close'
  close.type = 'button'
  close.textContent = '关闭菜单'

  /** Show or hide the sheet, keeping the scrim and the button's label in step with it. */
  const setOpen = (open) => {
    sheet.hidden = !open
    scrim.hidden = !open
    if (open) {
      requestAnimationFrame(() => {
        scrim.classList.add('hcn-mm-open')
        sheet.classList.add('hcn-mm-open')
      })
      button.setAttribute('aria-expanded', 'true')
    }
    else {
      scrim.classList.remove('hcn-mm-open')
      sheet.classList.remove('hcn-mm-open')
      button.setAttribute('aria-expanded', 'false')
      // The transition has to finish before the elements leave the layout.
      setTimeout(() => {
        if (!sheet.classList.contains('hcn-mm-open')) {
          sheet.hidden = true
          scrim.hidden = true
        }
      }, 220)
    }
  }

  /** Report one control-surface answer without leaving the page. */
  const report = (text) => { note.textContent = text }

  const requestRestart = async () => {
    report('正在重启…')
    try {
      const response = await fetch('/shell-api/restart', { method: 'POST', credentials: 'same-origin' })
      if (!response.ok) throw new Error(String(response.status))
      // The listener goes away with the process, so the page has to wait for the replacement and
      // then ask for itself again. A reload that beats it shows the browser's offline page.
      setTimeout(() => { location.reload() }, 4000)
    }
    catch {
      report('重启请求没有被接受，请在电脑上重试。')
    }
  }

  for (const item of ITEMS) {
    const element = document.createElement('button')
    element.className = 'hcn-mm-item'
    element.type = 'button'
    element.setAttribute('role', 'menuitem')

    const icon = document.createElement('span')
    icon.className = 'hcn-mm-icon'
    icon.textContent = item.icon

    const label = document.createElement('span')
    label.textContent = item.label

    element.append(icon, label)
    element.addEventListener('click', () => {
      if (item.action === 'restart') { void requestRestart(); return }
      location.href = item.href
    })
    sheet.append(element)
  }

  sheet.append(note, close)
  close.addEventListener('click', () => { setOpen(false) })
  scrim.addEventListener('click', () => { setOpen(false) })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setOpen(false)
  })

  /**
   * Keep the ball inside the viewport.
   *
   * A rotation or a resize can leave a stored position off-screen, so every placement runs
   * through this instead of trusting what was saved.
   */
  const clamp = (left, top) => {
    const { width, height } = viewport()
    const size = button.offsetWidth || 48
    return {
      left: Math.min(Math.max(8, left), Math.max(8, width - size - 8)),
      top: Math.min(Math.max(8, top), Math.max(8, height - size - 8)),
    }
  }

  const place = (left, top) => {
    const fixed = clamp(left, top)
    button.style.left = `${String(fixed.left)}px`
    button.style.top = `${String(fixed.top)}px`
    button.style.right = 'auto'
    button.style.bottom = 'auto'
  }

  /** Put the ball at the right edge, a little above the middle: clear of both the top bar and the composer. */
  const placeDefault = () => {
    const { width, height } = viewport()
    const size = button.offsetWidth || 48
    place(width - size - 14, height * 0.62)
  }

  const restore = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
      if (saved !== null && typeof saved.left === 'number' && typeof saved.top === 'number') {
        place(saved.left, saved.top)
        return
      }
    }
    catch { /* a corrupted entry is the same as none */ }
    placeDefault()
  }

  let drag = null
  button.addEventListener('pointerdown', (event) => {
    drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false, originLeft: button.offsetLeft, originTop: button.offsetTop }
    button.setPointerCapture(event.pointerId)
  })
  button.addEventListener('pointermove', (event) => {
    if (drag === null || event.pointerId !== drag.id) return
    const dx = event.clientX - drag.startX
    const dy = event.clientY - drag.startY
    if (!drag.moved && Math.hypot(dx, dy) < 6) return
    drag.moved = true
    button.classList.add('hcn-mm-dragging')
    place(drag.originLeft + dx, drag.originTop + dy)
  })
  const endDrag = (event) => {
    if (drag === null || event.pointerId !== drag.id) return
    const moved = drag.moved
    drag = null
    button.classList.remove('hcn-mm-dragging')
    if (!moved) { setOpen(true); return }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ left: button.offsetLeft, top: button.offsetTop }))
    }
    catch { /* private mode: the position simply does not survive the page */ }
  }
  button.addEventListener('pointerup', endDrag)
  button.addEventListener('pointercancel', endDrag)
  window.addEventListener('resize', () => { place(button.offsetLeft, button.offsetTop) })
  window.addEventListener('orientationchange', () => { place(button.offsetLeft, button.offsetTop) })

  /*
   * The Host's settings dialog fills a phone's viewport and offers no close control of its own —
   * on a desktop it closes by clicking beside it. A dialog that is open is therefore given a way
   * out: a floating pill that sends the Escape the dialog already listens for.
   */
  const escapePill = document.createElement('button')
  escapePill.className = 'hcn-mm-escape'
  escapePill.type = 'button'
  escapePill.textContent = '关闭'
  escapePill.hidden = true
  escapePill.addEventListener('click', () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })

  const syncEscape = () => {
    const dialog = document.querySelector('[role="dialog"][aria-modal="true"]')
    escapePill.hidden = dialog === null || viewport().width > 900
  }
  const observer = new MutationObserver(() => { syncEscape() })
  observer.observe(document.body, { childList: true, subtree: true })
  window.addEventListener('resize', syncEscape)

  document.body.append(button, scrim, sheet, escapePill)
  restore()
  syncEscape()
})()

/*
 * Remove the update-notice card some plugins render into their settings page.
 *
 * A phone has no way to install a plugin update, so the card is an ad here: it fills the screen with
 * eleven release headings and the only button on it does nothing on this device. The card is found by
 * its own copy — it is the smallest element whose text carries both the "new version" heading and
 * the dismiss button — which keeps the rule working when the plugin's markup changes.
 */
(() => {
  const HEADING = '发现新版本'
  const DISMISS = '不再提醒'

  const hideUpdateCard = () => {
    const nodes = document.body?.querySelectorAll('div, section, article, form') ?? []
    let smallest = null
    for (const node of nodes) {
      const text = node.textContent ?? ''
      if (!text.includes(HEADING) || !text.includes(DISMISS)) continue
      if (smallest === null || text.length < (smallest.textContent ?? '').length) smallest = node
    }
    if (smallest !== null && smallest.dataset.hcnUpdateHidden !== '1') {
      smallest.dataset.hcnUpdateHidden = '1'
      smallest.style.display = 'none'
    }
  }

  let queued = false
  const schedule = () => {
    if (queued) return
    queued = true
    setTimeout(() => { queued = false; hideUpdateCard() }, 400)
  }

  schedule()
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true })
})()