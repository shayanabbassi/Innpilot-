'use client';

import { ACCOUNT_CLASSES, CLASS_CODE_DIGIT, type AccountClass, type AccountDto } from '@innpilot/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { ACCOUNTS_QUERY_KEY, useAccounts } from '@/components/journal-form';
import {
  ApiErrorAlert,
  Button,
  Card,
  Dialog,
  PageError,
  PageHeader,
  PageSkeleton,
  PermissionDenied,
  SelectField,
  StatusBadge,
  TextField,
} from '@/components/ui';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

type Editing = { mode: 'new' } | { mode: 'edit'; account: AccountDto } | null;

export default function AccountsPage() {
  const t = useTranslations('finance');
  const { canTenant } = useSession();
  const allowed = canTenant('journal.read');
  const canManage = canTenant('account.manage');
  const accounts = useAccounts(allowed);
  const [editing, setEditing] = useState<Editing>(null);

  if (!allowed) return <PermissionDenied />;
  if (accounts.isPending) return <PageSkeleton />;
  if (accounts.isError) return <PageError error={accounts.error} onRetry={() => void accounts.refetch()} />;

  return (
    <>
      <PageHeader
        title={t('accountsTitle')}
        subtitle={t('accountsSubtitle')}
        actions={canManage && <Button onClick={() => setEditing({ mode: 'new' })}>{t('addAccount')}</Button>}
      />
      <div className="flex flex-col gap-4">
        {ACCOUNT_CLASSES.map((cls) => {
          const rows = accounts.data.filter((a) => a.accountClass === cls);
          if (rows.length === 0) return null;
          return (
            <Card key={cls} title={t(`classes.${cls}`)}>
              <ul className="divide-y divide-line text-sm">
                {rows.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                    <Link
                      href={`/finance/ledger?accountId=${a.id}`}
                      className={`flex-1 ${a.parentId ? 'pl-4' : ''} ${a.active ? 'text-ink' : 'text-muted'}`}
                    >
                      <span className="tabular font-medium">{a.code}</span>{' '}
                      <span className="underline decoration-line underline-offset-2">{a.name}</span>
                    </Link>
                    {a.systemRole && <StatusBadge tone="neutral">{t('systemAccount')}</StatusBadge>}
                    {!a.active && <StatusBadge tone="warning">{t('inactive')}</StatusBadge>}
                    {canManage && (
                      <Button variant="ghost" onClick={() => setEditing({ mode: 'edit', account: a })}>
                        {t('edit')}
                        <span className="sr-only"> {a.code}</span>
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          );
        })}
      </div>
      <AccountDialog editing={editing} accounts={accounts.data} onClose={() => setEditing(null)} />
    </>
  );
}

function AccountDialog({
  editing,
  accounts,
  onClose,
}: {
  editing: Editing;
  accounts: AccountDto[];
  onClose: () => void;
}) {
  const t = useTranslations('finance');
  const tCommon = useTranslations('common');
  const queryClient = useQueryClient();
  const existing = editing?.mode === 'edit' ? editing.account : null;
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [cls, setCls] = useState<AccountClass>('expense');
  const [parentId, setParentId] = useState('');
  const [active, setActive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [openedFor, setOpenedFor] = useState<Editing>(null);

  // Reset the fields each time the dialog opens for a different account.
  if (editing !== openedFor) {
    setOpenedFor(editing);
    setError(null);
    setCode(existing?.code ?? '');
    setName(existing?.name ?? '');
    setCls((existing?.accountClass as AccountClass) ?? 'expense');
    setParentId(existing?.parentId ?? '');
    setActive(existing?.active ?? true);
  }

  const parents = accounts.filter((a) => a.accountClass === cls && a.id !== existing?.id);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (existing) {
        await api.patch(`/finance/accounts/${existing.id}`, {
          name: name.trim(),
          parentId: parentId || null,
          active,
        });
      } else {
        await api.post('/finance/accounts', {
          code: code.trim(),
          name: name.trim(),
          accountClass: cls,
          parentId: parentId || null,
        });
      }
      await queryClient.invalidateQueries({ queryKey: ACCOUNTS_QUERY_KEY });
      onClose();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={editing !== null}
      onClose={onClose}
      title={existing ? t('editAccount', { code: existing.code }) : t('addAccount')}
    >
      <div className="flex flex-col gap-4">
        {error !== null && <ApiErrorAlert error={error} />}
        {!existing && (
          <>
            <SelectField
              label={t('accountClass')}
              value={cls}
              onChange={(e) => setCls(e.target.value as AccountClass)}
            >
              {ACCOUNT_CLASSES.map((c) => (
                <option key={c} value={c}>
                  {t(`classes.${c}`)}
                </option>
              ))}
            </SelectField>
            <TextField
              label={t('accountCode')}
              inputMode="numeric"
              value={code}
              maxLength={6}
              onChange={(e) => setCode(e.target.value)}
              hint={t('accountCodeHint', { digit: CLASS_CODE_DIGIT[cls] })}
            />
          </>
        )}
        <TextField
          label={t('accountName')}
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
        />
        <SelectField
          label={t('parentAccount')}
          value={parentId}
          onChange={(e) => setParentId(e.target.value)}
        >
          <option value="">{t('noParent')}</option>
          {parents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.code} · {a.name}
            </option>
          ))}
        </SelectField>
        {existing && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4"
              checked={active}
              disabled={!!existing.systemRole}
              onChange={(e) => setActive(e.target.checked)}
            />
            {existing.systemRole ? t('systemAlwaysActive') : t('activeLabel')}
          </label>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {tCommon('cancel')}
          </Button>
          <Button busy={busy} disabled={name.trim().length === 0} onClick={() => void save()}>
            {busy ? tCommon('saving') : tCommon('save')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
