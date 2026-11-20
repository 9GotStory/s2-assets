import { useQuery } from '@tanstack/react-query';
import type { CatalogList, UnitList } from './materialFacts';

// The reads the Stock Material form and the Units editor share (F008-T1, T3), and the Brand and Material Category
// lists (F008-T4).

// A list read at `path`; a failed read carries its HTTP status.
const readList = async (path: string, signal: AbortSignal) => {
  const res = await fetch(path, { credentials: 'include', signal });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json();
};

/** The Unit list, Inactive entries included; a failed read carries its HTTP status. */
export const useUnitList = () => useQuery<UnitList, Error & { status?: number }>({ queryKey: ['units'], queryFn: ({ signal }) => readList('/units', signal) });

/** The Brand list, Inactive entries included (F008-T4). */
export const useBrandList = () => useQuery<CatalogList, Error & { status?: number }>({ queryKey: ['brands'], queryFn: ({ signal }) => readList('/brands', signal) });

/** The Material Category list, Inactive entries included (F008-T4). */
export const useMaterialCategoryList = () =>
  useQuery<CatalogList, Error & { status?: number }>({ queryKey: ['material-categories'], queryFn: ({ signal }) => readList('/material-categories', signal) });

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
