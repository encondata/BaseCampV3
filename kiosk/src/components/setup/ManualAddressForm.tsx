/** The reader's IP typed in by hand — and, when the laptop's own address
 *  isn't known, the laptop IP the reader should send tag data to. Both are
 *  checked as IPv4 before anything is sent. */

import { useState, type FormEvent } from 'react';

import { BAD_IP_TEXT, isIPv4 } from './readerSetup';

interface Props {
  initialReaderIp?: string;
  withLaptopIp: boolean;
  onSubmit: (readerIp: string, laptopIp?: string) => void;
}

export default function ManualAddressForm({ initialReaderIp = '', withLaptopIp, onSubmit }: Props) {
  const [readerIp, setReaderIp] = useState(initialReaderIp);
  const [laptopIp, setLaptopIp] = useState('');
  const [error, setError] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!isIPv4(readerIp) || (withLaptopIp && !isIPv4(laptopIp))) {
      setError(BAD_IP_TEXT);
      return;
    }
    setError('');
    onSubmit(readerIp.trim(), withLaptopIp ? laptopIp.trim() : undefined);
  };

  return (
    <form className="pf-form kiosk-settings" onSubmit={submit} noValidate>
      <div>
        <label htmlFor="rfid-reader-ip">Reader IP</label>
        <input id="rfid-reader-ip" className="mono" inputMode="decimal" autoComplete="off"
               placeholder="192.168.1.20" value={readerIp}
               onChange={(e) => { setReaderIp(e.target.value); setError(''); }} />
      </div>
      {withLaptopIp && (
        <div>
          <label htmlFor="rfid-laptop-ip">Laptop IP</label>
          <input id="rfid-laptop-ip" className="mono" inputMode="decimal" autoComplete="off"
                 placeholder="192.168.1.10" value={laptopIp}
                 onChange={(e) => { setLaptopIp(e.target.value); setError(''); }} />
        </div>
      )}
      {error && <p className="form-error full" role="alert">{error}</p>}
      <div className="pf-form-actions full">
        <button type="submit" className="btn-solid">Connect</button>
      </div>
    </form>
  );
}
