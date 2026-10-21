const toggle = document.querySelector('#toggle')
const state = document.querySelector('#state')
const panel = document.querySelector('#panel')
const linkInput = document.querySelector('#link')
const qrImage = document.querySelector('#qr')
const hint = document.querySelector('#hint')
const foot = document.querySelector('#foot')

const call = async (path, method = 'GET') => {
  const response = await fetch(`/shell-api/lan${path}`, { method, credentials: 'same-origin' })
  if (!response.ok) throw new Error(`shell-api ${path}: ${response.status}`)
  return await response.json()
}

const render = (status) => {
  toggle.checked = status.enabled === true
  state.textContent = status.enabled ? '已开启' : '已关闭'
  panel.hidden = status.enabled !== true
  if (status.enabled && status.link) {
    linkInput.value = status.link
    qrImage.src = `/shell-api/lan/qr?ts=${Date.now()}`
    hint.textContent = '用手机扫描上面的二维码，或把链接发到手机'
    foot.textContent = `局域网地址 ${status.address}:${status.port}（手机与电脑需在同一个 Wi-Fi）`
  } else {
    linkInput.value = ''
    qrImage.removeAttribute('src')
    foot.textContent = ''
  }
}

const fail = (error) => { foot.textContent = `操作失败：${error.message}` }

toggle.addEventListener('change', async () => {
  toggle.disabled = true
  try {
    render(await call(toggle.checked ? '/enable' : '/disable', 'POST'))
  } catch (error) {
    toggle.checked = !toggle.checked
    fail(error)
  } finally {
    toggle.disabled = false
  }
})

document.querySelector('#copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(linkInput.value)
    hint.textContent = '链接已复制'
  } catch {
    linkInput.select()
    hint.textContent = '请按 Ctrl+C 复制选中的链接'
  }
})

document.querySelector('#rotate').addEventListener('click', async () => {
  try {
    render(await call('/rotate', 'POST'))
    hint.textContent = '旧链接已失效，这是一条新链接'
  } catch (error) {
    fail(error)
  }
})

try {
  render(await call(''))
} catch (error) {
  fail(error)
}