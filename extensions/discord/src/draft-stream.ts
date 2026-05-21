import type { APIMessage } from "discord-api-types/v10";
import { createFinalizableDraftLifecycle } from "openclaw/plugin-sdk/channel-lifecycle";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createChannelMessage,
  deleteChannelMessage,
  editChannelMessage,
  listChannelMessages,
  type RequestClient,
} from "./internal/discord.js";

/** Discord messages cap at 2000 characters. */
const DISCORD_STREAM_MAX_CHARS = 2000;
const DEFAULT_THROTTLE_MS = 1200;
const DISCORD_PREVIEW_ALLOWED_MENTIONS = { parse: [] };
const MISSING_ID_RECOVERY_LIMIT = 10;
const MISSING_ID_RECOVERY_ATTEMPTS = 5;
const MISSING_ID_RECOVERY_RETRY_DELAY_MS = 500;
const MISSING_ID_RECOVERY_WINDOW_MS = 15_000;
const ORPHAN_CLEANUP_LIMIT = 10;
const ORPHAN_CLEANUP_WINDOW_MS = 30_000;
const ORPHAN_CLEANUP_MAX_PREVIEW_CHARS = 300;
const ORPHAN_CLEANUP_MIN_FINAL_DELTA_CHARS = 20;

type OrphanedPreviewCandidate = {
  text: string;
  sentAtMs: number;
  replyToMessageId?: string;
};

type DiscordDraftStream = {
  update: (text: string) => void;
  flush: () => Promise<void>;
  messageId: () => string | undefined;
  clear: () => Promise<void>;
  discardPending: () => Promise<void>;
  seal: () => Promise<void>;
  stop: () => Promise<void>;
  /** Reset internal state so the next update creates a new message instead of editing. */
  forceNewMessage: () => void;
  /** Best-effort cleanup for a preview that Discord may have accepted but did not return an id for. */
  clearOrphanedPreview: (finalText: string) => Promise<void>;
};

