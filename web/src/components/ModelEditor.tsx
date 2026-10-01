import { useEffect, useRef } from 'react'
import { parse, stringify } from 'yaml'
import { modelOf, type ModelSubmission, type ModelValidation } from '../models'

/** The add/edit-a-model draft. model.yaml is captured as a structured form (its source block),
 * not raw text, and generated on submit; config.json stays a code box the user types or loads.
 * The canonical name is derived server-side from the repo's org, so it is never entered. */
export interface ModelDraft {
  dir: string
  provider: string
  repo: string
  revision: string
  retrieved: string
  configJson: string
}

export function emptyModelDraft(): ModelDraft {
  return { dir: '', provider: '', repo: '', revision: '', retrieved: '', configJson: '' }
}

/** draftModelYaml builds the model.yaml text from the form's source fields, omitting the ones
 * left blank, so the generated file carries only what was entered. */
export function draftModelYaml(draft: ModelDraft): string {
  const source: Record<string, string> = {}
  if (draft.provider) source.provider = draft.provider
  if (draft.repo) source.repo = draft.repo
  if (draft.revision) source.revision = draft.revision
  if (draft.retrieved) source.retrieved = draft.retrieved
  return stringify({ source })
}

/** draftToSubmission packages a draft for the server: the directory, the generated model.yaml,
 * and the config.json code box verbatim. */
export function draftToSubmission(draft: ModelDraft): ModelSubmission {
  return { dir: draft.dir, model_yaml: draftModelYaml(draft), config_json: draft.configJson }
}

/** sourceFieldsFromYaml reads a model.yaml's source block into the form fields, for prefilling
 * an edit or an uploaded file. A file that will not parse yields blank fields rather than
 * throwing, so a malformed upload just leaves the form empty. */
export function sourceFieldsFromYaml(raw: string): Pick<ModelDraft, 'provider' | 'repo' | 'revision' | 'retrieved'> {
  try {
    const doc = parse(raw) as { source?: Record<string, unknown> } | null
    const s = doc?.source ?? {}
    const str = (v: unknown) => (typeof v === 'string' ? v : '')
    return { provider: str(s.provider), repo: str(s.repo), revision: str(s.revision), retrieved: str(s.retrieved) }
  } catch {
    return { provider: '', repo: '', revision: '', retrieved: '' }
  }
}

/** draftFromDetail builds the editor draft from a model's own files (for the edit flow): the
 * directory from its canonical name, the source fields parsed from its raw model.yaml, and its
 * config.json into the code box. */
export function draftFromDetail(name: string, modelYaml: string, configJson: string): ModelDraft {
  return { dir: modelOf(name), ...sourceFieldsFromYaml(modelYaml), configJson }
}

interface Props {
  draft: ModelDraft
  /** The canonical name being edited, or null when adding. When set, the directory is the
   * model's identity and cannot be renamed in place. */
  editingName: string | null
  verdict: ModelValidation | null
  validating: boolean
  saving: boolean
  saveError: string | null
  onChange: (draft: ModelDraft) => void
  onValidate: () => void
  onSave: () => void
  onCancel: () => void
}

// Qwen-model placeholder hints, so a reader sees the shape each field expects.
const EG = {
  dir: 'qwen3-14b',
  provider: 'huggingface',
  repo: 'Qwen/Qwen3-14B',
  revision: 'main',
  retrieved: '2026-10-01',
  config: `{
  "architectures": ["Qwen3ForCausalLM"],
  "hidden_size": 5120,
  "num_hidden_layers": 40,
  "num_attention_heads": 40,
  "num_key_value_heads": 8,
  "max_position_embeddings": 40960,
  "torch_dtype": "bfloat16"
}`,
}

/**
 * The add/edit-a-model modal: a form for the model.yaml source block, a code box for the raw
 * config.json, each with an Upload button to load a file instead of typing, and Validate /
 * Save actions. The model is validated against the server (which runs blis to prove it loads)
 * before Save is enabled.
 *
 * Passing validation means blis accepted the files, not that the model is correct or its
 * numbers trustworthy, so the modal carries that caveat beside Save.
 */
