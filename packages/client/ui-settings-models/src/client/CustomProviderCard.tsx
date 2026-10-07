/**
 * The card that declares a provider pi-ai does not ship — an OpenAI-compatible
 * gateway, a self-hosted server, or a provider newer than the installed
 * catalog.
 *
 * This is a create, not an edit, which is why it is its own card rather than
 * the provider editor with extra fields: the route id is being *chosen* here,
 * and the settings address does not exist until it is. One `settings.mutate`
 * sets the whole profile at `providers.<route>`; the key travels separately
 * through `credentials/set` under the reference the profile records, exactly as
 * an existing provider's key does.
 *
 * The three fields a hand-declared route cannot default — endpoint, protocol,
 * and at least one model — are required here rather than at load, so the
 * failure names the field while the user is still looking at it.
 *
 * There is deliberately no reasoning-effort control, here or on the editor
 * card: effort is a per-MODEL capability, and the models under one provider
 * disagree about it, so a provider-scoped control can only be set to a value
 * some of them reject. The composer's model picker offers each model its own
 * levels instead.
 */

import { useState } from 'react'
import type { ReactNode } from 'react'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { apiKeyFailure } from './apiKey.ts'
import { EditorFooter } from './EditorFooter.tsx'
import { validateDeepSeekModels } from './DeepSeekModelsEditor.tsx'
import { ModelListEditor } from './ModelListEditor.tsx'
import type { ModelDraft } from './ModelListEditor.tsx'
import { deriveKeyRef } from './store.ts'
import type { ModelsOperations } from './operations.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/** The settings namespace a hand-declared provider is written into. */
const NS = 'llm-pi-ai'

/**
 * A route id usable as a settings key AND as the stem of a credential name.
 * The leading letter is the second half of that: `deriveKeyRef` uppercases the
 * id and replaces every non-alphanumeric run with `_`, and a credential
 * reference is a POSIX shell identifier, which cannot start with a digit. A
 * digit-leading id passes every check this card makes and then fails at the
 * credential seam with a raw regular expression the user cannot act on.
 */
const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

function isHttpUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * One provider a hand-declared route can start from.
 *
 * `api` and `baseURL` are the values the installed pi-ai catalog declares for
 * that vendor. A preset carries neither when the catalog does not describe the
 * vendor at all, or describes it with a wire protocol this adapter does not
 * serve: a prefilled endpoint the route cannot speak to fails at request time,
 * where the user cannot see why.
 */
interface ProviderPreset {
  /** Option value; the vendor id the catalog uses where it ships one. */
  id: string
  /** Locale key of the provider name the dropdown shows. */
  labelKey: keyof typeof en
  /** Route id the preset suggests, moved aside by {@link presetRoute} when taken. */
  route: string
  /** Catalog wire protocol; absent when the catalog names an unserviceable one. */
  api?: string
  /** Catalog endpoint; absent when the catalog does not describe the provider. */
  baseURL?: string
}

/**
 * The providers offered as starting points, in the order the settings page
 * presents them.
 *
 * The suggested route ids are deliberately not the ids the catalog ships: a
 * shipped provider already occupies its own id in the provider directory, and
 * suggesting it would open this card on its taken-id error.
 */
const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  { id: 'openai', labelKey: 'presetOpenai', route: 'openai', api: 'openai-responses', baseURL: 'https://api.openai.com/v1' },
  { id: 'anthropic', labelKey: 'presetAnthropic', route: 'anthropic', api: 'anthropic-messages', baseURL: 'https://api.anthropic.com' },
  // Gemini's catalog protocol (google-generative-ai) is outside the set this
  // adapter serves, so only the name is prefilled.
  { id: 'google', labelKey: 'presetGoogle', route: 'google' },
  { id: 'xai', labelKey: 'presetXai', route: 'xai', api: 'openai-responses', baseURL: 'https://api.x.ai/v1' },
  { id: 'deepseek', labelKey: 'presetDeepseek', route: 'deepseek', api: 'openai-completions', baseURL: 'https://api.deepseek.com' },
  { id: 'moonshot', labelKey: 'presetMoonshot', route: 'moonshot', api: 'openai-completions', baseURL: 'https://api.moonshot.ai/v1' },
  { id: 'zhipu', labelKey: 'presetZhipu', route: 'zhipu', api: 'openai-completions', baseURL: 'https://api.z.ai/api/coding/paas/v4' },
  // The catalog describes Alibaba only through its token-plan endpoints, and
  // StepFun not at all.
  { id: 'qwen', labelKey: 'presetQwen', route: 'dashscope' },
  { id: 'minimax', labelKey: 'presetMinimax', route: 'minimax', api: 'anthropic-messages', baseURL: 'https://api.minimax.io/anthropic' },
  { id: 'stepfun', labelKey: 'presetStepfun', route: 'stepfun' },
]

