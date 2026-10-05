'use client';

import { useState } from 'react';
import { SITE_PHONE_COUNTRIES, composePhoneE164, countryFlag, groupPhoneLocal } from '../lib/phoneFormat';

/**
 * The homepage phone row. The country code is selected, not typed.
 * Nothing is sent from here. Chat is where a phone payment is confirmed.
 */
export function PayPeople() {
  const [iso, setIso] = useState('NG');
  const [local, setLocal] = useState('708 043 7343');
  const dial = SITE_PHONE_COUNTRIES.find((country) => country.iso === iso)?.dial || '234';
  const e164 = composePhoneE164(dial, local);
  const grouped = groupPhoneLocal(local);
  const command = `flizy send 0.01 ETH to +${dial}${grouped ? ` ${grouped}` : ''}`;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="card p-5 md:p-8">
        <p className="text-xs uppercase tracking-[0.18em] text-gold">Phone number</p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <div className="sm:w-56">
            <label className="label" htmlFor="pay-country">
              Country
            </label>
            <select
              id="pay-country"
              className="input min-h-[44px]"
              value={iso}
              onChange={(event) => setIso(event.target.value)}
            >
              {SITE_PHONE_COUNTRIES.map((country) => (
                <option key={country.iso} value={country.iso}>
                  {countryFlag(country.iso)} {country.name} (+{country.dial})
                </option>
              ))}
            </select>
          </div>
          <div className="min-w-0 flex-1">
            <label className="label" htmlFor="pay-local">
              Number
            </label>
            <input
              id="pay-local"
              className="input min-h-[44px] font-mono"
              inputMode="tel"
              autoComplete="tel-national"
              value={local}
              placeholder="708 043 7343"
              onChange={(event) =>
                setLocal(event.target.value.replace(/[^\d\s-]/g, '').slice(0, 18))
              }
            />
          </div>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted">
          Country code included automatically.
        </p>
        <p className="mt-2 font-mono text-sm text-paper" aria-live="polite">
          {e164 ? `Stored as +${e164}` : 'Enter the rest of the number.'}
        </p>
      </div>

      <div className="card flex flex-col justify-center p-5 md:p-8">
        <p className="text-xs uppercase tracking-[0.18em] text-gold">In chat</p>
        <p className="mono-box mt-4 text-sm text-paper">{command}</p>
        <ul className="mt-4 space-y-2 text-sm">
          <li className={e164 ? 'text-lime' : 'text-muted'}>
            {e164 ? 'Number recognized' : 'Waiting for a full number'}
          </li>
          <li className="text-muted">Confirm in chat before anything moves.</li>
        </ul>
        <p className="mt-4 text-xs leading-relaxed text-muted">
          Phone numbers must include the country code. Spaces and dashes are fine. You can save
          your own country on your account. Chat then adds that code, and it stays optional.
        </p>
      </div>
    </div>
  );
}
