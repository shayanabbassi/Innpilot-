'use client';

import type { GuestDto, GuestSummaryDto } from '@innpilot/contracts';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { ApiErrorAlert, Button, TextField } from './ui';

/** Search existing guests, or add a minimal new one without leaving the booking. */
export function GuestPicker({
  value,
  onChange,
  error,
}: {
  value: GuestSummaryDto | null;
  onChange: (g: GuestSummaryDto | null) => void;
  error?: string;
}) {
  const t = useTranslations('reservations');
  const { can } = useSession();
  const [input, setInput] = useState('');
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [addError, setAddError] = useState<unknown>(null);
  useEffect(() => {
    const id = setTimeout(() => setSearch(input.trim()), 300);
    return () => clearTimeout(id);
  }, [input]);
  const results = useQuery({
    queryKey: ['guests', search],
    queryFn: () => api.get<GuestSummaryDto[]>(`/guests?search=${encodeURIComponent(search)}&limit=8`),
    enabled: search.length >= 2,
  });

  if (value) {
    return (
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="font-medium text-ink">{value.fullName}</p>
          <p className="text-sm text-muted">{[value.phone, value.email].filter(Boolean).join(' · ')}</p>
        </div>
        <Button variant="ghost" onClick={() => onChange(null)}>
          {t('changeGuest')}
        </Button>
      </div>
    );
  }

  const add = async () => {
    setAddError(null);
    try {
      const g = await api.post<GuestDto>('/guests', { fullName: name, ...(phone ? { phone } : {}) });
      onChange(g);
    } catch (err) {
      setAddError(err);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <TextField
        label={t('findGuest')}
        placeholder={t('findGuestPlaceholder')}
        value={input}
        error={error}
        onChange={(e) => setInput(e.target.value)}
      />
      {search.length >= 2 && results.data && (
        <ul className="divide-y divide-line rounded-md border border-line">
          {results.data.length === 0 && <li className="px-3 py-2 text-sm text-muted">{t('noGuestFound')}</li>}
          {results.data.map((g) => (
            <li key={g.id}>
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-sm hover:bg-canvas"
                onClick={() => onChange(g)}
              >
                <span className="font-medium text-ink">{g.fullName}</span>{' '}
                <span className="text-muted">{[g.phone, g.email].filter(Boolean).join(' · ')}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {can('guest.write') &&
        (adding ? (
          <div className="grid gap-3 rounded-md border border-line p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            {addError !== null && (
              <div className="sm:col-span-3">
                <ApiErrorAlert error={addError} />
              </div>
            )}
            <TextField label={t('newGuestName')} value={name} onChange={(e) => setName(e.target.value)} />
            <TextField
              label={t('newGuestPhone')}
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
            <Button disabled={!name.trim()} onClick={() => void add()}>
              {t('addGuest')}
            </Button>
          </div>
        ) : (
          <div>
            <Button variant="secondary" onClick={() => setAdding(true)}>
              {t('createGuest')}
            </Button>
          </div>
        ))}
    </div>
  );
}
