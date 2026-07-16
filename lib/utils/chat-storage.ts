/**
 * Chat Storage — thin delegates over the Supabase data-access layer (Stage C2).
 *
 * Read+write moved together: save/load/delete now call the drop-in functions in
 * `@/lib/supabase/queries`. The exported names/signatures are unchanged so
 * stage-storage.ts keeps importing them as-is.
 *
 * The 4 save invariants live VERBATIM in queries.replaceChatSessions:
 *   (1) empty sessions array => delete all for the course,
 *   (2) status 'active' -> 'interrupted',
 *   (3) messages sliced to last MAX_CHAT_MESSAGES (200 == the old
 *       MAX_MESSAGES_PER_SESSION = 200),
 *   (4) pendingToolCalls forced to [] on save and on read.
 */

import type { ChatSession } from '@/lib/types/chat';
import {
  replaceChatSessions,
  getChatSessions,
  deleteChatSessions as deleteChatSessionsDb,
} from '@/lib/supabase/queries';

/** Save (full-replace) chat sessions for a stage. See queries.replaceChatSessions. */
export async function saveChatSessions(stageId: string, sessions: ChatSession[]): Promise<void> {
  return replaceChatSessions(stageId, sessions);
}

/** Load chat sessions for a stage (sorted createdAt ASC; pendingToolCalls always []). */
export async function loadChatSessions(stageId: string): Promise<ChatSession[]> {
  return getChatSessions(stageId);
}

/** Delete all chat sessions for a stage. Redundant with course CASCADE once the
 *  C2 FK is applied, but harmless (idempotent) and keeps the chat-storage contract. */
export async function deleteChatSessions(stageId: string): Promise<void> {
  return deleteChatSessionsDb(stageId);
}