export function ModelEditor({
  draft,
  editingName,
  verdict,
  validating,
  saving,
  saveError,
  onChange,
  onValidate,
  onSave,
  onCancel,
}: Props) {
  const saveDisabled = !verdict?.ok || saving
  const set = (key: keyof ModelDraft, value: string) => onChange({ ...draft, [key]: value })
  const yamlFile = useRef<HTMLInputElement>(null)
  const jsonFile = useRef<HTMLInputElement>(null)

  // Escape closes, matching the scrim click, the same two escape hatches ConfirmDialog gives.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const uploadYaml = (file: File | undefined) => {
    if (file) file.text().then((text) => onChange({ ...draft, ...sourceFieldsFromYaml(text) }))
  }
  const uploadJson = (file: File | undefined) => {
    if (file) file.text().then((text) => onChange({ ...draft, configJson: text }))
  }

  const titleId = 'model-editor-title'
  return (
    <div
      className="modal-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="modal modal-wide" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className="modal-title">
          {editingName ? `Edit ${editingName}` : 'Add a model'}
        </h2>
        {/* The .editor class brings the shared form-field styling (.editor .field/label/input/
            textarea) inside the modal; its own base is only max-width, so it adds no chrome. */}
        <div className="editor">
        <p className="dek">
          Onboard your own model from its model.yaml and config.json. It is added under a new
          directory name and appears in the picker. It is yours: it persists across restarts and
          wins over the base catalog if a later update ships the same name.
        </p>

        <div className="field editor-name">
          <label htmlFor="me-dir">Directory name</label>
          <input
            id="me-dir"
            name="dir"
            className="mono"
            placeholder={EG.dir}
            value={draft.dir}
            disabled={editingName !== null}
            onChange={(e) => set('dir', e.target.value)}
          />
          <p className="dek">
            Lower-case letters, digits, dash, underscore or dot. The canonical name is this plus
            the org from the repo below, e.g. <code className="mono">qwen/{EG.dir}</code>.
          </p>
        </div>

        <fieldset className="knobs">
          <legend>model.yaml</legend>
          <p className="dek">
            Provenance: where the model&apos;s weights come from. The org half of the repo (before
            the slash) becomes the name prefix.
          </p>
          <div className="field-row">
            <div className="field">
              <label htmlFor="me-provider">Provider</label>
              <input
                id="me-provider"
                name="provider"
                placeholder={EG.provider}
                value={draft.provider}
                onChange={(e) => set('provider', e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="me-repo">Repo (org/model)</label>
              <input
                id="me-repo"
                name="repo"
                className="mono"
                placeholder={EG.repo}
                value={draft.repo}
                onChange={(e) => set('repo', e.target.value)}
              />
            </div>
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="me-revision">Revision</label>
              <input
                id="me-revision"
                name="revision"
                className="mono"
                placeholder={EG.revision}
                value={draft.revision}
                onChange={(e) => set('revision', e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="me-retrieved">Retrieved</label>
              <input
                id="me-retrieved"
                name="retrieved"
                className="mono"
                placeholder={EG.retrieved}
                value={draft.retrieved}
                onChange={(e) => set('retrieved', e.target.value)}
              />
            </div>
          </div>
          <button type="button" className="upload-btn" onClick={() => yamlFile.current?.click()}>
            Upload model.yaml
          </button>
          <input
            ref={yamlFile}
            type="file"
            accept=".yaml,.yml"
            className="hidden-file"
            onChange={(e) => uploadYaml(e.target.files?.[0])}
          />
        </fieldset>

        <fieldset className="knobs">
          <legend>config.json</legend>
          <p className="dek">
            The model architecture blis reads. This is a code box: paste or type the raw
            config.json (JSON), or load it from a file.
          </p>
          <textarea
            id="me-config-json"
            name="config_json"
            className="mono"
            aria-label="config.json"
            spellCheck={false}
            placeholder={EG.config}
            value={draft.configJson}
            onChange={(e) => set('configJson', e.target.value)}
          />
          <button type="button" className="upload-btn" onClick={() => jsonFile.current?.click()}>
            Upload config.json
          </button>
          <input
            ref={jsonFile}
            type="file"
            accept=".json"
            className="hidden-file"
            onChange={(e) => uploadJson(e.target.files?.[0])}
          />
        </fieldset>

        {verdict && (
          <div className="verdict">
            {verdict.ok ? (
              <p>
                <strong className="mono">{verdict.canonical_name}</strong>
                {verdict.provider && <> from {verdict.provider}</>}, {verdict.moe ? 'MoE' : 'dense'}.
                blis loaded it.
              </p>
            ) : (
              verdict.issues.map((msg, i) => (
                <p className="issue" key={i}>
                  {msg}
                </p>
              ))
            )}
          </div>
        )}

        <p className="dek note">
          A model that validates may not run or rank reliably. Validation only means blis accepted
          the files, not that the config is correct or its numbers trustworthy. Verify an ingested
          model&apos;s results before relying on them.
        </p>

        {saveError && <p className="issue">{saveError}</p>}

        <div className="editor-actions">
          <button type="button" onClick={onValidate} disabled={validating}>
            {validating ? 'Validating…' : 'Validate'}
          </button>
          <button type="button" className="primary" onClick={onSave} disabled={saveDisabled}>
            {saving ? 'Saving…' : editingName ? 'Save changes' : 'Add model'}
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
        </div>
      </div>
    </div>
  )
}
