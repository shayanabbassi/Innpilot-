'use client';

import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_TYPES,
  type AttachmentDto,
  type FileLinkDto,
} from '@innpilot/contracts';
import { useFormatter, useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { Alert, ApiErrorAlert, Button, Dialog, TextField } from '@/components/ui';

const ACCEPT = [...ATTACHMENT_TYPES, '.pdf', '.jpg', '.jpeg', '.png'].join(',');

/**
 * Files on a record (slice 6.2): receipts on an expense, identity scans on a guest. Opening a file asks the API
 * for a fresh five-minute link and opens it in a new tab; nothing is cached in the page. The size and type checks
 * here only save a wasted upload: the server checks the content again.
 */
export function AttachmentList({
  files,
  upload,
  link,
  remove,
  askReason = false,
  emptyText,
  note,
}: {
  files: AttachmentDto[];
  /** Omit when the user may not add files here. */
  upload?: (file: File) => Promise<unknown>;
  link: (id: string, reason?: string) => Promise<FileLinkDto>;
  /** Omit when files cannot be removed (the button also follows each file's `removable`). */
  remove?: (id: string) => Promise<unknown>;
  /** Identity scans: opening needs a reason, which is audited. */
  askReason?: boolean;
  emptyText: string;
  note?: string;
}) {
  const t = useTranslations('files');
  const format = useFormatter();
  const input = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<unknown>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [opening, setOpening] = useState<AttachmentDto | null>(null);
  const [removing, setRemoving] = useState<AttachmentDto | null>(null);

  const choose = async (file: File | undefined) => {
    if (!file || !upload) return;
    setError(null);
    setProblem(null);
    if (file.size > ATTACHMENT_MAX_BYTES) return setProblem(t('tooLarge'));
    if (file.type && !(ATTACHMENT_TYPES as readonly string[]).includes(file.type))
      return setProblem(t('wrongType'));
    setUploading(true);
    try {
      await upload(file);
    } catch (err) {
      setError(err);
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  };

  /** Opens the tab inside the click (so it is not blocked as a pop-up), then points it at the new link. */
  const open = async (file: AttachmentDto, reason?: string) => {
    setError(null);
    const tab = window.open('', '_blank');
    try {
      const { url } = await link(file.id, reason);
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      } else {
        window.location.assign(url);
      }
      setOpening(null);
    } catch (err) {
      tab?.close();
      setError(err);
      setOpening(null);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {error !== null && <ApiErrorAlert error={error} />}
      {problem && <Alert>{problem}</Alert>}
      {files.length === 0 ? (
        <p className="text-sm text-muted">{emptyText}</p>
      ) : (
        <ul className="divide-y divide-line text-sm">
          {files.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="min-w-0">
                <span className="block break-all font-medium text-ink">{f.fileName}</span>
                <span className="block text-xs text-muted">
                  {t('line', {
                    size: size(f.sizeBytes),
                    name: f.createdByName ?? '—',
                    date: format.dateTime(new Date(f.createdAt), { dateStyle: 'medium', timeStyle: 'short' }),
                  })}
                </span>
              </span>
              <span className="flex gap-1">
                <Button
                  variant="ghost"
                  className="min-h-8 px-2"
                  onClick={() => (askReason ? setOpening(f) : void open(f))}
                >
                  {t('open')}
                </Button>
                {remove && f.removable && (
                  <Button variant="ghost" className="min-h-8 px-2" onClick={() => setRemoving(f)}>
                    {t('remove')}
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {note && <p className="text-xs text-muted">{note}</p>}
      {upload && (
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={input}
            type="file"
            accept={ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => void choose(e.target.files?.[0])}
          />
          <Button variant="secondary" busy={uploading} onClick={() => input.current?.click()}>
            {uploading ? t('uploading') : t('add')}
          </Button>
          <span className="text-xs text-muted">{t('hint')}</span>
        </div>
      )}
      {opening && (
        <ReasonDialog file={opening} onClose={() => setOpening(null)} onOpen={(r) => open(opening, r)} />
      )}
      {removing && remove && (
        <RemoveDialog
          file={removing}
          onClose={() => setRemoving(null)}
          onRemove={async () => {
            await remove(removing.id);
            setRemoving(null);
          }}
        />
      )}
    </div>
  );
}

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function ReasonDialog({
  file,
  onClose,
  onOpen,
}: {
  file: AttachmentDto;
  onClose: () => void;
  onOpen: (reason: string) => Promise<void>;
}) {
  const t = useTranslations('files');
  const tCommon = useTranslations('common');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = reason.trim().length >= 3;
  return (
    <Dialog open onClose={onClose} title={t('reasonTitle', { name: file.fileName })}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ok || busy) return;
          setBusy(true);
          void onOpen(reason.trim()).finally(() => setBusy(false));
        }}
      >
        <p className="text-sm text-muted">{t('reasonBody')}</p>
        <TextField
          label={t('reasonLabel')}
          value={reason}
          maxLength={300}
          onChange={(e) => setReason(e.target.value)}
        />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {tCommon('cancel')}
          </Button>
          <Button type="submit" busy={busy} disabled={!ok}>
            {t('openConfirm')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RemoveDialog({
  file,
  onClose,
  onRemove,
}: {
  file: AttachmentDto;
  onClose: () => void;
  onRemove: () => Promise<void>;
}) {
  const t = useTranslations('files');
  const tCommon = useTranslations('common');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Dialog open onClose={onClose} title={t('removeTitle', { name: file.fileName })}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">{t('removeBody')}</p>
        {error !== null && <ApiErrorAlert error={error} />}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {tCommon('cancel')}
          </Button>
          <Button
            variant="danger"
            busy={busy}
            onClick={() => {
              setBusy(true);
              setError(null);
              onRemove().catch((err: unknown) => {
                setError(err);
                setBusy(false);
              });
            }}
          >
            {t('remove')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
