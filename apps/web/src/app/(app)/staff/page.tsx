'use client';

import { zodResolver } from '@hookform/resolvers/zod';
import {
  createUserRequest,
  ROLE_CODES,
  ROLES,
  type CreateUserRequest,
  type PasswordResetResponse,
  type RoleAssignmentDto,
  type RoleCode,
  type UserDto,
} from '@innpilot/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFormatter, useTranslations } from 'next-intl';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  Alert,
  ApiErrorAlert,
  Button,
  Dialog,
  EmptyState,
  PageError,
  PageHeader,
  PageSkeleton,
  PermissionDenied,
  SelectField,
  StatusBadge,
  TextField,
} from '@/components/ui';
import { api } from '@/lib/api';
import { applyServerErrors } from '@/lib/forms';
import { useSession } from '@/lib/session';

const USERS_KEY = ['users'] as const;
type Action =
  | { kind: 'roles' | 'disable' | 'enable' | 'resetMfa' | 'resetPassword'; user: UserDto }
  | { kind: 'create' }
  | null;

export default function StaffPage() {
  const t = useTranslations('staff');
  const session = useSession();
  const [action, setAction] = useState<Action>(null);
  const users = useQuery({
    queryKey: USERS_KEY,
    queryFn: () => api.get<UserDto[]>('/users'),
    enabled: session.canTenant('user.read'),
  });

  if (!session.canTenant('user.read')) return <PermissionDenied />;
  const canManage = session.canTenant('user.manage');

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={canManage && <Button onClick={() => setAction({ kind: 'create' })}>{t('add')}</Button>}
      />
      {users.isPending ? (
        <PageSkeleton />
      ) : users.isError ? (
        <PageError error={users.error} onRetry={() => void users.refetch()} />
      ) : users.data.length === 0 ? (
        <EmptyState message={t('empty')} />
      ) : (
        <StaffTable users={users.data} canManage={canManage} onAction={setAction} />
      )}

      {action?.kind === 'create' && <CreateUserDialog onClose={() => setAction(null)} />}
      {action?.kind === 'roles' && <RolesDialog user={action.user} onClose={() => setAction(null)} />}
      {action?.kind === 'resetPassword' && (
        <PasswordResetDialog user={action.user} onClose={() => setAction(null)} />
      )}
      {(action?.kind === 'disable' || action?.kind === 'enable' || action?.kind === 'resetMfa') && (
        <ConfirmWithReason kind={action.kind} user={action.user} onClose={() => setAction(null)} />
      )}
    </>
  );
}

function RoleList({ roles }: { roles: RoleAssignmentDto[] }) {
  const tRoles = useTranslations('roles');
  const tCommon = useTranslations('common');
  const { me } = useSession();
  const propertyName = (id: string | null) =>
    id === null ? tCommon('allProperties') : (me.properties.find((p) => p.id === id)?.name ?? id.slice(0, 8));
  return (
    <ul className="flex flex-col gap-0.5">
      {roles.map((r) => (
        <li key={`${r.role}:${r.propertyId}`}>
          {tRoles(r.role)} <span className="text-muted">· {propertyName(r.propertyId)}</span>
        </li>
      ))}
    </ul>
  );
}

