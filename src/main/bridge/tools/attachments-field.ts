import { z } from 'zod'
import { WORKER_ATTACHMENTS_MAX } from '../../attachments/worker-attachments'

/** The `attachments` field of `spawn_worker` and `message_worker`: ids from the user's messages. */
export const attachmentsField = z
  .array(z.string().min(1))
  .max(WORKER_ATTACHMENTS_MAX)
  .refine((ids) => new Set(ids).size === ids.length, 'each attachment id may be listed once')
  .optional()
  .describe(
    `Ids of files the user attached to a message, to give the worker: the first column of the "[Attachments for this message]" blocks you were shown. At most ${WORKER_ATTACHMENTS_MAX}, each once. The worker gets the files read only, with their names and paths. Pass only the ones the task needs. An id that is not an attachment of this session is refused with unknown_attachment, and nothing is started or sent.`
  )
