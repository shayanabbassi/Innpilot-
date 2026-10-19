'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { ApiError } from '@/lib/api';

function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-teal-600 text-white hover:bg-teal-700 disabled:bg-teal-600/50',
  secondary: 'bg-white text-ink border border-line hover:bg-navy-50 disabled:text-muted',
  danger: 'bg-danger text-white hover:bg-danger/90 disabled:bg-danger/50',
  ghost: 'text-navy-800 hover:bg-navy-50 disabled:text-muted',
};

export const Button = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; busy?: boolean }
>(function Button(
  { variant = 'primary', busy = false, className, disabled, children, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      // Disabled while busy so a double click cannot submit twice.
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={cx(
        'inline-flex min-h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed',
        VARIANTS[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

interface FieldProps {
  label: string;
  error?: string;
  hint?: string;
}

export const TextField = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & FieldProps>(
  function TextField({ label, error, hint, className, id, ...rest }, ref) {
    const autoId = useId();
    const inputId = id ?? autoId;
    const describedBy = [error && `${inputId}-error`, hint && `${inputId}-hint`].filter(Boolean).join(' ');
    return (
      <div className={cx('flex flex-col gap-1', className)}>
        <label htmlFor={inputId} className="text-sm font-medium text-ink">
          {label}
        </label>
        <input
          ref={ref}
          id={inputId}
          aria-invalid={!!error || undefined}
          aria-describedby={describedBy || undefined}
          className={cx(
            'min-h-10 rounded-md border bg-white px-3 text-sm text-ink placeholder:text-muted disabled:bg-canvas disabled:text-muted',
            error ? 'border-danger' : 'border-line',
          )}
          {...rest}
        />
        {hint && (
          <p id={`${inputId}-hint`} className="text-xs text-muted">
            {hint}
          </p>
        )}
        {error && (
          <p id={`${inputId}-error`} className="text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    );
  },
);

export const SelectField = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement> & FieldProps & { children: ReactNode }
>(function SelectField({ label, error, hint, className, id, children, ...rest }, ref) {
  const autoId = useId();
  const selectId = id ?? autoId;
  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <label htmlFor={selectId} className="text-sm font-medium text-ink">
        {label}
      </label>
      <select
        ref={ref}
        id={selectId}
        aria-invalid={!!error || undefined}
        className={cx(
          'min-h-10 rounded-md border bg-white px-3 text-sm text-ink disabled:bg-canvas',
          error ? 'border-danger' : 'border-line',
        )}
        {...rest}
      >
        {children}
      </select>
      {hint && <p className="text-xs text-muted">{hint}</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
});

export function Alert({
  tone = 'danger',
  children,
}: {
  tone?: 'danger' | 'warning' | 'success' | 'info';
  children: ReactNode;
}) {
  const tones = {
    danger: 'border-danger/30 bg-danger-50 text-danger',
    warning: 'border-warning/30 bg-warning-50 text-warning',
    success: 'border-success/30 bg-success-50 text-success',
    info: 'border-navy-100 bg-navy-50 text-navy-800',
  };
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cx('rounded-md border px-4 py-3 text-sm', tones[tone])}
    >
      {children}
    </div>
  );
}

/** Shows an API error message with its request ID for support. */
export function ApiErrorAlert({ error }: { error: unknown }) {
  const t = useTranslations('common');
  const message = error instanceof Error ? error.message : t('errorTitle');
  const requestId = error instanceof ApiError ? error.requestId : null;
  return (
    <Alert>
      <p>{message}</p>
      {requestId && <p className="mt-1 text-xs opacity-80">{t('requestId', { id: requestId })}</p>}
    </Alert>
  );
}

export function Card({
  title,
  children,
  className,
}: {
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx('rounded-lg border border-line bg-white p-4 sm:p-6', className)}>
      {title && <h2 className="mb-4 text-base font-semibold text-navy-800">{title}</h2>}
      {children}
    </section>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold text-navy-800">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex gap-2">{actions}</div>}
    </header>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx('animate-pulse rounded-md bg-navy-50', className)} />;
}

export function PageSkeleton() {
  const t = useTranslations('common');
  return (
    <div aria-busy="true" aria-label={t('loading')} className="flex flex-col gap-4">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-4 w-80 max-w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <p className="rounded-lg border border-dashed border-line bg-white px-4 py-10 text-center text-sm text-muted">
      {message}
    </p>
  );
}

/** Error, not-found and permission states for whole pages. */
export function PageError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const t = useTranslations('common');
  if (error instanceof ApiError && error.code === 'FORBIDDEN') return <PermissionDenied />;
  if (error instanceof ApiError && error.code === 'NOT_FOUND') {
    return (
      <Card>
        <h1 className="text-lg font-semibold text-navy-800">{t('notFoundTitle')}</h1>
        <p className="mt-2 text-sm text-muted">{t('notFoundBody')}</p>
      </Card>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-lg font-semibold text-navy-800">{t('errorTitle')}</h1>
      <ApiErrorAlert error={error} />
      {onRetry && (
        <div>
          <Button variant="secondary" onClick={onRetry}>
            {t('retry')}
          </Button>
        </div>
      )}
    </div>
  );
}

export function PermissionDenied() {
  const t = useTranslations('common');
  return (
    <Card>
      <h1 className="text-lg font-semibold text-navy-800">{t('deniedTitle')}</h1>
      <p className="mt-2 text-sm text-muted">{t('deniedBody')}</p>
      <Link href="/" className="mt-4 inline-block text-sm font-medium text-teal-700 underline">
        {t('backHome')}
      </Link>
    </Card>
  );
}

export function StatusBadge({
  tone,
  children,
}: {
  tone: 'success' | 'neutral' | 'danger' | 'warning';
  children: ReactNode;
}) {
  const tones = {
    success: 'bg-success-50 text-success',
    neutral: 'bg-navy-50 text-navy-800',
    danger: 'bg-danger-50 text-danger',
    warning: 'bg-warning-50 text-warning',
  };
  const dots = { success: 'bg-success', neutral: 'bg-navy-700', danger: 'bg-danger', warning: 'bg-warning' };
  // Text plus a dot: status never relies on colour alone.
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
        tones[tone],
      )}
    >
      <span aria-hidden className={cx('h-1.5 w-1.5 rounded-full', dots[tone])} />
      {children}
    </span>
  );
}

/** Native modal dialog: focus trapping, Escape to close and inert background come from the browser. */
export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      className="m-auto w-[calc(100%-2rem)] max-w-lg rounded-lg border border-line bg-white p-0 text-ink shadow-xl"
    >
      {open && (
        <div className="p-5 sm:p-6">
          <h2 id={titleId} className="mb-4 text-lg font-semibold text-navy-800">
            {title}
          </h2>
          {children}
        </div>
      )}
    </dialog>
  );
}