/**
 * The route id a preset may use, moved aside when the provider directory
 * already answers to it. The suffix records what the route is: a second route
 * to a provider the catalog ships rather than a replacement for it.
 * @param base - route id the preset suggests.
 * @param taken - route ids the provider directory already holds.
 * @returns a route id no directory entry uses.
 */
function presetRoute(base: string, taken: readonly string[]): string {
  return taken.includes(base) ? `${base}-custom` : base
}

/** Props of {@link CustomProviderCard}. */
export interface CustomProviderCardProps {
  /** Route ids already declared, so the card refuses to shadow one. */
  taken: readonly string[]
  /** Wire protocols the adapter can serve, in the order it reports them. */
  protocols: readonly string[]
  /**
   * Revision of the `llm-pi-ai` user section this card opened at, sent with
   * the create so a route another tab declared meanwhile is a refusal rather
   * than a silent overwrite of its whole profile.
   */
  revision: number
  /** The Host operations this card writes and interrogates through. */
  operations: ModelsOperations
  /** Section copy. */
  t: (key: keyof typeof en) => string
  /** Disable writes (read-only settings provider). */
  readOnly: boolean
  /** Close the card; `changed` reports whether a provider was created. */
  onClose: (changed: boolean) => void
}

/**
 * Render the custom-provider creation card.
 * @param props - existing routes, protocol choices, wire faces, and copy.
 * @returns the creation card.
 */
