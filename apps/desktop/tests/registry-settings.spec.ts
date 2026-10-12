/**
 * Behavior of the registry a plugin install runs against.
 *
 * A machine behind a mirror or a proxy states how it reaches the registry; an installer that
 * overrides that choice cannot install anything on exactly the machines that need the mirror. These
 * cases pin which value wins, and which values are refused rather than guessed at.
 */

import { describe, expect, it } from 'vitest'

const { registryTransportEnvironment, resolveRegistrySettings, statedRegistry } = await import(
  '../src/project-manager.ts',
)

/** Every environment name these cases may touch, with the value the machine had. */
interface SavedEnvironment {
  readonly lowerRegistry: string | undefined
  readonly upperRegistry: string | undefined
  readonly lowerUserConfig: string | undefined
  readonly upperUserConfig: string | undefined
  readonly lowerHttpsProxy: string | undefined
  readonly upperHttpsProxy: string | undefined
  readonly lowerHttpProxy: string | undefined
  readonly upperHttpProxy: string | undefined
  readonly lowerNoProxy: string | undefined
  readonly upperNoProxy: string | undefined
  readonly extraCaCerts: string | undefined
  readonly sslCertFile: string | undefined
}

/**
 * Read every name this suite manages, so a case can put the machine's own values back.
 * @returns the values as the machine had them.
 */
function readManagedEnvironment(): SavedEnvironment {
  return {
    lowerRegistry: process.env.npm_config_registry,
    upperRegistry: process.env.NPM_CONFIG_REGISTRY,
    lowerUserConfig: process.env.npm_config_userconfig,
    upperUserConfig: process.env.NPM_CONFIG_USERCONFIG,
    lowerHttpsProxy: process.env.https_proxy,
    upperHttpsProxy: process.env.HTTPS_PROXY,
    lowerHttpProxy: process.env.http_proxy,
    upperHttpProxy: process.env.HTTP_PROXY,
    lowerNoProxy: process.env.no_proxy,
    upperNoProxy: process.env.NO_PROXY,
    extraCaCerts: process.env.NODE_EXTRA_CA_CERTS,
    sslCertFile: process.env.SSL_CERT_FILE,
  }
}

/**
 * Set one name, or clear it when the case does not state it.
 *
 * Clearing has to go through the environment record rather than a literal name: which variable a
 * case removes is what the case is about. `process.env` is a special object whose own semantics are
 * exactly this operation, so the rule against dynamic deletion does not describe a hazard here.
 * @param name - environment name.
 * @param value - value to set, or undefined to clear.
 */
function applyName(name: string, value: string | undefined): void {
  if (value === undefined) {
    // oxlint-disable-next-line typescript/no-dynamic-delete -- clearing process.env is the operation under test
    delete process.env[name]
    return
  }
  process.env[name] = value
}

/**
 * Restore every name this suite manages to the values the machine had.
 * @param saved - values from {@link readManagedEnvironment}.
 */
function restoreManagedEnvironment(saved: SavedEnvironment): void {
  applyName('npm_config_registry', saved.lowerRegistry)
  applyName('NPM_CONFIG_REGISTRY', saved.upperRegistry)
  applyName('npm_config_userconfig', saved.lowerUserConfig)
  applyName('NPM_CONFIG_USERCONFIG', saved.upperUserConfig)
  applyName('https_proxy', saved.lowerHttpsProxy)
  applyName('HTTPS_PROXY', saved.upperHttpsProxy)
  applyName('http_proxy', saved.lowerHttpProxy)
  applyName('HTTP_PROXY', saved.upperHttpProxy)
  applyName('no_proxy', saved.lowerNoProxy)
  applyName('NO_PROXY', saved.upperNoProxy)
  applyName('NODE_EXTRA_CA_CERTS', saved.extraCaCerts)
  applyName('SSL_CERT_FILE', saved.sslCertFile)
}

/**
 * Run one case as a machine that states exactly the environment it is given.
 *
 * The suite runs on somebody's workstation, and a workstation may well have a mirror or a proxy
 * configured. Which value wins is what these cases judge, so each case clears every name this suite
 * manages and then sets the ones it states, instead of inheriting whatever shell it runs in.
 * @param values - names this case sets; every other managed name is cleared.
 * @param body - the assertions to run.
 */
