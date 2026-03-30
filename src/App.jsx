import { useState, useEffect, useRef, useCallback } from 'react'
import swordsLogo from './assets/swords-battle.svg'

const DEFAULT_HOST = 'localhost'
const DEFAULT_PORT = '1234'
const API_PATH = '/v1'
const DEFAULT_PROMPT = 'Draw an animated red spining cube. Do not comment , answer exclusively with the code. Use html,css and js.'
const MAX_HISTORY = 50

function newBattleId() {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `b-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

function createSideResult(p) {
  return {
    output: p.output,
    durationSeconds: p.durationSeconds,
    stats: p.stats ?? null,
    modelInstanceId: p.modelInstanceId ?? null,
    modelKey: p.modelKey
  }
}

/** `/api/v1/chat` stats + OpenAI-style usage fallback */
function normalizeStats(data) {
  const s = data?.stats
  if (s && typeof s === 'object') {
    const modelLoadReported = Object.prototype.hasOwnProperty.call(s, 'model_load_time_seconds')
    return {
      statsSource: 'lm',
      inputTokens: numOrNull(s.input_tokens),
      totalOutputTokens: numOrNull(s.total_output_tokens),
      reasoningOutputTokens: numOrNull(s.reasoning_output_tokens),
      tokensPerSecond: numOrNull(s.tokens_per_second),
      timeToFirstTokenSeconds: numOrNull(s.time_to_first_token_seconds),
      modelLoadTimeSeconds: numOrNull(s.model_load_time_seconds),
      modelLoadReported
    }
  }
  const u = data?.usage
  if (u && typeof u === 'object') {
    return {
      statsSource: 'usage',
      inputTokens: numOrNull(u.prompt_tokens),
      totalOutputTokens: numOrNull(u.completion_tokens),
      reasoningOutputTokens: numOrNull(u.completion_tokens_details?.reasoning_tokens),
      tokensPerSecond: null,
      timeToFirstTokenSeconds: null,
      modelLoadTimeSeconds: null,
      modelLoadReported: false
    }
  }
  return null
}

function numOrNull(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function extractLastMessageText(data) {
  const out = data?.output
  if (Array.isArray(out)) {
    for (let i = out.length - 1; i >= 0; i--) {
      const item = out[i]
      if (item?.type === 'message' && typeof item.content === 'string') {
        return item.content
      }
    }
    const last = out[out.length - 1]
    if (typeof last?.content === 'string') return last.content
  }
  const lastChoice = Array.isArray(data?.choices)
    ? data.choices[data.choices.length - 1]
    : undefined
  return (
    lastChoice?.message?.content ||
    lastChoice?.text ||
    null
  )
}

function formatStat(n, decimals) {
  if (n == null || !Number.isFinite(n)) return '—'
  return n.toFixed(decimals)
}

/** Some servers omit `model_load_time_seconds` when model is already loaded. */
function formatModelLoadValue(stats) {
  if (stats == null) return { text: '—', muted: false }
  if (stats.statsSource !== 'lm') return { text: '—', muted: false }
  if (stats.modelLoadReported && stats.modelLoadTimeSeconds != null) {
    return { text: `${formatStat(stats.modelLoadTimeSeconds, 2)} s`, muted: false }
  }
  if (!stats.modelLoadReported) {
    return { text: 'Already loaded', muted: true }
  }
  return { text: '—', muted: false }
}

function StatsStrip(p) {
  const { stats, wallSeconds } = p
  const modelLoad = formatModelLoadValue(stats)

  return (
    <div className="stats-strip" aria-label="Response metrics">
      <div className="stat-item">
        <span className="stat-label">Wall time</span>
        <span className="stat-value">{formatStat(wallSeconds, 2)} s</span>
      </div>
      <div className="stat-item">
        <span className="stat-label">TTFT</span>
        <span className="stat-value">
          {stats?.timeToFirstTokenSeconds != null
            ? `${formatStat(stats.timeToFirstTokenSeconds, 3)} s`
            : '—'}
        </span>
      </div>
      <div className="stat-item">
        <span className="stat-label">Tokens / sec</span>
        <span className="stat-value">
          {stats?.tokensPerSecond != null ? formatStat(stats.tokensPerSecond, 1) : '—'}
        </span>
      </div>
      <div className="stat-item">
        <span className="stat-label">Input tokens</span>
        <span className="stat-value">
          {stats?.inputTokens != null ? String(Math.round(stats.inputTokens)) : '—'}
        </span>
      </div>
      <div className="stat-item">
        <span className="stat-label">Output tokens</span>
        <span className="stat-value">
          {stats?.totalOutputTokens != null ? String(Math.round(stats.totalOutputTokens)) : '—'}
        </span>
      </div>
      <div className="stat-item">
        <span className="stat-label">Reasoning tok.</span>
        <span className="stat-value">
          {stats?.reasoningOutputTokens != null
            ? String(Math.round(stats.reasoningOutputTokens))
            : '—'}
        </span>
      </div>
      <div className="stat-item">
        <span className="stat-label">Model load</span>
        <span
          className={
            modelLoad.muted ? 'stat-value stat-value--muted' : 'stat-value'
          }
        >
          {modelLoad.text}
        </span>
      </div>
      {stats == null && (
        <p className="stats-strip-note">
          No <code className="stats-code">stats</code> in this response — TTFT and tokens/s come from
          the server <code className="stats-code">stats</code> object.
        </p>
      )}
    </div>
  )
}

function formatHistoryTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  } catch {
    return ''
  }
}

function truncatePrompt(text, max) {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  return `${t.slice(0, max - 1)}…`
}

function buildApiBase(host, port) {
  const normalizedHost = host.trim() || DEFAULT_HOST
  const normalizedPort = port.trim() || DEFAULT_PORT
  return `http://${normalizedHost}:${normalizedPort}${API_PATH}`
}

