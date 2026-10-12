import { sendFeedback } from './shell-api.js'

const form = document.querySelector('#form')
const message = document.querySelector('#message')
const email = document.querySelector('#email')
const send = document.querySelector('#send')
const status = document.querySelector('#status')

document.querySelector('#intro').textContent =
  '把您的使用感受、遇到的问题或想要的功能写在这里，直接发给作者本人。'
document.querySelector('#message-label').textContent = '评价与反馈（必填）'
document.querySelector('#email-label').textContent = '您的 QQ 邮箱（必填，用于回复）'
document.querySelector('#hint').textContent = '邮箱只用于作者回复您，不会用于其他用途。'
send.textContent = '发送'

const SENT = '发送成功，水哥看到会尽快处理和联系，请勿短时间内重复发送邮件，感谢支持！'

/** Show one line under the form. @param text - message. @param tone - `ok` or `error`. */
function say(text, tone) {
  status.textContent = text
  if (tone === undefined) status.removeAttribute('data-tone')
  else status.dataset.tone = tone
}

form.addEventListener('submit', (event) => {
  event.preventDefault()
  const text = message.value.trim()
  const address = email.value.trim()
  if (text === '') {
    say('请先填写评价与反馈内容', 'error')
    message.focus()
    return
  }
  if (address === '') {
    say('请填写您的 QQ 邮箱，否则作者无法回复您', 'error')
    email.focus()
    return
  }

  send.disabled = true
  message.disabled = true
  email.disabled = true
  say('正在发送…')

  sendFeedback({ message: text, email: address }).then(
    () => {
      say(SENT, 'ok')
      form.reset()
      send.disabled = false
      message.disabled = false
      email.disabled = false
    },
    (error) => {
      say(`发送失败：${error instanceof Error ? error.message : String(error)}`, 'error')
      send.disabled = false
      message.disabled = false
      email.disabled = false
    },
  )
})
