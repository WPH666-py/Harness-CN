/**
 * The update window's controller.
 *
 * One release-channel state drives every pixel here, and it arrives on the shell's own event
 * stream rather than from the call that started the download: that request does not resolve until
 * the installer has been handed the file, so a window that waited for its own response would show
 * a frozen bar for the whole download. The stream also replays the current state on connect, which
 * is what lets a window opened mid-download render where things already stand.
 */

import { cancelUpdate, checkUpdates, getUpdateState, installUpdate, skipUpdate, subscribeEvents } from './shell-api.js'

/** Phrases for the fraction of the file that is on disk, without a trailing zero decimal. */
function megabytes(bytes) {
  return (bytes / 1048576).toFixed(1)
}

const nodes = {
  current: document.querySelector('#current'),
  version: document.querySelector('#version'),
  size: document.querySelector('#size'),
  published: document.querySelector('#published'),
  progress: document.querySelector('#progress'),
  phase: document.querySelector('#phase'),
  percent: document.querySelector('#percent'),
  bar: document.querySelector('#bar'),
  note: document.querySelector('#note'),
  notesBlock: document.querySelector('#notes-block'),
  notes: document.querySelector('#notes'),
  hint: document.querySelector('#hint'),
  skip: document.querySelector('#skip'),
  install: document.querySelector('#install'),
}

let phase = 'available'
let version = ''

/** Replace one element's text only when it changed, so the page is not rewritten every frame. */
function setText(node, text) {
  if (node.textContent !== text) node.textContent = text
}

/** Set a chip's text and visibility together. */
function setChip(node, text) {
  node.hidden = text === ''
  if (text !== '') setText(node, text)
}

/** Render one state the shell published. */
function render(state) {
  phase = typeof state.phase === 'string' ? state.phase : phase
  if (typeof state.current === 'string' && state.current !== '') setText(nodes.current, state.current)
  if (typeof state.version === 'string' && state.version !== '') {
    version = state.version
    setText(nodes.version, state.version)
  }

  const size = typeof state.total === 'number' && state.total > 0
    ? `📦 ${megabytes(state.total)} MB`
    : ''
  setChip(nodes.size, size)
  setChip(nodes.published, typeof state.publishedAt === 'string' && state.publishedAt !== '' ? `🕒 ${state.publishedAt}` : '')

  const notes = typeof state.notes === 'string' ? state.notes.trim() : ''
  nodes.notesBlock.hidden = notes === ''
  if (notes !== '') setText(nodes.notes, notes)

  if (phase === 'installing' || phase === 'ready') {
    const downloaded = typeof state.downloaded === 'number' ? state.downloaded : 0
    const total = typeof state.total === 'number' ? state.total : 0
    const fraction = phase === 'ready' ? 1 : (typeof state.progress === 'number' ? state.progress : 0)
    nodes.progress.hidden = false
    nodes.bar.style.width = `${String(Math.max(4, Math.round(fraction * 100)))}%`
    nodes.bar.classList.toggle('installing', phase === 'ready')
    setText(nodes.phase, phase === 'ready' ? '正在启动安装' : '正在从 Gitee 下载')
    setText(nodes.percent, phase === 'ready' || total <= 0 ? '' : `${String(Math.round(fraction * 100))}%`)
    setText(
      nodes.note,
      phase === 'ready'
        ? '应用即将退出，随后自动静默安装新版，完成后会自动重新打开。'
        : `${megabytes(downloaded)} MB${total > 0 ? ` / ${megabytes(total)} MB` : ''} · 下载完成后应用会自动退出并完成升级`,
    )
    nodes.install.disabled = true
    nodes.skip.disabled = phase === 'ready'
    setText(nodes.install, phase === 'ready' ? '安装中…' : `下载中…${total > 0 ? ` ${String(Math.round(fraction * 100))}%` : ''}`)
    setText(nodes.skip, phase === 'ready' ? '暂不更新' : '取消下载')
    setText(nodes.hint, '下载中可随时「取消下载」；关闭本窗口同样视为取消下载，不会安装任何内容。')
    return
  }

  if (phase === 'error') {
    nodes.progress.hidden = true
    nodes.install.disabled = false
    nodes.skip.disabled = false
    setText(nodes.install, '立即更新')
    setText(nodes.skip, '暂不更新')
    setText(nodes.hint, `更新失败：${state.message ?? '未知错误'}。可以稍后重试，或从发布页手动下载安装包。`)
    return
  }

  if (phase === 'idle') {
    // The release this window was opened for is no longer offered — an upgrade that landed under
    // it, most often. Everything stays readable and the primary action re-asks the channel.
    nodes.progress.hidden = true
    setText(nodes.install, '检查更新')
    setText(nodes.skip, '关闭')
    setText(nodes.hint, '当前已是最新版本。')
    return
  }

  nodes.progress.hidden = true
  setText(nodes.install, '立即更新')
  setText(nodes.skip, '暂不更新')
  setText(
    nodes.hint,
    '选择「暂不更新」后本次启动不再提示；下次打开还会再问一次。安装时会先关掉正在运行的会话与任务。',
  )
}

nodes.skip.addEventListener('click', async () => {
  if (phase === 'installing') {
    // Closing the window while a download runs is the same instruction as cancel: nothing has been
    // installed yet, so the user stopping it here must actually stop it.
    await cancelUpdate().catch(() => undefined)
    window.close()
    return
  }
  if (phase === 'installing' || phase === 'ready') return
  if (version !== '') await skipUpdate(version).catch(() => undefined)
  window.close()
})

nodes.install.addEventListener('click', async () => {
  nodes.install.disabled = true
  nodes.skip.disabled = true
  try {
    // The response carries the final state; the stream carries the ones in between.
    render(await installUpdate())
  } catch (error) {
    nodes.install.disabled = false
    nodes.skip.disabled = false
    setText(nodes.hint, `更新失败：${error instanceof Error ? error.message : String(error)}`)
  }
})

subscribeEvents({ update: render })

// A window opened from an already-offered release has no state of its own yet: the stream replays
// the shell's current value, and this read covers the gap before that connection is established.
getUpdateState().then(render).catch(() => undefined)
checkUpdates().then(render).catch((error) => {
  render({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
})