function StaffTable({
  users,
  canManage,
  onAction,
}: {
  users: UserDto[];
  canManage: boolean;
  onAction: (a: Action) => void;
}) {
  const t = useTranslations('staff');
  const format = useFormatter();
  const { me } = useSession();
  const lastLogin = (u: UserDto) =>
    u.lastLoginAt
      ? format.dateTime(new Date(u.lastLoginAt), { dateStyle: 'medium', timeStyle: 'short' })
      : t('never');

  const actions = (u: UserDto) =>
    canManage && u.id !== me.user.id ? (
      <div className="flex flex-wrap gap-1">
        <Button variant="ghost" className="min-h-8 px-2" onClick={() => onAction({ kind: 'roles', user: u })}>
          {t('editRoles')}
        </Button>
        <Button
          variant="ghost"
          className="min-h-8 px-2"
          onClick={() => onAction({ kind: u.status === 'active' ? 'disable' : 'enable', user: u })}
        >
          {u.status === 'active' ? t('disable') : t('enable')}
        </Button>
        {u.status === 'active' && (
          <Button
            variant="ghost"
            className="min-h-8 px-2"
            onClick={() => onAction({ kind: 'resetPassword', user: u })}
          >
            {t('resetPassword')}
          </Button>
        )}
        {u.mfaEnabled && (
          <Button
            variant="ghost"
            className="min-h-8 px-2"
            onClick={() => onAction({ kind: 'resetMfa', user: u })}
          >
            {t('resetMfa')}
          </Button>
        )}
      </div>
    ) : null;

  const status = (u: UserDto) => (
    <StatusBadge tone={u.status === 'active' ? 'success' : 'neutral'}>
      {u.status === 'active' ? t('active') : t('disabled')}
    </StatusBadge>
  );

  return (
    <>
      {/* Desktop and tablet: table. */}
      <div className="hidden overflow-x-auto rounded-lg border border-line bg-white md:block">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line bg-canvas text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-3 font-medium">{t('name')}</th>
              <th className="px-4 py-3 font-medium">{t('roles')}</th>
              <th className="px-4 py-3 font-medium">{t('status')}</th>
              <th className="px-4 py-3 font-medium">{t('mfa')}</th>
              <th className="px-4 py-3 font-medium">{t('lastLogin')}</th>
              {canManage && <th className="px-4 py-3 font-medium">{t('actions')}</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {users.map((u) => (
              <tr key={u.id} className="align-top">
                <td className="px-4 py-3">
                  <p className="font-medium text-ink">
                    {u.fullName}{' '}
                    {u.id === me.user.id && (
                      <span className="text-xs font-normal text-muted">({t('you')})</span>
                    )}
                  </p>
                  <p className="text-xs text-muted">{u.email}</p>
                </td>
                <td className="px-4 py-3">
                  <RoleList roles={u.roles} />
                </td>
                <td className="px-4 py-3">{status(u)}</td>
                <td className="px-4 py-3">{u.mfaEnabled ? t('mfaOn') : t('mfaOff')}</td>
                <td className="tabular px-4 py-3 text-muted">{lastLogin(u)}</td>
                {canManage && <td className="px-4 py-2">{actions(u)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Phone: stacked cards. */}
      <ul className="flex flex-col gap-3 md:hidden">
        {users.map((u) => (
          <li key={u.id} className="rounded-lg border border-line bg-white p-4 text-sm">
            <div className="flex items-start justify-between gap-2">
              <div>
                <p className="font-medium text-ink">{u.fullName}</p>
                <p className="text-xs text-muted">{u.email}</p>
              </div>
              {status(u)}
            </div>
            <div className="mt-3">
              <RoleList roles={u.roles} />
            </div>
            <p className="tabular mt-2 text-xs text-muted">
              {t('lastLogin')}: {lastLogin(u)} · {t('mfa')}: {u.mfaEnabled ? t('mfaOn') : t('mfaOff')}
            </p>
            <div className="mt-2">{actions(u)}</div>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Role pickers. Only offers roles the current user may grant (the API checks this again). */
function RoleEditor({
  value,
  onChange,
}: {
  value: RoleAssignmentDto[];
  onChange: (v: RoleAssignmentDto[]) => void;
}) {
  const t = useTranslations('staff');
  const tRoles = useTranslations('roles');
  const tCommon = useTranslations('common');
  const { me } = useSession();
  const grantable = ROLE_CODES.filter((r) =>
    ROLES[r].permissions.every((p) => me.tenantPermissions.includes(p)),
  );

  const update = (i: number, patch: Partial<RoleAssignmentDto>) =>
    onChange(value.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div className="flex flex-col gap-3">
      {value.map((r, i) => (
        <div key={i} className="grid grid-cols-1 items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
          <SelectField
            label={t('role')}
            value={r.role}
            onChange={(e) => update(i, { role: e.target.value as RoleCode })}
          >
            {grantable.map((code) => (
              <option key={code} value={code}>
                {tRoles(code)}
                {ROLES[code].mfaRequired ? ` — ${t('mfaRequiredNote')}` : ''}
              </option>
            ))}
          </SelectField>
          <SelectField
            label={t('scope')}
            value={r.propertyId ?? ''}
            onChange={(e) => update(i, { propertyId: e.target.value || null })}
          >
            <option value="">{tCommon('allProperties')}</option>
            {me.properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </SelectField>
          <Button
            variant="ghost"
            disabled={value.length === 1}
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            {t('remove')}
          </Button>
        </div>
      ))}
      <div>
        <Button
          variant="secondary"
          disabled={grantable.length === 0}
          onClick={() => onChange([...value, { role: grantable[0] ?? 'front_desk', propertyId: null }])}
        >
          {t('addRole')}
        </Button>
      </div>
    </div>
  );
}

function CreateUserDialog({ onClose }: { onClose: () => void }) {
  const t = useTranslations('staff');
  const tCommon = useTranslations('common');
  const queryClient = useQueryClient();
  const [error, setError] = useState<unknown>(null);
  const form = useForm<CreateUserRequest>({
    resolver: zodResolver(createUserRequest),
    defaultValues: {
      email: '',
      fullName: '',
      password: '',
      roles: [{ role: 'front_desk', propertyId: null }],
    },
  });
  const roles = form.watch('roles');

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    try {
      await api.post<UserDto>('/users', values);
      await queryClient.invalidateQueries({ queryKey: USERS_KEY });
      onClose();
    } catch (err) {
      if (!applyServerErrors(err, form.setError, ['email', 'fullName', 'password', 'roles'])) setError(err);
    }
  });

  return (
    <Dialog open onClose={onClose} title={t('createTitle')}>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
        {error !== null && <ApiErrorAlert error={error} />}
        <TextField
          label={t('fullName')}
          autoComplete="off"
          error={form.formState.errors.fullName?.message}
          {...form.register('fullName')}
        />
        <TextField
          label={t('email')}
          type="email"
          autoComplete="off"
          error={form.formState.errors.email?.message}
          {...form.register('email')}
        />
        <TextField
          label={t('initialPassword')}
          type="password"
          autoComplete="new-password"
          hint={t('initialPasswordHint')}
          error={form.formState.errors.password?.message}
          {...form.register('password')}
        />
        <RoleEditor value={roles} onChange={(v) => form.setValue('roles', v, { shouldValidate: true })} />
        {form.formState.errors.roles?.message && (
          <p className="text-xs text-danger">{form.formState.errors.roles.message}</p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {tCommon('cancel')}
          </Button>
          <Button type="submit" busy={form.formState.isSubmitting}>
            {form.formState.isSubmitting ? t('creating') : t('create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RolesDialog({ user, onClose }: { user: UserDto; onClose: () => void }) {
  const t = useTranslations('staff');
  const tCommon = useTranslations('common');
  const queryClient = useQueryClient();
  const [roles, setRoles] = useState<RoleAssignmentDto[]>(user.roles);
  const save = useMutation({
    mutationFn: () => api.put<UserDto>(`/users/${user.id}/roles`, { roles }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: USERS_KEY });
      onClose();
    },
  });

  return (
    <Dialog open onClose={onClose} title={t('rolesTitle', { name: user.fullName })}>
      <div className="flex flex-col gap-4">
        {save.isError && <ApiErrorAlert error={save.error} />}
        <RoleEditor value={roles} onChange={setRoles} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {tCommon('cancel')}
          </Button>
          <Button busy={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? tCommon('saving') : t('saveRoles')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function ConfirmWithReason({
  kind,
  user,
  onClose,
}: {
  kind: 'disable' | 'enable' | 'resetMfa';
  user: UserDto;
  onClose: () => void;
}) {
  const t = useTranslations('staff');
  const tCommon = useTranslations('common');
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const run = useMutation({
    mutationFn: () =>
      kind === 'resetMfa'
        ? api.post<UserDto>(`/users/${user.id}/mfa/reset`, { reason })
        : api.post<UserDto>(`/users/${user.id}/status`, {
            status: kind === 'disable' ? 'disabled' : 'active',
            reason,
          }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: USERS_KEY });
      onClose();
    },
  });
  const copy = {
    disable: [t('disableTitle', { name: user.fullName }), t('disableBody')],
    enable: [t('enableTitle', { name: user.fullName }), t('enableBody')],
    resetMfa: [t('resetMfaTitle', { name: user.fullName }), t('resetMfaBody')],
  }[kind];

  return (
    <Dialog open onClose={onClose} title={copy[0]!}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">{copy[1]}</p>
        {run.isError && <ApiErrorAlert error={run.error} />}
        <TextField
          label={t('reasonLabel')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {tCommon('cancel')}
          </Button>
          <Button
            variant={kind === 'enable' ? 'primary' : 'danger'}
            busy={run.isPending}
            disabled={reason.trim().length < 3}
            onClick={() => run.mutate()}
          >
            {t('confirm')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * D18: a one-time temporary password for a staff member. It is shown once, here, to hand over in person; it expires
 * and must be changed at the next sign-in. Closing the dialog removes it from the screen for good.
 */
function PasswordResetDialog({ user, onClose }: { user: UserDto; onClose: () => void }) {
  const t = useTranslations('staff');
  const tCommon = useTranslations('common');
  const format = useFormatter();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const run = useMutation({
    mutationFn: () => api.post<PasswordResetResponse>(`/users/${user.id}/password-reset`, { reason }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: USERS_KEY }),
  });

  return (
    <Dialog open onClose={onClose} title={t('resetPasswordTitle', { name: user.fullName })}>
      {run.data ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm">{t('resetPasswordDone', { name: user.fullName })}</p>
          <p className="tabular select-all rounded-md border border-line bg-canvas px-3 py-3 text-center font-mono text-lg tracking-wider">
            {run.data.temporaryPassword}
          </p>
          <Alert tone="warning">
            {t('resetPasswordOnce', {
              until: format.dateTime(new Date(run.data.expiresAt), {
                dateStyle: 'medium',
                timeStyle: 'short',
              }),
            })}
          </Alert>
          <div className="flex justify-end">
            <Button onClick={onClose}>{tCommon('close')}</Button>
          </div>
        </div>
      ) : (
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.trim().length >= 3 && !run.isPending) run.mutate();
          }}
        >
          <p className="text-sm text-muted">{t('resetPasswordBody')}</p>
          {run.isError && <ApiErrorAlert error={run.error} />}
          <TextField
            label={t('reasonLabel')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
          />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" busy={run.isPending} disabled={reason.trim().length < 3}>
              {t('resetPasswordConfirm')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