export function createDiscordDraftStream(params: {
  rest: RequestClient;
  channelId: string;
  maxChars?: number;
  replyToMessageId?: string | (() => string | undefined);
  botUserId?: string;
  throttleMs?: number;
  /** Minimum chars before sending first message (debounce for push notifications) */
  minInitialChars?: number;
  missingIdRecoveryAttempts?: number;
  missingIdRecoveryRetryDelayMs?: number;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}): DiscordDraftStream {
  const maxChars = Math.min(params.maxChars ?? DISCORD_STREAM_MAX_CHARS, DISCORD_STREAM_MAX_CHARS);
  const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
  const minInitialChars = params.minInitialChars;
  const channelId = params.channelId;
  const rest = params.rest;
  const resolveReplyToMessageId = () =>
    typeof params.replyToMessageId === "function"
      ? params.replyToMessageId()
      : params.replyToMessageId;

  const streamState = { stopped: false, final: false };
  let streamMessageId: string | undefined;
  let lastSentText = "";
  let orphanedPreviewCandidate: OrphanedPreviewCandidate | undefined;

  const sendOrEditStreamMessage = async (text: string): Promise<boolean> => {
    // Allow final flush even if stopped (e.g., after clear()).
    if (streamState.stopped && !streamState.final) {
      return false;
    }
    const trimmed = text.trimEnd();
    if (!trimmed) {
      return false;
    }
    if (trimmed.length > maxChars) {
      // Discord messages cap at 2000 chars.
      // Stop streaming once we exceed the cap to avoid repeated API failures.
      streamState.stopped = true;
      params.warn?.(`discord stream preview stopped (text length ${trimmed.length} > ${maxChars})`);
      return false;
    }
    if (trimmed === lastSentText) {
      return true;
    }

    // Debounce first preview send for better push notification quality.
    if (streamMessageId === undefined && minInitialChars != null && !streamState.final) {
      if (trimmed.length < minInitialChars) {
        return false;
      }
    }

    lastSentText = trimmed;
    try {
      if (streamMessageId !== undefined) {
        // Edit existing message
        await editChannelMessage(rest, channelId, streamMessageId, {
          body: { content: trimmed, allowed_mentions: DISCORD_PREVIEW_ALLOWED_MENTIONS },
        });
        return true;
      }
      // Send new message
      const replyToMessageId = resolveReplyToMessageId()?.trim();
      const messageReference = replyToMessageId
        ? { message_id: replyToMessageId, fail_if_not_exists: false }
        : undefined;
      const sendStartedAtMs = Date.now();
      const sent = await createChannelMessage<{ id?: string }>(rest, channelId, {
        body: {
          content: trimmed,
          allowed_mentions: DISCORD_PREVIEW_ALLOWED_MENTIONS,
          ...(messageReference ? { message_reference: messageReference } : {}),
        },
      });
      const sentMessageId = sent?.id;
      if (typeof sentMessageId !== "string" || !sentMessageId) {
        const recoveredMessageId = await recoverMissingPreviewMessageId({
          rest,
          channelId,
          text: trimmed,
          ...(params.botUserId ? { botUserId: params.botUserId } : {}),
          ...(replyToMessageId ? { replyToMessageId } : {}),
          sentAtMs: sendStartedAtMs,
          attempts: params.missingIdRecoveryAttempts ?? MISSING_ID_RECOVERY_ATTEMPTS,
          retryDelayMs: params.missingIdRecoveryRetryDelayMs ?? MISSING_ID_RECOVERY_RETRY_DELAY_MS,
          ...(params.warn ? { warn: params.warn } : {}),
        });
        if (recoveredMessageId) {
          streamMessageId = recoveredMessageId;
          orphanedPreviewCandidate = undefined;
          params.warn?.(
            `discord stream preview recovered missing message id (${recoveredMessageId})`,
          );
          return true;
        }
        orphanedPreviewCandidate = {
          text: trimmed,
          sentAtMs: sendStartedAtMs,
          ...(replyToMessageId ? { replyToMessageId } : {}),
        };
        streamState.stopped = true;
        params.warn?.(
          `discord stream preview stopped (missing message id from send; orphan cleanup armed, textLength=${trimmed.length})`,
        );
        return false;
      }
      streamMessageId = sentMessageId;
      orphanedPreviewCandidate = undefined;
      return true;
    } catch (err) {
      streamState.stopped = true;
      params.warn?.(`discord stream preview failed: ${formatErrorMessage(err)}`);
      return false;
    }
  };

  const readMessageId = () => streamMessageId;
  const clearMessageId = () => {
    streamMessageId = undefined;
  };
  const isValidStreamMessageId = (value: unknown): value is string => typeof value === "string";
  const deleteStreamMessage = async (messageId: string) => {
    await deleteChannelMessage(rest, channelId, messageId);
  };

  const { loop, update, stop, clear, discardPending, seal } = createFinalizableDraftLifecycle({
    throttleMs,
    state: streamState,
    sendOrEditStreamMessage,
    readMessageId,
    clearMessageId,
    isValidMessageId: isValidStreamMessageId,
    deleteMessage: deleteStreamMessage,
    warn: params.warn,
    warnPrefix: "discord stream preview cleanup failed",
  });

  const forceNewMessage = () => {
    streamMessageId = undefined;
    lastSentText = "";
    loop.resetPending();
  };

  const clearOrphanedPreview = async (finalText: string): Promise<void> => {
    if (streamMessageId || !orphanedPreviewCandidate) {
      return;
    }
    const candidate = orphanedPreviewCandidate;
    const normalizedFinalText = finalText.trimEnd();
    if (!isStrictFinalPrefix(candidate.text, normalizedFinalText)) {
      return;
    }
    try {
      const messages = await listChannelMessages(rest, channelId, {
        limit: ORPHAN_CLEANUP_LIMIT,
      });
      const message = messages.find((entry) =>
        isRecoverableOrphanedPreviewMessage(entry, {
          ...candidate,
          finalText: normalizedFinalText,
          ...(params.botUserId ? { botUserId: params.botUserId } : {}),
        }),
      );
      if (!message?.id) {
        params.warn?.(
          `discord stream preview orphan cleanup missed (textLength=${candidate.text.length})`,
        );
        return;
      }
      await deleteChannelMessage(rest, channelId, message.id);
      orphanedPreviewCandidate = undefined;
      params.warn?.(`discord stream preview deleted orphaned preview (${message.id})`);
    } catch (err) {
      params.warn?.(`discord stream preview orphan cleanup failed: ${formatErrorMessage(err)}`);
    }
  };

  params.log?.(`discord stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);

  return {
    update,
    flush: loop.flush,
    messageId: () => streamMessageId,
    clear,
    discardPending,
    seal,
    stop,
    forceNewMessage,
    clearOrphanedPreview,
  };
}

async function recoverMissingPreviewMessageId(params: {
  rest: RequestClient;
  channelId: string;
  text: string;
  botUserId?: string;
  replyToMessageId?: string;
  sentAtMs: number;
  attempts: number;
  retryDelayMs: number;
  warn?: (message: string) => void;
}): Promise<string | undefined> {
  try {
    const attempts = Math.max(1, Math.floor(params.attempts));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const match = await findRecentPreviewMessageId(params);
      if (match) {
        return match;
      }
      if (attempt < attempts - 1) {
        await sleep(params.retryDelayMs);
      }
    }
    return undefined;
  } catch (err) {
    params.warn?.(`discord stream preview id recovery failed: ${formatErrorMessage(err)}`);
    return undefined;
  }
}

async function findRecentPreviewMessageId(params: {
  rest: RequestClient;
  channelId: string;
  text: string;
  botUserId?: string;
  replyToMessageId?: string;
  sentAtMs: number;
}): Promise<string | undefined> {
  const messages = await listChannelMessages(params.rest, params.channelId, {
    limit: MISSING_ID_RECOVERY_LIMIT,
  });
  return messages.find((message) => isRecoverablePreviewMessage(message, params))?.id;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRecoverablePreviewMessage(
  message: APIMessage,
  params: {
    text: string;
    botUserId?: string;
    replyToMessageId?: string;
    sentAtMs: number;
  },
): boolean {
  if (!message.id || message.content !== params.text) {
    return false;
  }
  const authorId = message.author?.id;
  const authorMatches =
    params.botUserId !== undefined ? authorId === params.botUserId : message.author?.bot === true;
  if (!authorMatches) {
    return false;
  }
  if (
    params.replyToMessageId &&
    message.message_reference?.message_id !== params.replyToMessageId
  ) {
    return false;
  }
  const timestampMs = Date.parse(message.timestamp);
  if (!Number.isFinite(timestampMs)) {
    return false;
  }

  // Discord can visibly create the preview message even when our request path
  // fails to surface the created id. Recovering the id lets final delivery edit
  // that same preview instead of sending a second final message.
  return Math.abs(timestampMs - params.sentAtMs) <= MISSING_ID_RECOVERY_WINDOW_MS;
}

function isStrictFinalPrefix(previewText: string, finalText: string): boolean {
  const trimmedPreview = previewText.trimEnd();
  return (
    trimmedPreview.length > 0 &&
    trimmedPreview.length <= ORPHAN_CLEANUP_MAX_PREVIEW_CHARS &&
    finalText.startsWith(trimmedPreview) &&
    finalText.length >= trimmedPreview.length + ORPHAN_CLEANUP_MIN_FINAL_DELTA_CHARS
  );
}

function isRecoverableOrphanedPreviewMessage(
  message: APIMessage,
  params: OrphanedPreviewCandidate & {
    finalText: string;
    botUserId?: string;
  },
): boolean {
  if (!message.id || message.content !== params.text) {
    return false;
  }
  if (!isStrictFinalPrefix(message.content, params.finalText)) {
    return false;
  }
  const authorId = message.author?.id;
  const authorMatches =
    params.botUserId !== undefined ? authorId === params.botUserId : message.author?.bot === true;
  if (!authorMatches) {
    return false;
  }
  if (
    params.replyToMessageId &&
    message.message_reference?.message_id !== params.replyToMessageId
  ) {
    return false;
  }
  if ((message.attachments?.length ?? 0) > 0 || (message.embeds?.length ?? 0) > 0) {
    return false;
  }
  const timestampMs = Date.parse(message.timestamp);
  if (!Number.isFinite(timestampMs)) {
    return false;
  }
  return Math.abs(timestampMs - params.sentAtMs) <= ORPHAN_CLEANUP_WINDOW_MS;
}
