import { useQuery } from '@tanstack/react-query';
import type { UnitList } from './materialFacts';

// The reads the Stock Material form and the Units editor share (F008-T1, T3).

/** The Unit list, Inactive entries included; a failed read carries its HTTP status. */
export const useUnitList = () =>
  useQuery<UnitList, Error & { status?: number }>({
    queryKey: ['units'],
    queryFn: async ({ signal }) => {
      const res = await fetch('/units', { credentials: 'include', signal });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
  });

/** The session's CSRF token for a catalog write, read once `enabled`, or null when there is none. */
export const useCsrfToken = (enabled: boolean) =>
  useQuery<string | null>({
    queryKey: ['stock-material-session'],
    queryFn: async ({ signal }) => {
      const res = await fetch('/auth/session-check', { credentials: 'include', signal });
      return res.ok ? ((await res.json()).csrfToken ?? null) : null;
    },
    enabled,
  });
