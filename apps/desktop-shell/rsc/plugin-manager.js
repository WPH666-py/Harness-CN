/**
 * Desktop plugin manager: list the plugins this build ships and their versions.
 *
 * It is a read-only view on purpose. Every plugin here arrives with the release, so
 * an install, update, or removal control could only ever move the profile away from
 * the set the build was verified with — and a plugin that fails to compose takes the
 * whole application down with it, which is not a failure a settings window should be
 * able to cause.
 */

import { getLocale, listPlugins } from './shell-api.js'

async function main() {
  const locale = await getLocale()
  const messages = locale.messages
  document.documentElement.lang = locale.id
  document.querySelector('#page-title').textContent = messages.pluginManagerTitle
  document.querySelector('#title').textContent = messages.pluginManagerTitle
  document.querySelector('#description').textContent = messages.pluginManagerDescription
  document.querySelector('#refresh').textContent = messages.refresh
  document.querySelector('#installed-heading').textContent = messages.installed
  document.querySelector('#empty').textContent = messages.noPlugins

  const list = document.querySelector('#plugins')
  const empty = document.querySelector('#empty')
  const status = document.querySelector('#status')
  const refresh = document.querySelector('#refresh')

  function setBusy(busy, statusMessage = '') {
    for (const control of document.querySelectorAll('button')) control.disabled = busy
    status.textContent = statusMessage
  }

  async function render() {
    const plugins = await listPlugins()
    list.replaceChildren(...plugins.map(plugin => {
      const item = document.createElement('li')
      const identity = document.createElement('span')
      const version = document.createElement('span')
      version.className = 'package-version'
      version.textContent = plugin.version
      identity.append(document.createTextNode(plugin.name), version)
      const actions = document.createElement('span')
      actions.className = 'package-actions'
      const badge = document.createElement('span')
      badge.className = 'package-bundled'
      // An entry that is not bundled was placed in the profile by a bundle patch or by
      // the user, so it is reported as installed rather than claimed as shipped here.
      badge.textContent = plugin.bundled ? messages.bundled : messages.installedBadge
      if (plugin.bundled) badge.title = messages.bundledHint
      actions.append(badge)
      item.append(identity, actions)
      return item
    }))
    empty.hidden = plugins.length !== 0
  }

  async function load(statusMessage, success) {
    setBusy(true, statusMessage)
    try {
      await render()
      status.textContent = success
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error)
    } finally {
      setBusy(false, status.textContent)
    }
  }

  refresh.addEventListener('click', () => void load(messages.refreshing, messages.refreshed))

  await load(messages.loadingPlugins, '')
}

void main()
