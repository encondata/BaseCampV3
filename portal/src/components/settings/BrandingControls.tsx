/**
 * BrandingControls — System settings › Branding: the company staff ID
 * badges name and show (a worker's badge shows their partner instead).
 * The company name saves on Save; the logo (PNG, JPEG or WebP up to 5 MB,
 * stored as uploaded, uncropped) uploads as soon as a file is picked and
 * replaces the old one ("Uploading…" meanwhile); Remove asks once in the
 * report-generate confirm dialog. A logo whose picture won't load shows
 * "No logo". Errors are sentences, never raw API codes. Everything is
 * read-only without `settings:change`.
 */
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import {
  ApiError, getBranding, removeBrandingLogo, updateBranding, uploadBrandingLogo,
  type Branding,
} from '../../lib/api';
import '../../styles/directory.css';   /* .btn-solid.btn-danger */
import '../../styles/profile.css';     /* .pf-form, .btn-solid, .pf-error */
import '../../styles/reports.css';     /* the report-generate dialog header */

const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp'];
const MAX_BYTES = 5 * 1024 * 1024;
const NAME_MAX = 200;

const STORAGE_DOWN = 'Logo storage isn’t available right now. Try again in a moment.';

const LOGO_ERRORS: Record<string, string> = {
  file_too_large: 'The logo is over 5 MB.',
  invalid_file_type: 'Use a PNG, JPEG, or WebP image.',
  empty_file: 'That file is empty.',
  unreadable_image: 'That file could not be read as an image.',
  image_too_large: 'The logo is over 40 megapixels.',
  storage_unavailable: STORAGE_DOWN,
};

const NAME_ERRORS: Record<string, string> = {
  company_name_required: 'Enter a company name.',
  company_name_invalid: 'The company name can’t contain control characters.',
};

/** A known code's sentence; read-only maintenance says its own; any other
 *  code (never shown raw) is `fallback`. */
function message(err: unknown, codes: Record<string, string>, fallback: string): string {
  if (err instanceof ApiError) {
    if (codes[err.code]) return codes[err.code];
    if (err.code === 'read_only_mode' && err.message) return err.message;
  }
  return fallback;
}

export default function BrandingControls({ canChange = true }: { canChange?: boolean }) {
  const [cfg, setCfg] = useState<Branding | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [nameError, setNameError] = useState('');
  const [logoError, setLogoError] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  // the stored logo's URL failed to load (expired, or the object is gone)
  const [broken, setBroken] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void getBranding()
      .then((b) => { setCfg(b); setName(b.company_name); })
      .catch(() => setNameError('Could not load the branding settings.'));
  }, []);

  const locked = busy || !canChange || cfg === null;
  const dirty = cfg !== null && name.trim() !== cfg.company_name;

  const saveName = async (e: FormEvent) => {
    e.preventDefault();
    if (!dirty || locked) return;
    if (!name.trim()) { setNameError('Enter a company name.'); return; }
    setBusy(true); setNameError('');
    try {
      const next = await updateBranding({ company_name: name.trim() });
      setCfg(next); setName(next.company_name);
    } catch (err) {
      setNameError(message(err, NAME_ERRORS, 'Could not save.'));
    } finally { setBusy(false); }
  };

  const pick = () => { setLogoError(''); fileRef.current?.click(); };

  const onFile = async (file: File | undefined) => {
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    if (!ACCEPTED.includes(file.type)) { setLogoError(LOGO_ERRORS.invalid_file_type); return; }
    if (file.size > MAX_BYTES) { setLogoError(LOGO_ERRORS.file_too_large); return; }
    setBusy(true); setUploading(true); setLogoError('');
    try {
      setCfg(await uploadBrandingLogo(file));
    } catch (err) {
      setLogoError(message(err, LOGO_ERRORS, 'Upload failed — try again.'));
    } finally { setBusy(false); setUploading(false); }
  };

  const logoUrl = cfg?.logo_url && cfg.logo_url !== broken ? cfg.logo_url : null;

  return (
    <>
      <section className="set-section">
        <div className="set-head">
          <h3>Branding</h3>
          <p>The company staff ID badges name and show. A worker&apos;s badge shows their partner instead.</p>
        </div>
        <form className="pf-form brand-form" onSubmit={(e) => void saveName(e)}>
          <div className="full">
            <label htmlFor="brand-company-name">Company name</label>
            <input id="brand-company-name" value={name} maxLength={NAME_MAX} disabled={locked}
                   onChange={(e) => { setName(e.target.value); setNameError(''); }} />
          </div>
          <div className="pf-form-actions">
            <button type="submit" className="btn-solid" disabled={locked || !dirty}>Save</button>
            {nameError && <span className="pf-error" role="alert">{nameError}</span>}
          </div>
        </form>
        <div className="set-row brand-logo-row">
          <div className="set-label">
            <b>Company logo</b>
            <span>Printed on staff ID badges. PNG, JPEG, or WebP up to 5 MB; the original is kept, uncropped.</span>
            <div className="set-inline">
              <button type="button" className="mini-btn" disabled={locked} onClick={pick}>
                {uploading ? 'Uploading…' : cfg?.has_logo ? 'Replace logo…' : 'Upload logo…'}
              </button>
              {cfg?.has_logo && (
                <button type="button" className="mini-btn danger" disabled={locked}
                        onClick={() => { setLogoError(''); setConfirmOpen(true); }}>
                  Remove
                </button>
              )}
            </div>
            {logoError && <p className="pf-error brand-logo-error" role="alert">{logoError}</p>}
          </div>
          <div className="brand-logo-preview">
            {logoUrl
              ? <img src={logoUrl} alt="Company logo" onError={() => setBroken(logoUrl)} />
              : <span className="brand-logo-empty">No logo</span>}
          </div>
          <input ref={fileRef} type="file" hidden accept={ACCEPTED.join(',')}
                 aria-label="Company logo file" onChange={(e) => void onFile(e.target.files?.[0])} />
        </div>
      </section>
      {confirmOpen && (
        <RemoveLogoDialog onClose={() => setConfirmOpen(false)}
                          onRemoved={(next) => { setCfg(next); setConfirmOpen(false); }} />
      )}
    </>
  );
}

function RemoveLogoDialog({ onClose, onRemoved }: {
  onClose: () => void;
  onRemoved: (next: Branding) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const remove = async () => {
    setBusy(true); setError('');
    try {
      onRemoved(await removeBrandingLogo());
    } catch (err) {
      setError(message(err, { storage_unavailable: STORAGE_DOWN }, 'Could not remove the logo.'));
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card brand-remove-card" role="dialog" aria-modal="true"
           aria-label="Remove the company logo">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">System settings · Branding</div>
            <h3>Remove the company logo?</h3>
            <p className="page-hint">
              Staff ID badges print without a logo until a new one is uploaded. The stored file is deleted.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-solid btn-danger" disabled={busy} onClick={() => void remove()}>
            {busy ? 'Removing…' : 'Remove logo'}
          </button>
          <button type="button" className="mini-btn" disabled={busy} onClick={onClose} autoFocus>Cancel</button>
          {error && <span className="pf-error" role="alert">{error}</span>}
        </div>
      </div>
    </div>
  );
}
