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

/**
 * Build one row of the list.
 *
 * @param label - the name shown on the left.
 * @param meta - the status line under it.
 * @param buttons - the controls on the right, in the order they should read.
 * @returns the list item.
 */
function buildRow(label, meta, buttons) {
  const item = document.createElement('li')

  const name = document.createElement('span')
  name.className = 'name'
  name.textContent = label

  const state = document.createElement('span')
  state.className = 'meta'
  state.textContent = meta

  const spacer = document.createElement('span')
  spacer.className = 'spacer'

  const row = document.createElement('div')
  row.className = 'rowActions'
  row.append(...buttons)

  item.append(name, state, spacer, row)
  return item
}

/** A plain button with its label and click handler. */
function actionButton(text, onClick, extra) {
  const control = document.createElement('button')
  control.type = 'button'
  control.textContent = text
  if (extra !== undefined) Object.assign(control, extra)
  control.addEventListener('click', onClick)
  return control
}

/**
 * Render the local target and the paired hosts, one row each.
 *
 * The local desk is a row of its own rather than the absence of a host: it is where the
 * conversation, the three presentation stages, and this machine's files live, and switching back to
 * it is an action, not a side effect of deleting something.
 *
 * @param hosts - the paired hosts, as the list route returned them.
 * @param currentHostId - the host the window is showing, or null while it shows this machine.
 */
function renderHosts(hosts, currentHostId) {
  const list = el('hosts')
  list.textContent = ''
  const onLocal = currentHostId === null

  const refreshLocal = actionButton('刷新', () => {
    say('本机 127.0.0.1：可工作', 'ok')
    void refresh()
  })
  const switchLocal = actionButton(onLocal ? '正在使用' : '切换', () => {
    if (onLocal) return
    switchLocal.disabled = true
    post('/hosts/current/leave', {})
      .then(() => {
        say('已切换到「本机 127.0.0.1」', 'ok')
        return refresh()
      })
      .catch((error) => say(`切换失败：${error.message}`, 'error'))
      .finally(() => { switchLocal.disabled = false })
  }, { disabled: onLocal, className: onLocal ? 'current' : '' })
  list.appendChild(buildRow('本机 127.0.0.1', onLocal ? '正在使用 · 本地工作区' : '本地工作区', [refreshLocal, switchLocal]))

  for (const host of hosts) {
    const label = host.display_name || host.host_id
    const latency = Number(host.latency_ms)
    const parts = [host.status || (host.online ? 'online' : 'offline')]
    if (host.latency_ms != null && Number.isFinite(latency)) parts.push(`${Math.round(latency)} ms`)
    const current = host.host_id === currentHostId
    if (current) parts.push('正在使用')

    const probe = actionButton('刷新', () => {
      probe.disabled = true
      get(`/hosts/${encodeURIComponent(host.host_id)}/health`)
        .then((health) => {
          say(`${label}：${health.status ?? '状态未知'}${health.latency_ms != null ? ` · ${Math.round(Number(health.latency_ms))} ms` : ''}`, 'ok')
          return refresh()
        })
        .catch((error) => say(`刷新失败：${error.message}`, 'error'))
        .finally(() => { probe.disabled = false })
    })

    const use = actionButton(current ? '正在使用' : '切换', () => {
      if (current) return
      use.disabled = true
      post(`/hosts/${encodeURIComponent(host.host_id)}/use`, {})
        .then(() => {
          say(`已切换到「${label}」`, 'ok')
          // Repaint from the server's answer rather than from this click: the switch also moves the
          // window, and this list has to agree with where the window now is.
          return refresh()
        })
        .catch((error) => say(`切换失败：${error.message}`, 'error'))
        .finally(() => { use.disabled = false })
    }, { disabled: current, className: current ? 'current' : '' })

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

    list.appendChild(buildRow(label, parts.join(' · '), [probe, use, remove]))
  }

  el('hostsNote').textContent = hosts.length === 0
    ? '还没有添加任何服务器。用下面的表单添加一台，主界面顶部的「服务器」按钮就会出现它。'
    : `共 ${hosts.length} 台服务器，外加本机`
}

/** Load the list and paint it. */
async function refresh() {
  try {
    const result = await get('/hosts')
    const current = typeof result.current_host_id === 'string' ? result.current_host_id : null
    renderHosts(Array.isArray(result.hosts) ? result.hosts : [], current)
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
