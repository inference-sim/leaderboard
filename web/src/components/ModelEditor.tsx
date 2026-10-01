import type { ModelValidation } from '../models'

/** The three things a model submission carries: a directory name and the two file bodies. The
 * canonical name is derived server-side from model.yaml, so it is never entered here. */
export interface ModelDraft {
  dir: string
  modelYaml: string
  configJson: string
}

interface Props {
  draft: ModelDraft
  /** The canonical name being edited, or null when adding a new model. When set, the
   * directory is the model's identity and cannot be renamed in place. */
  editingName: string | null
  /** The server's last validate verdict, or null before one has returned. */
  verdict: ModelValidation | null
  validating: boolean
  saving: boolean
  saveError: string | null
  onChange: (draft: ModelDraft) => void
  onValidate: () => void
  onSave: () => void
  onCancel: () => void
}

/**
 * The add/edit-a-model editor: a directory name and the model.yaml and config.json a user
 * pastes or loads from disk, validated against the server (which runs blis to prove the model
 * loads) before Save is enabled. It mirrors the WorkloadEditor's idiom and reuses its classes.
 *
 * Passing validation means blis accepted the files, not that the model is correct or its
 * numbers trustworthy, so the editor carries that caveat beside Save.
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

  // Load a local file's text into a field, so a user can pick model.yaml / config.json rather
  // than paste. The picked file never leaves the browser until Save posts its text.
  const loadInto = (file: File | undefined, key: keyof ModelDraft) => {
    if (file) file.text().then((text) => set(key, text))
  }

  return (
    <section className="editor">
      <div className="editor-head">
        <h2>{editingName ? `Edit ${editingName}` : 'Add a model'}</h2>
      </div>

      <p className="dek">
        Paste or load a <code className="mono">model.yaml</code> and a{' '}
        <code className="mono">config.json</code>. The model is added to the catalog under a new
        directory name and appears in the picker. It is yours: it persists across restarts and
        wins over the base catalog if a later update ships the same name.
      </p>

      <div className="name-row">
        <div className="field editor-name">
          <label htmlFor="me-dir">Directory name</label>
          <input
            id="me-dir"
            name="dir"
            className="mono"
            placeholder="my-model"
            value={draft.dir}
            disabled={editingName !== null}
            onChange={(e) => set('dir', e.target.value)}
          />
          <p className="dek">
            Lower-case letters, digits, dash, underscore or dot. The canonical name is this plus
            the org from model.yaml ({'<org>/<directory>'}).
          </p>
        </div>
      </div>

      <fieldset className="knobs">
        <legend>model.yaml</legend>
        <p className="dek">
          Provenance: where the weights come from. The org half of <code className="mono">source.repo</code>{' '}
          becomes the model name prefix.
        </p>
        <textarea
          id="me-model-yaml"
          name="model_yaml"
          className="mono"
          aria-label="model.yaml"
          spellCheck={false}
          value={draft.modelYaml}
          onChange={(e) => set('modelYaml', e.target.value)}
        />
        <label className="file-load">
          Load from file
          <input
            type="file"
            accept=".yaml,.yml"
            onChange={(e) => loadInto(e.target.files?.[0], 'modelYaml')}
          />
        </label>
      </fieldset>

      <fieldset className="knobs">
        <legend>config.json</legend>
        <p className="dek">The model architecture blis reads.</p>
        <textarea
          id="me-config-json"
          name="config_json"
          className="mono"
          aria-label="config.json"
          spellCheck={false}
          value={draft.configJson}
          onChange={(e) => set('configJson', e.target.value)}
        />
        <label className="file-load">
          Load from file
          <input
            type="file"
            accept=".json"
            onChange={(e) => loadInto(e.target.files?.[0], 'configJson')}
          />
        </label>
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
    </section>
  )
}