function extractModelArray(payload) {
  if (Array.isArray(payload)) return payload
  if (Array.isArray(payload?.models)) return payload.models
  if (Array.isArray(payload?.data)) return payload.data
  return []
}

function normalizeModelList(payload) {
  return extractModelArray(payload)
    .map((m) => {
      const key = typeof m?.key === 'string' ? m.key : (typeof m?.id === 'string' ? m.id : '')
      if (!key) return null
      const label =
        typeof m?.key === 'string'
          ? m.key
          : (typeof m?.id === 'string' ? m.id : key)
      return { key, label }
    })
    .filter(Boolean)
}

function App() {
  const [models, setModels] = useState([])
  const [loadingModels, setLoadingModels] = useState(false)
  const [host, setHost] = useState(DEFAULT_HOST)
  const [port, setPort] = useState(DEFAULT_PORT)
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT)
  const [modelA, setModelA] = useState('')
  const [modelB, setModelB] = useState('')
  /** Completed runs, newest first. Each item is one Run (same prompt, both sides). */
  const [battles, setBattles] = useState([])
  /** In-flight run: show these panels until commit to `battles`, then cleared. */
  const [wip, setWip] = useState(null)
  const [loadingA, setLoadingA] = useState(false)
  const [loadingB, setLoadingB] = useState(false)
  const [error, setError] = useState(null)
  const abortControllerRef = useRef(null)
  const requestIdRef = useRef(0)
  const apiBase = buildApiBase(host, port)

  const fetchModels = useCallback(async () => {
    try {
      setLoadingModels(true)
      const response = await fetch(`${buildApiBase(host, port)}/models`)
      const data = await response.json()
      setModels(normalizeModelList(data))
    } catch (err) {
      setError('Failed to load models from server')
    } finally {
      setLoadingModels(false)
    }
  }, [host, port])

  useEffect(() => {
    fetchModels()
  }, [fetchModels])

  async function fetchServerModels() {
    const response = await fetch(`${apiBase}/models`)
    const data = await response.json()
    return extractModelArray(data)
  }

  async function unloadAllOthersExcept(keepKeys, abortController) {
    const serverModels = await fetchServerModels()
    const keep = new Set(keepKeys)

    for (const m of serverModels || []) {
      const modelKey =
        typeof m?.key === 'string' ? m.key : (typeof m?.id === 'string' ? m.id : null)
      if (modelKey && keep.has(modelKey)) continue

      const loaded = Array.isArray(m.loaded_instances) ? m.loaded_instances : []
      for (const inst of loaded) {
        const instanceId = inst?.instance_id || inst?.instanceId || inst?.id
        if (!instanceId) continue

        await fetch(`${apiBase}/models/unload`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: abortController?.signal,
          body: JSON.stringify({ instance_id: instanceId })
        })
      }
    }
  }

  async function handleSubmit() {
    if (!prompt.trim()) {
      setError('Please enter a prompt')
      return
    }
    const hasA = Boolean(modelA)
    const hasB = Boolean(modelB)
    if (!hasA && !hasB) {
      setError('Please select at least one model (Model A and/or Model B).')
      return
    }

    // Cancel any in-flight generation before starting a new one.
    requestIdRef.current += 1
    const currentRequestId = requestIdRef.current
    if (abortControllerRef.current) abortControllerRef.current.abort()
    abortControllerRef.current = new AbortController()

    setError(null)

    const keepKeys = [modelA, modelB].filter((k) => Boolean(k))
    try {
      await unloadAllOthersExcept(keepKeys, abortControllerRef.current)
    } catch (err) {
      if (err?.name === 'AbortError') {
        return
      }
      setError(
        `Could not unload other models (${err.message}). Continuing with your run.`
      )
    }

    if (requestIdRef.current !== currentRequestId) {
      return
    }

    const runPrompt = prompt.trim()
    let acc = {
      prompt: runPrompt,
      modelKeyA: hasA ? modelA : null,
      modelKeyB: hasB ? modelB : null,
      sideA: null,
      sideB: null
    }
    setWip({ ...acc })
    if (hasA) {
      setLoadingA(true)
    } else {
      setLoadingA(false)
    }
    if (hasB) {
      setLoadingB(true)
    } else {
      setLoadingB(false)
    }

    function pushBattleFromAcc() {
      if (!(acc.sideA || acc.sideB)) return
      if (requestIdRef.current !== currentRequestId) return
      const id = newBattleId()
      setBattles((prev) =>
        [
          {
            id,
            at: Date.now(),
            prompt: acc.prompt,
            modelKeyA: acc.modelKeyA,
            modelKeyB: acc.modelKeyB,
            sideA: acc.sideA,
            sideB: acc.sideB
          },
          ...prev
        ].slice(0, MAX_HISTORY)
      )
    }

    if (hasA) {
      try {
        const t0 = performance.now()
        const result = await callModel(modelA, prompt, abortControllerRef.current)
        const elapsedSeconds = (performance.now() - t0) / 1000
        if (requestIdRef.current === currentRequestId) {
          acc = {
            ...acc,
            sideA: createSideResult({
              output: result.text,
              durationSeconds: elapsedSeconds,
              stats: result.stats,
              modelInstanceId: result.modelInstanceId,
              modelKey: modelA
            })
          }
          setWip({ ...acc })
        }
      } catch (err) {
        if (err?.name !== 'AbortError') {
          setError(`Error from Model A: ${err.message}`)
        }
      } finally {
        if (requestIdRef.current === currentRequestId) setLoadingA(false)
      }
    }

    /** Stale run: do not call setWip(null) — a newer submit may already own wip. */
    if (requestIdRef.current !== currentRequestId) {
      return
    }

    if (!hasB) {
      pushBattleFromAcc()
      setWip(null)
      return
    }

    if (hasB) {
      try {
        const t0 = performance.now()
        const result = await callModel(modelB, prompt, abortControllerRef.current)
        const elapsedSeconds = (performance.now() - t0) / 1000
        if (requestIdRef.current === currentRequestId) {
          acc = {
            ...acc,
            sideB: createSideResult({
              output: result.text,
              durationSeconds: elapsedSeconds,
              stats: result.stats,
              modelInstanceId: result.modelInstanceId,
              modelKey: modelB
            })
          }
          setWip({ ...acc })
        }
      } catch (err) {
        if (err?.name !== 'AbortError') {
          setError(`Error from Model B: ${err.message}`)
        }
      } finally {
        if (requestIdRef.current === currentRequestId) setLoadingB(false)
      }
    }

    if (requestIdRef.current !== currentRequestId) {
      return
    }

    pushBattleFromAcc()
    setWip(null)
  }

  async function handleReset() {
    requestIdRef.current += 1
    if (abortControllerRef.current) abortControllerRef.current.abort()
    abortControllerRef.current = null

    setLoadingA(false)
    setLoadingB(false)
    setBattles([])
    setWip(null)
    setError(null)

    const cleanupController = new AbortController()
    try {
      await unloadAllOthersExcept([], cleanupController)
    } catch (err) {
      setError(`Reset cleanup failed: ${err.message}`)
    }
  }

  function handleStop() {
    requestIdRef.current += 1
    if (abortControllerRef.current) abortControllerRef.current.abort()
    abortControllerRef.current = null
    setLoadingA(false)
    setLoadingB(false)
    setWip(null)
  }

  async function callModel(modelName, userPrompt, abortController) {
    const response = await fetch(`${apiBase}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      signal: abortController?.signal,
      body: JSON.stringify({
        model: modelName,
        messages: [{ role: 'user', content: userPrompt }],
        stream: false
      })
    })

    if (!response.ok) {
      const errText = await response.text()
      throw new Error(errText || `HTTP ${response.status}`)
    }

    const data = await response.json()
    const text =
      extractLastMessageText(data) ||
      (Array.isArray(data?.output)
        ? data.output[data.output.length - 1]?.content
        : undefined) ||
      'No response generated'
    const stats = normalizeStats(data)

    return {
      text,
      stats,
      modelInstanceId:
        typeof data?.model_instance_id === 'string' ? data.model_instance_id : null
    }
  }

  function handleModelChange(e, setModel) {
    setModel(e.target.value)
  }

  function toPreviewHtml(rawOutput) {
    if (!rawOutput) return ''

    const trimmed = rawOutput.trim()

    // Some models wrap HTML in markdown fences; strip them for preview.
    const fenceMatch = trimmed.match(/^```(?:html)?\s*([\s\S]*?)\s*```$/i)
    return fenceMatch ? fenceMatch[1] : trimmed
  }

  function renderOutputPreview(p) {
    const {
      output,
      loading,
      loadingText,
      placeholder,
      stats,
      wallSeconds,
      modelInstanceId,
      compactPreview,
      accordionStatsAndCode
    } = p

    const hasStaleOutput = Boolean(output && String(output).trim())

    if (loading && !hasStaleOutput) {
      return (
        <div className="output-body">
          <div className="loading" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            <span>{loadingText}</span>
          </div>
        </div>
      )
    }

    if (!output && !loading) {
      return (
        <div className="output-body">
          <div className="empty-state">
            <p className="empty-state-text">{placeholder}</p>
          </div>
        </div>
      )
    }

    return (
      <div className="output-body">
        {loading && hasStaleOutput ? (
          <div className="loading-inline" role="status" aria-live="polite">
            <span className="spinner" aria-hidden="true" />
            <span>{loadingText}</span>
          </div>
        ) : null}
        <div className="preview-chrome">
          <span className="chrome-label">Live preview</span>
          <iframe
            title="Model output preview"
            className={
              compactPreview ? 'preview-iframe preview-iframe--compact' : 'preview-iframe'
            }
            sandbox="allow-scripts"
            srcDoc={toPreviewHtml(output)}
          />
        </div>
        {accordionStatsAndCode ? (
          <>
            <details className="output-accordion">
              <summary className="output-accordion-summary">Stats</summary>
              <div className="output-accordion-panel">
                <StatsStrip stats={stats} wallSeconds={wallSeconds} />
                {modelInstanceId ? (
                  <p className="instance-id-hint" title={modelInstanceId}>
                    <span className="instance-id-label">model_instance_id</span>{' '}
                    <code className="instance-id-code">{modelInstanceId}</code>
                  </p>
                ) : null}
              </div>
            </details>
            <details className="output-accordion">
              <summary className="output-accordion-summary">Raw output</summary>
              <div className="output-accordion-panel">
                <textarea className="output-box" value={output} readOnly rows={16} />
              </div>
            </details>
          </>
        ) : (
          <>
            <div className="stats-chrome">
              <span className="chrome-label">Stats</span>
              <StatsStrip stats={stats} wallSeconds={wallSeconds} />
              {modelInstanceId ? (
                <p className="instance-id-hint" title={modelInstanceId}>
                  <span className="instance-id-label">model_instance_id</span>{' '}
                  <code className="instance-id-code">{modelInstanceId}</code>
                </p>
              ) : null}
            </div>
            <div className="code-chrome">
              <span className="chrome-label">Raw output</span>
              <textarea className="output-box" value={output} readOnly rows={16} />
            </div>
          </>
        )}
      </div>
    )
  }

  function BattlePastCard(p) {
    const { battle } = p
    return (
      <article className="battle-past-card battle-past-card--duel arena-wrap arena-wrap--merged">
        <div
          className="arena-battle-prompt-top"
          aria-label="Prompt for this battle"
        >
          <div className="battle-prompt-badge">
            <div className="battle-prompt-badge-inner battle-prompt-badge-inner--past">
              <span className="battle-past-time-abs">{formatHistoryTime(battle.at)}</span>
              <div className="battle-prompt-badge-heading">
                <img
                  className="battle-prompt-swords"
                  src={swordsLogo}
                  alt=""
                  width={22}
                  height={22}
                  decoding="async"
                />
                <span className="battle-prompt-badge-label">Battle prompt</span>
              </div>
              <p className="" title={battle.prompt}>
                {battle.prompt}
              </p>
            </div>
            <div className="arena-duel-accent" aria-hidden="true" />
          </div>
        </div>
        <div className="battle-past-arena battle-past-arena--merged">
          <div className="battle-past-panel battle-past-panel--a battle-past-panel--merged-a">
            <div className="battle-past-panel-label">Model A · {battle.modelKeyA || '—'}</div>
            {battle.sideA ? (
              renderOutputPreview({
                output: battle.sideA.output,
                loading: false,
                loadingText: '',
                placeholder: '',
                stats: battle.sideA.stats,
                wallSeconds: battle.sideA.durationSeconds,
                modelInstanceId: battle.sideA.modelInstanceId,
                compactPreview: true,
                accordionStatsAndCode: true
              })
            ) : (
              <div className="battle-past-skip">No model A</div>
            )}
          </div>
          <div className="battle-past-panel battle-past-panel--b battle-past-panel--merged-b">
            <div className="battle-past-panel-label">Model B · {battle.modelKeyB || '—'}</div>
            {battle.sideB ? (
              renderOutputPreview({
                output: battle.sideB.output,
                loading: false,
                loadingText: '',
                placeholder: '',
                stats: battle.sideB.stats,
                wallSeconds: battle.sideB.durationSeconds,
                modelInstanceId: battle.sideB.modelInstanceId,
                compactPreview: true,
                accordionStatsAndCode: true
              })
            ) : (
              <div className="battle-past-skip">No model B</div>
            )}
          </div>
        </div>
      </article>
    )
  }

  const isRunning = loadingA || loadingB
  let submitLabel = 'Run'
  if (isRunning) {
    submitLabel = 'Rerun'
  }

  function mainArenaSide(sideKey, modelKeyThisRun, modelKeyLatestBattle) {
    const modelKeyForSide = wip != null ? modelKeyThisRun : modelKeyLatestBattle
    if (!modelKeyForSide) return null
    if (wip != null) {
      const fresh = wip[sideKey]
      if (fresh != null) return fresh
      /** Do not fall back to the previous battle — avoids stale preview while the new run loads. */
      return null
    }
    return battles[0]?.[sideKey] ?? null
  }

  const entryA = mainArenaSide(
    'sideA',
    wip?.modelKeyA ?? null,
    battles[0]?.modelKeyA ?? null
  )
  const entryB = mainArenaSide(
    'sideB',
    wip?.modelKeyB ?? null,
    battles[0]?.modelKeyB ?? null
  )
  const headerPrompt =
    wip != null ? wip.prompt : (battles[0]?.prompt ?? '')
  const outputA = entryA?.output ?? ''
  const outputB = entryB?.output ?? ''
  /** While a run is in flight, treat the former "current" battle as history too. */
  const pastBattles = wip != null ? battles : battles.slice(1)
  const showBattlePromptBanner =
    Boolean(headerPrompt) &&
    (loadingA || loadingB || entryA || entryB)

  return (
    <div className="app">
      <main className="app-main">
        <header className="app-header">
          <div className="app-api-config" aria-label="API server">
            <span className="app-api-config-label" title="Host:port for API server">
              API
            </span>
            <input
              id="arena-host"
              className="app-api-config-input"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="localhost"
              autoComplete="off"
              spellCheck="false"
              aria-label="API host"
            />
            <span className="app-api-config-sep" aria-hidden="true">
              :
            </span>
            <input
              id="arena-port"
              className="app-api-config-input app-api-config-input--port"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              placeholder="1234"
              inputMode="numeric"
              autoComplete="off"
              spellCheck="false"
              aria-label="API port"
            />
            <span className="app-api-config-note" title="Supports OpenAI-compatible API spec">
              OpenAI spec
            </span>
          </div>
          <div className="app-brand">
            <img
              className="app-logo"
              src={swordsLogo}
              alt=""
              width={56}
              height={56}
              decoding="async"
            />
            <h1 className="app-title">Local LLM Arena</h1>
          </div>
          <p className="app-tagline">
            Compare your local LLM models
          </p>
        </header>

        <section className="composer" aria-label="Prompt and actions">
          <div className="composer-head">
            <label className="field-label" htmlFor="arena-prompt">
              Prompt
            </label>
          </div>
          <textarea
            id="arena-prompt"
            className="prompt-field"
            placeholder="Describe what to build (e.g. a red cube with CSS 3D transform)…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={2}
          />
          <div className="composer-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSubmit}
              title={
                isRunning
                  ? 'Annule les requêtes en cours et relance avec le prompt actuel'
                  : 'Lancer le duel'
              }
            >
              {submitLabel}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleStop}
              disabled={!isRunning}
            >
              Stop
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={handleReset}
              disabled={isRunning}
            >
              Reset &amp; unload
            </button>
          </div>
        </section>

        {error && (
          <div className="alert" role="alert">
            <svg
              className="alert-icon"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v4M12 16h.01" />
            </svg>
            <span>{error}</span>
          </div>
        )}

        <div
          className={
            showBattlePromptBanner ? 'arena-wrap arena-wrap--merged' : 'arena-wrap'
          }
        >
          {showBattlePromptBanner ? (
            <div
              className="arena-battle-prompt-top"
              aria-label="Prompt for this battle"
            >
              <div className="battle-prompt-badge">
                <div className="battle-prompt-badge-inner">
                  <div className="battle-prompt-badge-heading">
                    <img
                      className="battle-prompt-swords"
                      src={swordsLogo}
                      alt=""
                      width={22}
                      height={22}
                      decoding="async"
                    />
                    <span className="battle-prompt-badge-label">Battle prompt</span>
                  </div>
                  <p className="battle-prompt-badge-text" title={headerPrompt}>
                    {truncatePrompt(headerPrompt, 220)}
                  </p>
                </div>
                <div className="arena-duel-accent" aria-hidden="true" />
              </div>
            </div>
          ) : null}

          <div className="arena">
            <article className="arena-panel arena-panel--a" aria-label="Model A">
              <div className="panel-toolbar">
              <span className="panel-badge" aria-hidden="true">
                A
              </span>
              <div className="panel-meta">
                <p className="panel-title">Model A</p>
                <select
                  className="model-select"
                  value={modelA || ''}
                  disabled={loadingModels}
                  onChange={(e) => handleModelChange(e, setModelA)}
                  aria-label="Model A"
                >
                  {loadingModels ? (
                    <option value="" disabled>
                      Loading models…
                    </option>
                  ) : (
                    <>
                      <option value="">Select model</option>
                      {models.map((m) => (
                        <option key={m.key} value={m.key}>
                          {m.label}
                        </option>
                      ))}
                    </>
                  )}
                </select>
              </div>
              </div>

              <div className="output-section">
              
                {renderOutputPreview({
                  output: outputA,
                  loading: loadingA,
                  loadingText: 'Generating with model A…',
                  placeholder: 'Run to show output from model A.',
                  stats: entryA?.stats ?? null,
                  wallSeconds: entryA?.durationSeconds ?? 0,
                  modelInstanceId: entryA?.modelInstanceId ?? null
                })}
              </div>
            </article>

            <article className="arena-panel arena-panel--b" aria-label="Model B">
              <div className="panel-toolbar">
              <span className="panel-badge" aria-hidden="true">
                B
              </span>
              <div className="panel-meta">
                <p className="panel-title">Model B</p>
                <select
                  className="model-select"
                  value={modelB || ''}
                  disabled={loadingModels}
                  onChange={(e) => handleModelChange(e, setModelB)}
                  aria-label="Model B"
                >
                  {loadingModels ? (
                    <option value="" disabled>
                      Loading models…
                    </option>
                  ) : (
                    <>
                      <option value="">Select model</option>
                      {models.map((m) => (
                        <option key={m.key} value={m.key}>
                          {m.label}
                        </option>
                      ))}
                    </>
                  )}
                </select>
              </div>
              </div>

              <div className="output-section">
               
                {renderOutputPreview({
                  output: outputB,
                  loading: loadingB,
                  loadingText: 'Generating with model B…',
                  placeholder: 'Run to show output from model B.',
                  stats: entryB?.stats ?? null,
                  wallSeconds: entryB?.durationSeconds ?? 0,
                  modelInstanceId: entryB?.modelInstanceId ?? null
                })}
              </div>
            </article>
          </div>
        </div>

        {pastBattles.length > 0 && (
          <section className="battle-history" aria-label="Previous battles">
            <h2 className="battle-history-heading">Previous battles</h2>
            <p className="battle-history-sub">
              Older runs stack below — scroll the page to compare earlier matchups.
            </p>
            <div className="battle-history-stack">
              {pastBattles.map((battle) => (
                <BattlePastCard key={battle.id} battle={battle} />
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  )
}

export default App
