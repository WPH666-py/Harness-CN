/** Render the shop's product grid from the catalogue data. */
import { PRODUCTS } from './shop-catalog.js'

const intro = document.querySelector('#intro')
const note = document.querySelector('#note')
const list = document.querySelector('#products')

intro.textContent = '青食官方旗舰店 · 中华老字号。点击任意商品即可前往拼多多查看详情与下单。'
note.textContent = '以上链接均为拼多多商品页，购买、支付与售后由平台承担。'

/**
 * Build one product card.
 * @param product - catalogue entry to render.
 * @returns the list item.
 */
function card(product) {
  const item = document.createElement('li')
  const figure = document.createElement('figure')
  const image = document.createElement('img')
  image.src = `./shop/${product.image}`
  image.alt = product.name
  image.loading = 'lazy'
  image.decoding = 'async'
  figure.append(image)

  const body = document.createElement('div')
  body.className = 'body'
  const name = document.createElement('p')
  name.className = 'name'
  name.textContent = product.name
  const detail = document.createElement('p')
  detail.className = 'detail'
  detail.textContent = product.detail
  body.append(name, detail)

  item.append(figure, body)

  if (product.url === '') {
    // No link was supplied for this product, so it is presented as unavailable
    // rather than pointed at a different product's page.
    item.classList.add('unavailable')
    const missing = document.createElement('p')
    missing.className = 'buy disabled'
    missing.textContent = '链接待补充'
    body.append(missing)
    return item
  }

  const buy = document.createElement('a')
  buy.className = 'buy'
  buy.href = product.url
  buy.target = '_blank'
  buy.rel = 'noreferrer noopener'
  buy.textContent = '前往拼多多购买 →'
  body.append(buy)
  return item
}

list.append(...PRODUCTS.map(card))
