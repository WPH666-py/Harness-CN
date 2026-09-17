import { describe, expect, it } from 'vitest'
import { unclaimedRequestOwner } from '../src/request-routing.ts'

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
