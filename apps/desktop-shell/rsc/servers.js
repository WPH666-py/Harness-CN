/**
 * Server manager window.
 *
 * Lists the paired remote-development hosts and adds another one, over the same HTTP routes the
 * plugin's own settings page uses (`/remote-ssh-ops/v1/hosts`). It lives in the shell rather than in
 * the workspace because the workspace's "server" chip is a dropdown inside a conversation, while this
 * is the place the top menu opens when the user wants to manage hosts without a session open.
 */

const PREFIX = '/remote-ssh-ops/v1'

const el = (id) => document.getElementById(id)

/** Read one JSON response, turning a non-2xx answer into the plugin's own error message. */
async function parse(response) {
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`)
  return body
}

const get = (path) => fetch(PREFIX + path).then(parse)
const post = (path, body) => fetch(PREFIX + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
}).then(parse)

/** Report one line of progress or failure under the forms. */
function say(text, tone) {
  const status = el('status')
  status.textContent = text
  status.dataset.tone = tone ?? ''
}

/** Render the paired hosts, newest first as the plugin returns them. */
function renderHosts(hosts) {
  const list = el('hosts')
  list.textContent = ''
  for (const host of hosts) {
    const item = document.createElement('li')

    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = host.display_name || host.host_id

    const meta = document.createElement('span')
    meta.className = 'meta'
    const latency = Number(host.latency_ms)
    const parts = [host.status || (host.online ? 'online' : 'offline')]
    if (host.latency_ms != null && Number.isFinite(latency)) parts.push(`${Math.round(latency)} ms`)
    meta.textContent = parts.join(' · ')

    const state = document.createElement('span')
    state.className = host.status === 'online' || host.online === true ? 'online' : 'offline'
    state.textContent = host.status === 'online' || host.online === true ? '在线' : '离线'

    const spacer = document.createElement('span')
    spacer.className = 'spacer'

    const use = document.createElement('button')
    use.type = 'button'
    use.textContent = '使用'
    use.addEventListener('click', () => {
      use.disabled = true
      post(`/hosts/${encodeURIComponent(host.host_id)}/use`, {})
        .then(() => say(`已切换到「${host.display_name || host.host_id}」`, 'ok'))
        .catch((error) => say(`切换失败：${error.message}`, 'error'))
        .finally(() => { use.disabled = false })
    })

    item.append(name, meta, state, spacer, use)
    list.appendChild(item)
  }
  el('hostsNote').textContent = hosts.length === 0
    ? '还没有添加任何服务器。用下面的表单添加一台，主界面顶部的「服务器」按钮就会出现它。'
    : `共 ${hosts.length} 台`
}

/** Load the list and paint it. */
async function refresh() {
  const button = el('refresh')
  button.disabled = true
  try {
    const result = await get('/hosts')
    renderHosts(Array.isArray(result.hosts) ? result.hosts : [])
  } catch (error) {
    el('hostsNote').textContent = `读取服务器列表失败：${error.message}`
  } finally {
    button.disabled = false
  }
}

/** Switch between the pairing-code form and the SSH form. */
function selectTab(mode) {
  const pair = mode === 'pair'
  el('tab-pair').setAttribute('aria-selected', String(pair))
  el('tab-ssh').setAttribute('aria-selected', String(!pair))
  el('pairForm').hidden = !pair
  el('sshForm').hidden = pair
  say('')
}

el('tab-pair').addEventListener('click', () => { selectTab('pair') })
el('tab-ssh').addEventListener('click', () => { selectTab('ssh') })
el('refresh').addEventListener('click', () => { void refresh() })

el('pairForm').addEventListener('submit', (event) => {
  event.preventDefault()
  const address = el('pairAddress').value.trim()
  const pairingCode = el('pairCode').value.trim()
  if (address === '' || pairingCode === '') {
    say('地址与配对码都要填。', 'error')
    return
  }
  say('正在配对…')
  post('/hosts/pair', {
    address,
    pairing_code: pairingCode,
    display_name: el('pairName').value.trim() || undefined,
  }).then(() => {
    say('已添加。', 'ok')
    el('pairForm').reset()
    return refresh()
  }).catch((error) => say(`添加失败：${error.message}`, 'error'))
})

el('sshForm').addEventListener('submit', (event) => {
  event.preventDefault()
  const host = el('sshHost').value.trim()
  const username = el('sshUser').value.trim()
  const password = el('sshPassword').value
  if (host === '' || username === '' || password === '') {
    say('主机、用户名、密码都要填。', 'error')
    return
  }
  const port = Number(el('sshPort').value || '22')
  say('正在连接…')
  post('/hosts/ssh', {
    host,
    port: Number.isFinite(port) && port > 0 ? port : 22,
    username,
    password,
    display_name: el('sshName').value.trim() || undefined,
  }).then(() => {
    say('已添加。', 'ok')
    el('sshForm').reset()
    el('sshPort').value = '22'
    return refresh()
  }).catch((error) => say(`添加失败：${error.message}`, 'error'))
})

selectTab('pair')
void refresh()
