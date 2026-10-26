/**
 * Add or edit a quiz question: the prompt, two or more choices, and which
 * choices are correct (more than one may be). The rules are checked here
 * before anything is sent — a question needs at least two filled choices and
 * at least one marked correct — and the API's own refusals read in plain
 * language. New choices get a client-made id (the server keeps ids it is
 * sent), so the correct ones can be named in the same request. Editing
 * keeps every existing choice's id, and drops a removed choice from the
 * question's translations (the API refuses a translation of a choice that
 * is gone).
 */

import { useState } from 'react';

import {
  createQuestion, patchQuestion, type QuestionTranslation, type QuizQuestion,
} from '../../lib/learning';
import { apiErrorText, newChoiceId, QUESTION_ERRORS } from '../../lib/learningDoc';
import LearningModal from './LearningModal';

interface Draft { id: string; text: string; correct: boolean }

export default function QuestionModal({ documentId, question, onClose, onSaved }: {
  documentId: string;
  /** The question to edit; absent to add one. */
  question?: QuizQuestion;
  onClose: () => void;
  onSaved: (question: QuizQuestion) => void;
}) {
  const [prompt, setPrompt] = useState(question?.prompt ?? '');
  const [choices, setChoices] = useState<Draft[]>(() => (question
    ? question.choices.map((c) => ({ id: c.id, text: c.text, correct: question.correct_choice_ids.includes(c.id) }))
    : [{ id: newChoiceId(), text: '', correct: false }, { id: newChoiceId(), text: '', correct: false }]));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const edit = (id: string, change: Partial<Draft>) => {
    setError('');
    setChoices((list) => list.map((c) => (c.id === id ? { ...c, ...change } : c)));
  };

  const save = async () => {
    const filled = choices.filter((c) => c.text.trim());
    if (!prompt.trim()) { setError('Write the question.'); return; }
    if (filled.length < 2) { setError(QUESTION_ERRORS.too_few_choices); return; }
    const correct = filled.filter((c) => c.correct).map((c) => c.id);
    if (correct.length === 0) { setError(QUESTION_ERRORS.no_correct_choice); return; }

    const body = {
      prompt: prompt.trim(),
      choices: filled.map((c) => ({ id: c.id, text: c.text.trim() })),
      correct_choice_ids: correct,
    };
    setSaving(true);
    setError('');
    try {
      if (!question) {
        onSaved(await createQuestion(documentId, body));
      } else {
        const keep = new Set(body.choices.map((c) => c.id));
        const pruned: Record<string, QuestionTranslation> = {};
        let changed = false;
        Object.entries(question.translations).forEach(([lang, tr]) => {
          const kept = Object.fromEntries(Object.entries(tr.choices ?? {}).filter(([id]) => keep.has(id)));
          if (Object.keys(kept).length !== Object.keys(tr.choices ?? {}).length) changed = true;
          pruned[lang] = { ...tr, ...(tr.choices ? { choices: kept } : {}) };
        });
        onSaved(await patchQuestion(question.id, changed ? { ...body, translations: pruned } : body));
      }
    } catch (e) {
      setError(apiErrorText(e, QUESTION_ERRORS));
      setSaving(false);
    }
  };

  return (
    <LearningModal eyebrow="Quiz" title={question ? 'Edit question' : 'New question'}
                   description="Workers answer after reading. Mark every correct choice; they must pick exactly those."
                   onClose={onClose} busy={saving} wide
                   footer={(
                     <>
                       <button type="button" className="btn-solid" onClick={() => void save()} disabled={saving}>
                         {saving ? 'Saving…' : question ? 'Save question' : 'Add question'}
                       </button>
                       <button type="button" className="mini-btn" onClick={onClose} disabled={saving}>Cancel</button>
                       {error && <span className="pf-error" role="alert">{error}</span>}
                     </>
                   )}>
      <div className="pf-form">
        <div className="full">
          <label htmlFor="lrn-q-prompt">Question</label>
          <textarea id="lrn-q-prompt" rows={3} maxLength={2000} value={prompt} disabled={saving}
                    onChange={(e) => { setPrompt(e.target.value); setError(''); }} />
        </div>
        <div className="full">
          <span className="lrn-lbl">Choices</span>
          <div className="lrn-choices">
            {choices.map((c, i) => (
              <div key={c.id} className="lrn-choice">
                <label className="lrn-correct">
                  <input type="checkbox" checked={c.correct} disabled={saving}
                         aria-label={`Choice ${i + 1} is correct`}
                         onChange={(e) => edit(c.id, { correct: e.target.checked })} />
                  <span>Correct</span>
                </label>
                <input value={c.text} maxLength={1000} disabled={saving} aria-label={`Choice ${i + 1}`}
                       onChange={(e) => edit(c.id, { text: e.target.value })} />
                {choices.length > 2 && (
                  <button type="button" className="mini-btn" disabled={saving}
                          aria-label={`Remove choice ${i + 1}`}
                          onClick={() => { setError(''); setChoices((l) => l.filter((x) => x.id !== c.id)); }}>
                    Remove
                  </button>
                )}
              </div>
            ))}
          </div>
          <button type="button" className="mini-btn" disabled={saving}
                  onClick={() => setChoices((l) => [...l, { id: newChoiceId(), text: '', correct: false }])}>
            Add choice
          </button>
        </div>
      </div>
    </LearningModal>
  );
}
