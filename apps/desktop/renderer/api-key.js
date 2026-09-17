const api = window.dshDesktop

// Electron wraps a rejected invoke in "Error invoking remote method '…': Error: …".
// The bind page shows the shell's own sentence, so that transport prefix is removed.
function readableMessage(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text
    .replace(/^Error invoking remote method '[^']*':\s*/u, '')
    .replace(/^Error:\s*/u, '')
}

async function main() {
  const locale = await api.locale()
  const messages = locale.messages
  document.documentElement.lang = locale.id
  document.querySelector('#page-title').textContent = messages.apiKeyTitle
  document.querySelector('#title').textContent = messages.apiKeyTitle
  document.querySelector('#description').textContent = messages.apiKeyDescription
  document.querySelector('#key-label').textContent = messages.apiKeyFieldLabel
  document.querySelector('#show-label').textContent = messages.apiKeyShow
  document.querySelector('#save').textContent = messages.apiKeySave
  document.querySelector('#later').textContent = messages.apiKeyLater
  document.querySelector('#quit').textContent = messages.apiKeyQuit

  const form = document.querySelector('#form')
  const input = document.querySelector('#key')
  const show = document.querySelector('#show')
  const status = document.querySelector('#status')

  function setBusy(busy, text = '', tone = '') {
    for (const control of document.querySelectorAll('button, input')) control.disabled = busy
    status.textContent = text
    if (tone === '') delete status.dataset.tone
    else status.dataset.tone = tone
  }

  show.addEventListener('change', () => {
    input.type = show.checked ? 'text' : 'password'
  })

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const value = input.value.trim()
    if (value === '') return
    void (async () => {
      setBusy(true, messages.apiKeyValidating)
      try {
        await api.apiKey.save(value)
        input.value = ''
        setBusy(true, messages.apiKeyStored, 'ok')
        // The shell closes this window and opens the main window on success, so the
        // controls stay disabled instead of inviting a second submission.
      } catch (error) {
        setBusy(false, readableMessage(error), 'error')
      }
    })()
  })

  document.querySelector('#later').addEventListener('click', () => { void api.apiKey.defer() })
  document.querySelector('#quit').addEventListener('click', () => { void api.apiKey.quit() })

  input.focus()
}

void main()
