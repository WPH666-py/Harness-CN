/**
 * The WorkBuddy AI card is only as good as the binary path this lookup produces: with it the card
 * reports the signed-in account its desktop app already wrote, without it the card claims the user
 * is signed out. These cases pin the path shapes the uninstall records actually carry.
 */
import { describe, expect, it } from 'vitest'
import { displayIconToPath, resolveWorkbuddyAiBinary, WORKBUDDY_AI_BINARY_ENV } from '../src/workbuddy-ai.ts'

const BINARY = 'D:\\Workbuddy海外版\\WorkBuddyAI\\WorkBuddyAI.exe'

describe('displayIconToPath', () => {
  it('strips the quotes and the icon index from a DisplayIcon value', () => {
    expect(displayIconToPath(`"${BINARY},0"`)).toBe(BINARY)
    expect(displayIconToPath(`${BINARY},-1`)).toBe(BINARY)
  })

  it('rejects values that do not name an executable', () => {
    expect(displayIconToPath('"C:\\app\\icon.ico"')).toBeUndefined()
    expect(displayIconToPath('')).toBeUndefined()
  })
})

describe('resolveWorkbuddyAiBinary', () => {
  it('prefers the explicit override when the file exists', () => {
    const resolved = resolveWorkbuddyAiBinary({
      env: { [WORKBUDDY_AI_BINARY_ENV]: BINARY },
      platform: 'win32',
      exists: path => path === BINARY,
    })
    expect(resolved).toBe(BINARY)
  })

  it('ignores an override that points at nothing', () => {
    const resolved = resolveWorkbuddyAiBinary({
      env: { [WORKBUDDY_AI_BINARY_ENV]: 'D:\\gone\\WorkBuddyAI.exe', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
      platform: 'win32',
      exists: () => false,
      readDisplayIcons: () => [],
    })
    expect(resolved).toBeUndefined()
  })

  it('finds the per-user install and then the uninstall record', () => {
    const local = 'C:\\Users\\me\\AppData\\Local\\Programs\\WorkBuddy AI\\WorkBuddyAI.exe'
    expect(resolveWorkbuddyAiBinary({
      env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
      platform: 'win32',
      exists: path => path === local,
      readDisplayIcons: () => [],
    })).toBe(local)
    expect(resolveWorkbuddyAiBinary({
      env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
      platform: 'win32',
      exists: path => path === BINARY,
      readDisplayIcons: () => [`"${BINARY},0"`],
    })).toBe(BINARY)
  })

  it('has no answer off Windows', () => {
    expect(resolveWorkbuddyAiBinary({
      env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
      platform: 'linux',
      exists: () => true,
      readDisplayIcons: () => [`"${BINARY},0"`],
    })).toBeUndefined()
  })
})
