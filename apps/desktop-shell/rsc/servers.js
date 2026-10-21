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
  if (!response.ok) {
    const error = new Error(body.error || `HTTP ${response.status}`)
    // The SSH endpoint answers the first attempt with the fingerprint it read from the host and
    // expects the caller to send it back once the user has confirmed it; the fields that carry it
    // have to survive this wrapper or the confirmation cannot happen.
    Object.assign(error, body)
    throw error
  }
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

/** Render the paired hosts, one row each with refresh, use and delete side by side. */
function renderHosts(hosts) {
  const list = el('hosts')
  list.textContent = ''
  for (const host of hosts) {
    const label = host.display_name || host.host_id
    const item = document.createElement('li')

    const name = document.createElement('span')
    name.className = 'name'
    name.textContent = label

    const meta = document.createElement('span')
    meta.className = 'meta'
    const latency = Number(host.latency_ms)
    const parts = [host.status || (host.online ? 'online' : 'offline')]
    if (host.latency_ms != null && Number.isFinite(latency)) parts.push(`${Math.round(latency)} ms`)
    meta.textContent = parts.join(' · ')

    const spacer = document.createElement('span')
    spacer.className = 'spacer'

    const row = document.createElement('div')
    row.className = 'rowActions'

    const probe = document.createElement('button')
    probe.type = 'button'
    probe.textContent = '刷新'
    probe.addEventListener('click', () => {
      probe.disabled = true
      get(`/hosts/${encodeURIComponent(host.host_id)}/health`)
        .then((health) => {
          say(`${label}：${health.status ?? '状态未知'}${health.latency_ms != null ? ` · ${Math.round(Number(health.latency_ms))} ms` : ''}`, 'ok')
          return refresh()
        })
        .catch((error) => say(`刷新失败：${error.message}`, 'error'))
        .finally(() => { probe.disabled = false })
    })

    const use = document.createElement('button')
    use.type = 'button'
    use.textContent = '使用'
    use.addEventListener('click', () => {
      use.disabled = true
      post(`/hosts/${encodeURIComponent(host.host_id)}/use`, {})
        .then(() => say(`已切换到「${label}」`, 'ok'))
        .catch((error) => say(`切换失败：${error.message}`, 'error'))
        .finally(() => { use.disabled = false })
    })

    // Deleting is two clicks in the same button: a confirmation rendered in the page survives a
    // WebView that drops script dialogs, and a second click is the same gesture a dialog would ask
    // for anyway.
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'danger'
    remove.textContent = '删除'
    let armed = false
    let disarm
    remove.addEventListener('click', () => {
      if (!armed) {
        armed = true
        remove.textContent = '确认删除'
        disarm = setTimeout(() => { armed = false; remove.textContent = '删除' }, 4000)
        return
      }
      clearTimeout(disarm)
      remove.disabled = true
      fetch(`${PREFIX}/hosts/${encodeURIComponent(host.host_id)}`, { method: 'DELETE' })
        .then((response) => parse(response))
        .then(() => {
          say(`已删除「${label}」`, 'ok')
          return refresh()
        })
        .catch((error) => {
          remove.disabled = false
          armed = false
          remove.textContent = '删除'
          say(`删除失败：${error.message}`, 'error')
        })
    })

    row.append(probe, use, remove)
    item.append(name, meta, spacer, row)
    list.appendChild(item)
  }
  el('hostsNote').textContent = hosts.length === 0
    ? '还没有添加任何服务器。用下面的表单添加一台，主界面顶部的「服务器」按钮就会出现它。'
    : `共 ${hosts.length} 台`
}

/** Load the list and paint it. */
async function refresh() {
  try {
    const result = await get('/hosts')
    renderHosts(Array.isArray(result.hosts) ? result.hosts : [])
  } catch (error) {
    el('hostsNote').textContent = `读取服务器列表失败：${error.message}`
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


/**
 * Render the fingerprint the host presented, with a button that trusts it and connects.
 *
 * The confirmation is drawn in the page instead of `window.confirm`: this document runs inside a
 * WebView, where a script dialog can be suppressed, and a suppressed dialog here would look exactly
 * like the failure this flow exists to resolve.
 * @param payload - the SSH fields the user entered, without the fingerprint.
 * @param fingerprint - the SHA-256 the host presented.
 */
function askTrust(payload, fingerprint) {
  const status = el('status')
  status.textContent = ''
  status.dataset.tone = ''
  const text = document.createElement('div')
  text.textContent = `首次连接需要确认服务器指纹：${fingerprint}`
  const trust = document.createElement('button')
  trust.type = 'button'
  trust.textContent = '信任该指纹并连接'
  trust.style.marginLeft = '8px'
  trust.addEventListener('click', () => {
    trust.disabled = true
    say('正在连接…')
    post('/hosts/ssh', { ...payload, host_fingerprint: fingerprint }).then(() => {
      say('已添加。', 'ok')
      el('sshForm').reset()
      el('sshPort').value = '22'
      return refresh()
    }).catch((error) => say(`添加失败：${error.message}`, 'error'))
  })
  status.append(text, trust)
}

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
  const payload = {
    host,
    port: Number.isFinite(port) && port > 0 ? port : 22,
    username,
    password,
    display_name: el('sshName').value.trim() || undefined,
  }
  say('正在连接…')
  post('/hosts/ssh', payload).then(() => {
    say('已添加。', 'ok')
    el('sshForm').reset()
    el('sshPort').value = '22'
    return refresh()
  }).catch((error) => {
    // A host whose key is not trusted yet answers with the fingerprint rather than a failure: the
    // credentials were never tried, so this is the point at which the user decides.
    const fingerprint = typeof error.fingerprint === 'string' ? error.fingerprint : ''
    if (fingerprint !== '' && error.code === 'HOST_KEY_UNTRUSTED') {
      askTrust(payload, fingerprint)
      return
    }
    say(`添加失败：${error.message}`, 'error')
  })
})

selectTab('pair')
void refresh()
