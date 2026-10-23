import { z } from 'zod';
import { uuid } from './common';

/** File types accepted for attachments, recognised from the file's content (never from its name). */
export const ATTACHMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export type AttachmentType = (typeof ATTACHMENT_TYPES)[number];

/** Largest file accepted: 5 MB, enough for a phone photo or a scanned bill. */
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

/** How long a download link works (SEC-003). */
export const FILE_LINK_SECONDS = 300;

/** Sent as the `fileName` query parameter with an upload; the body is the file itself. */
export const uploadQuery = z
  .object({
    fileName: z
      .string()
      .trim()
      .min(1, 'Give the file a name.')
      .max(120)
      // Folders, control characters and quotes have no place in a display name.
      .refine(
        (v) => !/[\\/"]/.test(v) && [...v].every((c) => c.charCodeAt(0) >= 0x20),
        'Use a plain file name.',
      ),
  })
  .strict();
export type UploadQuery = z.infer<typeof uploadQuery>;

export const attachmentDto = z.object({
  id: uuid,
  fileName: z.string(),
  contentType: z.enum(ATTACHMENT_TYPES),
  sizeBytes: z.number().int(),
  createdAt: z.string(),
  createdByName: z.string().nullable(),
  /** False once the record it belongs to is posted: posted records keep their files. */
  removable: z.boolean(),
});
export type AttachmentDto = z.infer<typeof attachmentDto>;

export const fileLinkDto = z.object({
  /** Relative to the site, e.g. /api/v1/files/…; works only for the person who asked for it. */
  url: z.string(),
  expiresAt: z.string(),
});
export type FileLinkDto = z.infer<typeof fileLinkDto>;
