import { describe, expect, it } from 'vitest'
import { headersForAuthority, unclaimedRequestOwner } from '../src/request-routing.ts'

describe('headers for a request rebuilt against another listener', () => {
  it('re-targets the page origin at the listener the request is addressed to', () => {
    // The WebView's page is served from the desktop transport's origin; the plugin-route listener
    // is a different authority, and vet's write routes compare the two.
    const headers = new Headers({ origin: 'http://127.0.0.1:54927', 'content-type': 'application/json' })

    const rebuilt = headersForAuthority(headers, 'http://127.0.0.1:61038')

    expect(rebuilt.get('origin')).toBe('http://127.0.0.1:61038')
    expect(rebuilt.get('content-type')).toBe('application/json')
    // The caller's headers are the incoming request's, and are never mutated.
    expect(headers.get('origin')).toBe('http://127.0.0.1:54927')
  })

  it('leaves a request that carried no Origin without one', () => {
    const rebuilt = headersForAuthority(new Headers({ accept: 'text/html' }), 'http://127.0.0.1:61038')

    expect(rebuilt.has('origin')).toBe(false)
    expect(rebuilt.get('accept')).toBe('text/html')
  })
})

describe('desktop unclaimed request routing', () => {
  it('offers a write to the composed webserver, which owns the plugin routes that take one', () => {
    expect(unclaimedRequestOwner({ method: 'POST', port: 51820 })).toBe('webserver')
    expect(unclaimedRequestOwner({ method: 'DELETE', port: 51820 })).toBe('webserver')
  })

  it('falls back to the shell assets only for a read the webserver did not claim', () => {
    expect(unclaimedRequestOwner({ method: 'GET', port: 51820, status: 404 })).toBe('assets')
    expect(unclaimedRequestOwner({ method: 'HEAD', port: 51820, status: 404 })).toBe('assets')
  })

  it('keeps the webserver response when a registered route claimed the request', () => {
    expect(unclaimedRequestOwner({ method: 'GET', port: 51820, status: 200 })).toBe('webserver')
    expect(unclaimedRequestOwner({ method: 'POST', port: 51820, status: 200 })).toBe('webserver')
  })

  it('keeps the webserver status for an unclaimed write instead of replacing it with a method error', () => {
    expect(unclaimedRequestOwner({ method: 'POST', port: 51820, status: 404 })).toBe('webserver')
  })

  it('answers everything from the shell when the composition has no webserver row', () => {
    expect(unclaimedRequestOwner({ method: 'GET', port: undefined })).toBe('assets')
    expect(unclaimedRequestOwner({ method: 'POST', port: undefined })).toBe('assets')
  })
})