function withEnvironment(values: Readonly<Record<string, string>>, body: () => void): void {
  const saved = readManagedEnvironment()
  try {
    restoreManagedEnvironment({
      lowerRegistry: undefined,
      upperRegistry: undefined,
      lowerUserConfig: undefined,
      upperUserConfig: undefined,
      lowerHttpsProxy: undefined,
      upperHttpsProxy: undefined,
      lowerHttpProxy: undefined,
      upperHttpProxy: undefined,
      lowerNoProxy: undefined,
      upperNoProxy: undefined,
      extraCaCerts: undefined,
      sslCertFile: undefined,
    })
    for (const [name, value] of Object.entries(values)) applyName(name, value)
    body()
  } finally {
    restoreManagedEnvironment(saved)
  }
}

/**
 * Run one case with one name set and every other managed name cleared.
 *
 * Splitting this out of {@link withEnvironment} is what lets a case state two spellings of the same
 * setting in turn: setting the second must not clear the first before the assertion reads it.
 * @param name - the one name this case sets.
 * @param value - the value it sets.
 * @param body - the assertions to run.
 */
function withSingleEnvironment(name: string, value: string, body: () => void): void {
  withEnvironment({ [name]: value }, body)
}

/** Run one case as a machine that states no registry of any kind. */
function withNoEnvironment(body: () => void): void {
  withEnvironment({}, body)
}

const FALLBACK_CONFIG = 'C:\\Users\\someone\\.dsh\\desktop\\pnpm\\config\\npmrc'

describe('plugin install registry', () => {
  it('installs from the product default registry only when the machine names none', () => {
    withNoEnvironment(() => {
      expect(statedRegistry()).toBeUndefined()
      expect(resolveRegistrySettings(FALLBACK_CONFIG)).toEqual({
        registry: 'https://registry.npmjs.org/',
        userConfig: FALLBACK_CONFIG,
      })
    })
  })

  it('uses the registry the machine names, in either spelling and any writing of one origin', () => {
    withSingleEnvironment('NPM_CONFIG_REGISTRY', 'https://registry.npmmirror.com', () => {
      expect(statedRegistry()).toBe('https://registry.npmmirror.com/')
    })
    withSingleEnvironment('npm_config_registry', 'http://mirror.internal:8081/', () => {
      expect(statedRegistry()).toBe('http://mirror.internal:8081/')
    })
  })

  it('refuses a value that is not a registry origin instead of installing from it', () => {
    // A path, credentials, a query, and a non-HTTP scheme are each either a typo or an attempt to
    // point a package transaction somewhere else; none is a registry this product will use.
    for (const value of [
      'https://mirror.internal/npm/registry/',
      'https://user:secret@mirror.internal/',
      'https://mirror.internal/?token=abc',
      'ftp://mirror.internal/',
      'not a url',
      'file:///C:/somewhere',
    ]) {
      withSingleEnvironment('NPM_CONFIG_REGISTRY', value, () => {
        expect(statedRegistry()).toBeUndefined()
        expect(resolveRegistrySettings(FALLBACK_CONFIG).registry).toBe('https://registry.npmjs.org/')
      })
    }
  })

  it('reads the configuration file the machine names, so the mirror settings in it come along', () => {
    withSingleEnvironment('npm_config_userconfig', 'D:\\tools\\npmrc', () => {
      expect(resolveRegistrySettings(FALLBACK_CONFIG).userConfig).toBe('D:\\tools\\npmrc')
    })
    withNoEnvironment(() => {
      expect(resolveRegistrySettings(FALLBACK_CONFIG).userConfig).toBe(FALLBACK_CONFIG)
    })
  })

  it('lets Node honour a configured proxy, which it does not by default', () => {
    withSingleEnvironment('HTTPS_PROXY', 'http://proxy.internal:3128', () => {
      const transport = registryTransportEnvironment()
      expect(transport.proxy).toBe('http://proxy.internal:3128')
      expect(transport.environment).toEqual({ NODE_USE_ENV_PROXY: '1' })
    })
    withNoEnvironment(() => {
      const transport = registryTransportEnvironment()
      expect(transport.proxy).toBeUndefined()
      expect(transport.environment).toEqual({})
    })
  })

  it('reports the trust anchor a private registry needs, without replacing the system one', () => {
    withSingleEnvironment('NODE_EXTRA_CA_CERTS', 'C:\\certs\\corp.pem', () => {
      expect(registryTransportEnvironment().caFile).toBe('C:\\certs\\corp.pem')
    })
  })
})
