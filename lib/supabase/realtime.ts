'use client';
import { useEffect, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { createLogger } from '@/lib/logger';

const log = createLogger('Realtime');

/**
 * Live-refresh the course list. Subscribes a `postgres_changes` channel to the
 * `course` table filtered to the signed-in user; on any INSERT/UPDATE/DELETE it
 * calls `onChange()` (the host's existing refresh, which re-runs listCourses()).
 * RLS scopes the subscription server-side so a user only ever receives events
 * for their own rows — the `user_id=eq.<uid>` filter is belt-and-suspenders.
 * Unsubscribes on unmount.
 */
export function useCourseRealtime(onChange: () => void) {
  // Hold the latest onChange without making the effect re-subscribe every render.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const supabase = createClient();
    let unsubscribe: (() => void) | null = null;
    let cancelled = false;

    supabase.auth.getUser().then(({ data, error }) => {
      if (cancelled) return;
      const userId = data.user?.id;
      if (error || !userId) {
        log.warn('useCourseRealtime: not subscribed (', error?.message ?? 'no session', ')');
        return;
      }
      const channel = supabase
        .channel('postgres_changes')
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'course',
            filter: 'user_id=eq.' + userId,
          },
          () => onChangeRef.current(),
        )
        .subscribe();
      unsubscribe = () => supabase.removeChannel(channel);
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);
}
