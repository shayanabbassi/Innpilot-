'use client';

import type { CardSettlementDto, CashAccountDto } from '@innpilot/contracts';
import { Money } from '@innpilot/money';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ApiErrorAlert, Button, Dialog, SelectField, TextField } from '@/components/ui';
import { api } from '@/lib/api';
import { formatAmount } from '@/lib/finance';
import { useSession } from '@/lib/session';

const AMOUNT = /^\d{1,13}(\.\d{1,2})?$/;

/** The card company's payout: gross from the clearing account, fee to bank charges, the rest into the bank. */
export function CardSettlementDialog({
  open,
  accounts,
  onClose,
  onDone,
}: {
  open: boolean;
  accounts: CashAccountDto[];
  onClose: () => void;
  onDone: (s: CardSettlementDto) => void;
}) {
  const t = useTranslations('cash');
  const tCommon = useTranslations('common');
  const { property } = useSession();
  const queryClient = useQueryClient();
  const cur = property?.currencyCode ?? 'PKR';
  const clearing = accounts.filter((a) => a.kind === 'card_clearing' && a.active);
  const banks = accounts.filter((a) => a.kind === 'bank' && a.active);
  const [clearingId, setClearingId] = useState('');
  const [bankId, setBankId] = useState('');
  const [gross, setGross] = useState('');
  const [fee, setFee] = useState('');
  const [reference, setReference] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setClearingId(clearing.length === 1 ? clearing[0]!.id : '');
      setBankId(banks.length === 1 ? banks[0]!.id : '');
      setGross('');
      setFee('');
      setReference('');
      setError(null);
    }
  }

  const g = AMOUNT.test(gross.trim()) ? Money.of(gross.trim(), cur) : null;
  const f = fee.trim() === '' ? Money.zero(cur) : AMOUNT.test(fee.trim()) ? Money.of(fee.trim(), cur) : null;
  const net = g && f ? g.subtract(f) : null;
  const held = clearing.find((c) => c.id === clearingId)?.balance ?? null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const done = await api.postWith<CardSettlementDto>(
        `/properties/${property!.id}/card-settlements`,
        {
          clearingAccountId: clearingId,
          bankAccountId: bankId,
          grossAmount: gross.trim(),
          feeAmount: fee.trim() || '0',
          reference: reference.trim() || undefined,
        },
        { 'idempotency-key': key },
      );
      setKey(crypto.randomUUID());
      await queryClient.invalidateQueries({ queryKey: ['finance'] });
      onDone(done);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('settleTitle')}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">{t('settleExplain')}</p>
        {error !== null && <ApiErrorAlert error={error} />}
        <SelectField
          label={t('settleFrom')}
          value={clearingId}
          onChange={(e) => setClearingId(e.target.value)}
          hint={held !== null ? `${t('waiting')}: ${formatAmount(held, cur)}` : undefined}
        >
          <option value="">{t('chooseAccount')}</option>
          {clearing.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </SelectField>
        <SelectField label={t('settleTo')} value={bankId} onChange={(e) => setBankId(e.target.value)}>
          <option value="">{t('chooseAccount')}</option>
          {banks.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </SelectField>
        <TextField
          label={t('grossAmount')}
          inputMode="decimal"
          value={gross}
          onChange={(e) => setGross(e.target.value)}
          className="tabular"
        />
        <TextField
          label={t('feeAmount')}
          inputMode="decimal"
          value={fee}
          onChange={(e) => setFee(e.target.value)}
          hint={t('feeHint')}
          className="tabular"
        />
        {net && (
          <p className="text-sm" aria-live="polite">
            {t('netToBank')}:{' '}
            <span className="tabular font-semibold">{formatAmount(net.toString(), cur)}</span>
          </p>
        )}
        <TextField
          label={t('transferReference')}
          value={reference}
          maxLength={80}
          onChange={(e) => setReference(e.target.value)}
          hint={t('settleReferenceHint')}
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {tCommon('cancel')}
          </Button>
          <Button
            busy={busy}
            disabled={!clearingId || !bankId || !g || !g.isPositive() || !f || !net || !net.isPositive()}
            onClick={() => void submit()}
          >
            {t('settle')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
