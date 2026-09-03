/** Chat panel behind the Topbar AI button. Client-held history (cleared
 * on unmount); a `navigate` in the response routes and closes the panel. */
import { FormEvent, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { AiChatMessage, aiChatRequest } from '../lib/api';
import '../styles/ai.css';

// Keep in sync with App.tsx's route table — a page key the server sends
// that isn't listed here silently no-ops (message still renders, no nav).
const PAGE_ROUTES: Record<string, (id?: string | null) => string> = {
  assets: () => '/assets',
  asset_detail: (id) => `/assets/${id}`,
  initiatives: () => '/initiatives',
  initiative_detail: (id) => `/initiatives/${id}`,
  move_load_assets: (id) => `/initiatives/${id}/import-assets`,
  workers: () => '/people/workers',
  worker_detail: (id) => `/people/workers/${id}`,
  sites: () => '/sites',
  clients: () => '/stakeholders/clients',
  client_detail: (id) => `/stakeholders/clients/${id}`,
  partners: () => '/stakeholders/partners',
  scans: () => '/admin/scans',
};

export default function AiAssistant({ onClose }: { onClose: () => void }) {
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const listRef = useRef<HTMLDivElement>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const text = input.trim();
    if (!text || busy) return;
    const next = [...messages, { role: 'user' as const, content: text }];
    setMessages(next);
    setInput('');
    setBusy(true);
    setError(null);
    try {
      const out = await aiChatRequest(next);
      setMessages([...next,
                   { role: 'assistant' as const, content: out.reply }]);
      if (out.navigate && PAGE_ROUTES[out.navigate.page]) {
        navigate(PAGE_ROUTES[out.navigate.page](out.navigate.id));
        onClose();
      }
    } catch (err) {
      setError(err instanceof Error && err.message === 'ai_offline'
        ? 'AI assistant is offline.'
        : 'Something went wrong — try again.');
    } finally {
      setBusy(false);
      const list = listRef.current;
      if (list) list.scrollTop = list.scrollHeight;
    }
  }

  return (
    <div className="ai-panel">
      <div className="ai-messages" ref={listRef}>
        {messages.length === 0 && !error && (
          <div className="ai-hint">
            Ask about your moves, assets, sites, and people — or say
            where to go, like “load assets for the NAP11 move”.
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`ai-msg ai-msg-${m.role}`}>{m.content}</div>
        ))}
        {busy && <div className="ai-msg ai-msg-assistant ai-busy">…</div>}
        {error && <div className="ai-error">{error}</div>}
      </div>
      <form aria-label="AI assistant" onSubmit={onSubmit} className="ai-form">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask about moves, assets, people…"
          disabled={busy}
        />
        <button type="submit" disabled={busy || !input.trim()}>Send</button>
      </form>
    </div>
  );
}
