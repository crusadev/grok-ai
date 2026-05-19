import { useState } from 'react';
import type { SubmitInput } from './api';

const COUNTRIES = ['ca', 'us', 'gb', 'de', 'fr', 'nl', 'jp', 'au', 'br', 'in'];

function Toggle({
  label,
  on,
  onChange,
}: {
  label: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={`toggle${on ? ' toggle--on' : ''}`}
      onClick={() => onChange(!on)}
    >
      <span className="toggle__box" />
      {label}
    </button>
  );
}

export function SubmitPanel({
  onSubmit,
  busy,
}: {
  onSubmit: (input: SubmitInput) => void;
  busy: boolean;
}) {
  const [prompt, setPrompt] = useState('');
  const [country, setCountry] = useState('ca');
  const [html, setHtml] = useState(false);
  const [markdown, setMarkdown] = useState(true);

  const submit = (e: React.FormEvent): void => {
    e.preventDefault();
    const trimmed = prompt.trim();
    if (!trimmed || busy) return;
    onSubmit({ prompt: trimmed, country, html, markdown });
  };

  return (
    <form className="panel submit" onSubmit={submit}>
      <div className="panel__head">
        <span className="panel__tag">01</span> NEW REQUEST
      </div>
      <textarea
        className="submit__prompt"
        placeholder="Ask Grok anything…"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={4}
        maxLength={8000}
      />
      <div className="submit__controls">
        <label className="field">
          <span className="field__label">Proxy country</span>
          <select value={country} onChange={(e) => setCountry(e.target.value)}>
            {COUNTRIES.map((c) => (
              <option key={c} value={c}>
                {c.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <div className="submit__toggles">
          <Toggle label="Markdown" on={markdown} onChange={setMarkdown} />
          <Toggle label="HTML" on={html} onChange={setHtml} />
        </div>
      </div>
      <button className="btn" type="submit" disabled={busy || !prompt.trim()}>
        {busy ? 'REQUEST IN FLIGHT' : 'DISPATCH ▸'}
      </button>
    </form>
  );
}
