/** Credential page: verify one DeepSeek key, or leave the launch for later. */

import { deferApiKey, getLocale, quit, saveApiKey } from './shell-api.js'

// The shell answers a rejected write with a sentence it already localized for this page,
// so the message is shown as it arrived rather than rewritten here.
function readableMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

async function main() {
  const locale = await getLocale()
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
        await saveApiKey(value)
        input.value = ''
        setBusy(true, messages.apiKeyStored, 'ok')
        // The shell closes this window and opens the main window on success, so the
        // controls stay disabled instead of inviting a second submission.
      } catch (error) {
        setBusy(false, readableMessage(error), 'error')
      }
    })()
  })

  document.querySelector('#later').addEventListener('click', () => { void deferApiKey() })
  document.querySelector('#quit').addEventListener('click', () => { void quit() })

  input.focus()
}

void main()