export function CustomProviderCard(props: CustomProviderCardProps): ReactNode {
  const { taken, protocols, operations, t } = props
  // The write is checked against the revision on which this draft was opened.
  const [openedAt] = useState(() => props.revision)
  const [preset, setPreset] = useState('')
  const [route, setRoute] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [baseURL, setBaseURL] = useState('')
  const [protocol, setProtocol] = useState(protocols[0] ?? '')
  const [keyDraft, setKeyDraft] = useState('')
  const [models, setModels] = useState<readonly ModelDraft[]>([])
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  /**
   * The profile write landed. Only the key write can still be outstanding, so
   * the fields that describe the provider are settled and the retry path is
   * the credential alone.
   */
  const [committed, setCommitted] = useState(false)
  const disabled = props.readOnly || busy
  /** Everything but the key stops being editable once the provider exists. */
  const profileDisabled = disabled || committed

  const chosenPreset = PROVIDER_PRESETS.find(candidate => candidate.id === preset)
  // The preset names a provider whose endpoint the catalog does not carry, so
  // the card says why the two fields below stayed empty instead of leaving the
  // user to read the blank as a bug.
  const presetNeedsEntry = chosenPreset !== undefined && chosenPreset.baseURL === undefined

  const routeInvalid = route.length > 0 && !ROUTE_PATTERN.test(route)
  const routeTaken = taken.includes(route)
  const normalizedBaseURL = baseURL.trim()
  const baseUrlInvalid = baseURL.length > 0 && !isHttpUrl(normalizedBaseURL)
  // Rows are checked by the same per-row validator the editor cards use, so a
  // bad row is named by its position here too. Capacities have route-level
  // fallbacks; what a route cannot default is at least one model.
  const modelFailure = validateDeepSeekModels(models)
  const keyFailure = apiKeyFailure(keyDraft)
  // The typed key with paste whitespace removed. A blank field yields an empty
  // string, which the create path reads as "no key supplied" — a route may
  // legitimately authenticate through the provider's own ambient discovery.
  const keyValue = keyDraft.trim()
  const ready = route.length > 0 && !routeInvalid && !routeTaken
    && normalizedBaseURL.length > 0 && !baseUrlInvalid && models.length > 0 && modelFailure === undefined
    && keyFailure === undefined
  // The one blocked gate worth a line under the form. A satisfied card says
  // nothing at all rather than printing an empty paragraph.
  const hint = failure !== undefined || ready
    // The key field prints its own failure directly beneath itself, so a card
    // blocked only by the key stays silent here rather than answering with the
    // next unmet gate — which is satisfied, and reads as a second, false fault.
    || keyFailure !== undefined
    // Same for the route id, and it must be tested rather than assumed: the
    // fallback arm below reads "no models yet", so an unmet route gate would
    // fall through to it and contradict the filled-in list right above.
    || route.length === 0 || routeInvalid || routeTaken || baseUrlInvalid
    ? undefined
    : normalizedBaseURL.length === 0
      ? t('customNeedsBaseUrl')
      : modelFailure !== undefined
        ? `${t('model')} ${String(modelFailure.index + 1)}: ${t(modelFailure.key)}`
        : t('customNeedsModels')

  /**
   * Start the card from a preset, leaving every field editable afterwards. The
   * endpoint is cleared for a preset the catalog cannot describe rather than
   * kept from the previous selection, and the protocol is written only while
   * the adapter still reports the catalog's choice — the select below holds the
   * authority on what may be spoken.
   * @param id - selected preset id, or the empty string for no selection.
   */
  const applyPreset = (id: string): void => {
    setPreset(id)
    const chosen = PROVIDER_PRESETS.find(candidate => candidate.id === id)
    if (chosen === undefined) return
    setRoute(presetRoute(chosen.route, taken))
    setDisplayName(t(chosen.labelKey))
    setBaseURL(chosen.baseURL ?? '')
    if (chosen.api !== undefined && protocols.includes(chosen.api)) setProtocol(chosen.api)
  }

  /** Perform the create, returning a failure message or undefined. */
  const createOnce = async (): Promise<string | undefined> => {
    const keyRef = deriveKeyRef(route)
    const storesKey = keyValue.length > 0
    if (!committed) {
      const profile = {
        ...displayName.length === 0 ? {} : { displayName },
        // The profile names the conventional reference only when this card is
        // about to store a key, matching the editor: a route declared with the
        // key left blank keeps its provider-native auth path (a credential
        // chain, ADC) instead of resolving a reference nothing ever sets.
        ...storesKey ? { apiKeyEnv: keyRef } : {},
        api: protocol,
        baseURL: normalizedBaseURL,
        models: models.map(model => ({ ...model })),
      }
      // `taken` is a snapshot too, so the id check alone cannot see a route
      // declared after this card opened; the revision makes that race a
      // `settings-conflict` instead of a write over the other profile.
      const written = await operations.writeSettings(
        NS,
        [{ op: 'set', path: ['providers', route], value: profile as JsonValue }],
        openedAt,
      )
      if (written.kind !== 'written') {
        return written.kind === 'conflict' ? t('conflict') : written.message
      }
      // The provider now exists. A retry after the key write below fails must
      // not re-run this mutate: the revision it holds is the one this write
      // just superseded, so the Host would answer `settings-conflict` and the
      // key could never be stored from this card at all.
      setCommitted(true)
    }
    if (storesKey) {
      const stored = await operations.storeCredential(keyRef, keyValue)
      // The profile landed; saying the key did not is the only honest report,
      // and the retry above now goes straight back to this write.
      if (stored !== undefined) return stored
    }
    return undefined
  }

  const create = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      const outcome = await createOnce()
      if (outcome !== undefined) {
        setFailure(outcome)
        return
      }
      props.onClose(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles['editor']}>
      <div className={styles['editorHeader']}>
        <span className={styles['editorTitle']}>{t('customTitle')}</span>
      </div>
      {/* The first choice on the card: it fills the three fields below that a
          hand-declared route cannot default, and leaves the rest to the user. */}
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('customPreset')}</span>
        <select
          className={`${styles['input']} ${styles['selectInput']}`}
          value={preset}
          aria-label={t('customPreset')}
          disabled={profileDisabled}
          onChange={(event) => { applyPreset(event.target.value) }}
        >
          <option value="">{t('customPresetNone')}</option>
          {PROVIDER_PRESETS.map(choice => (
            <option key={choice.id} value={choice.id}>{t(choice.labelKey)}</option>
          ))}
        </select>
      </div>
      {presetNeedsEntry ? <p className={styles['advancedHint']}>{t('customPresetManual')}</p> : null}
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('customRoute')}</span>
        <input
          className={styles['input']}
          type="text"
          value={route}
          placeholder="acme-gateway"
          aria-label={t('customRoute')}
          disabled={profileDisabled}
          onChange={(event) => { setRoute(event.target.value) }}
        />
      </div>
      {/* A rejected id reads as a fault, not as guidance — the same split the
          key field below already makes between its failure and its hint. */}
      {routeInvalid || routeTaken
        ? <p className={styles['error']}>{t(routeInvalid ? 'customRouteInvalid' : 'customRouteTaken')}</p>
        : <p className={styles['advancedHint']}>{t('customRouteHint')}</p>}
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('customDisplayName')}</span>
        <input
          className={styles['input']}
          type="text"
          value={displayName}
          placeholder={route.length === 0 ? t('customDisplayName') : route}
          aria-label={t('customDisplayName')}
          disabled={profileDisabled}
          onChange={(event) => { setDisplayName(event.target.value) }}
        />
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('baseUrl')}</span>
        <input
          className={styles['input']}
          type="text"
          value={baseURL}
          placeholder={t('customBaseUrlPlaceholder')}
          aria-label={t('baseUrl')}
          aria-invalid={baseUrlInvalid}
          disabled={profileDisabled}
          onChange={(event) => { setBaseURL(event.target.value) }}
        />
      </div>
      {baseUrlInvalid ? <p className={styles['error']}>{t('customBaseUrlInvalid')}</p> : null}
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('customApi')}</span>
        <select
          className={`${styles['input']} ${styles['selectInput']}`}
          value={protocol}
          aria-label={t('customApi')}
          disabled={profileDisabled}
          onChange={(event) => { setProtocol(event.target.value) }}
        >
          {protocols.map(choice => <option key={choice} value={choice}>{choice}</option>)}
        </select>
      </div>
      <div className={styles['field']}>
        <span className={styles['fieldLabel']}>{t('keyInput')}</span>
        <input
          className={styles['input']}
          type="password"
          autoComplete="off"
          value={keyDraft}
          placeholder={t('keyPlaceholder')}
          aria-label={t('keyInput')}
          disabled={disabled}
          onChange={(event) => { setKeyDraft(event.target.value) }}
        />
        {/* A create card has no stored key to keep, so the blank case says
            what a blank field means here instead: this route may authenticate
            through the provider's own ambient discovery or OAuth. */}
        {keyFailure === undefined
          ? null
          : <p className={styles['error']}>{t(keyFailure === 'keyBlank' ? 'keyBlankNew' : keyFailure)}</p>}
      </div>
      <ModelListEditor
        models={models}
        onChange={setModels}
        probe={{
          settingsNs: NS,
          baseURL: normalizedBaseURL,
          api: protocol,
          ...keyValue.length === 0 ? {} : { apiKey: keyValue },
        }}
        probeBlocked={baseUrlInvalid
          ? 'customBaseUrlInvalid'
          : keyFailure === 'keyBlank' ? 'keyBlankNew' : keyFailure}
        operations={operations}
        t={t}
        disabled={profileDisabled}
      />
      {failure !== undefined ? <p className={styles['error']}>{failure}</p> : null}
      {/* Only the gates with something to say render; the route-id gate has its
          own field-level hint, so its blocked state would print an empty line. */}
      {hint === undefined ? null : <p className={styles['advancedHint']}>{hint}</p>}
      <EditorFooter
        t={t}
        busy={busy}
        submitDisabled={disabled || !ready}
        submitLabelKey="create"
        submitBusyLabelKey="creating"
        onCancel={() => { props.onClose(committed) }}
        onSubmit={() => { void create() }}
      />
    </div>
  )
}
