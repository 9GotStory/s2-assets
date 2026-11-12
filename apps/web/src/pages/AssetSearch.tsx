import React, { useEffect, useState, useRef, useCallback } from 'react';
import { useNavigate, Link } from 'react-router';
import { AssetSelectionBar, SELECTION_MAX_ASSETS, type SelectedAsset } from '../components/AssetSelection';
import { BulkReassignmentPanel, assetLabelOf } from '../components/BulkReassignmentPanel';
import { OnLoanBadge } from '../components/LoanBadges';
import { LoanStartForm } from '../components/LoanStartForm';
import { ON_LOAN_LABEL, type OnLoan, type StartLoanWarning } from '../components/loanFacts';
import { UnderRepairBadge } from '../components/RepairBadges';
import { UNDER_REPAIR_FILTER_LABEL, type UnderRepair } from '../components/repairFacts';
import {
  REFERENCE_DIMENSIONS,
  entryLabel,
  useReferenceLists,
  type ReferenceEntry,
  type ReferenceIdField,
} from '../components/ReferenceContextFields';

export interface SearchAssetItem {
  id: string;
  name: string | null;
  asset_number: string | null;
  serial_number: string | null;
  location?: ReferenceEntry | null;
  organization_unit?: ReferenceEntry | null;
  responsible_person?: ReferenceEntry | null;
  legacy_location_text?: string | null;
  legacy_organization_unit_text?: string | null;
  legacy_responsible_person_text?: string | null;
  // F004-T4 (#78): who holds it while On Loan; F005-T2 (#100): its Start Loan warning.
  on_loan: OnLoan | null;
  start_loan_warning: StartLoanWarning | null;
  // F005-T4 (#102): the Repair Record that keeps it Under Repair.
  under_repair: UnderRepair | null;
}

export interface SearchAssetResult {
  items: SearchAssetItem[];
  limit: number;
  offset: number;
  total_count: number;
  has_more: boolean;
  // Whether the viewer holds 'assignment:reassign' (F003-T5).
  can_reassign: boolean;
  // Whether the viewer holds 'loan:record' (F004-T4).
  can_record_loan: boolean;
}

// T4 (#25): each legacy reference text is its own field, keeping the dimensions distinct.
export type SearchFieldType =
  | 'all'
  | 'name'
  | 'asset_number'
  | 'serial_number'
  | 'stable_id'
  | (typeof REFERENCE_DIMENSIONS)[number]['legacyField'];

// T4 (#25): one exact entry per dimension, '' for any; the server combines them with AND. F003-T4
// (#54): has_assignment_conflict is 'true' to list only Assets with an Assignment Conflict, '' for any.
// F004-T4 (#78): on_loan likewise, for "กำลังถูกยืม"; F005-T4 (#102): under_repair, for Under Repair.
export type AssetListFilters = Record<ReferenceIdField | 'has_assignment_conflict' | 'on_loan' | 'under_repair', string>;

const NO_FILTERS: AssetListFilters = {
  location_id: '',
  organization_unit_id: '',
  responsible_person_id: '',
  has_assignment_conflict: '',
  on_loan: '',
  under_repair: '',
};

// The rows chosen act through one of these, opened above the results.
type SelectionPanel = 'REASSIGNMENT' | 'LOAN';

const selectedAssetOf = ({ id, name, asset_number, on_loan, under_repair, start_loan_warning }: SearchAssetItem): SelectedAsset => ({
  id,
  name,
  asset_number,
  on_loan,
  under_repair,
  start_loan_warning,
});

// The selection with each of its rows as `items` read it last, so that a form opened later shows the latest.
const withLatestRows = (selection: Map<string, SelectedAsset>, items: SearchAssetItem[]): Map<string, SelectedAsset> => {
  const fresh = items.filter(({ id }) => selection.has(id));
  if (fresh.length === 0) {
    return selection;
  }
  const next = new Map(selection);
  for (const item of fresh) {
    next.set(item.id, selectedAssetOf(item));
  }
  return next;
};

export const AssetSearch: React.FC = () => {
  const navigate = useNavigate();

  // Form input state
  const [selectedField, setSelectedField] = useState<SearchFieldType>('all');
  const [searchValue, setSearchValue] = useState<string>('');
  const [selectedFilters, setSelectedFilters] = useState<AssetListFilters>(NO_FILTERS);

  // Active query state (what the current results reflect)
  const [activeField, setActiveField] = useState<SearchFieldType>('all');
  const [activeValue, setActiveValue] = useState<string>('');
  const [activeFilters, setActiveFilters] = useState<AssetListFilters>(NO_FILTERS);
  const [offset, setOffset] = useState<number>(0);
  const limit = 25;

  // Search results state (ephemeral in-memory only)
  const [results, setResults] = useState<SearchAssetItem[] | null>(null);
  const [totalCount, setTotalCount] = useState<number>(0);
  const [hasMore, setHasMore] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isForbidden, setIsForbidden] = useState<boolean>(false);

  // F003-T5 (#55): the rows chosen for "ย้ายหลายรายการ", kept across pages and searches; F004-T4 (#78):
  // and for "บันทึกการยืม".
  const [canReassign, setCanReassign] = useState<boolean>(false);
  const [canRecordLoan, setCanRecordLoan] = useState<boolean>(false);
  const [csrfToken, setCsrfToken] = useState<string | null>(null);
  const [selection, setSelection] = useState<Map<string, SelectedAsset>>(() => new Map());
  const [openPanel, setOpenPanel] = useState<SelectionPanel | null>(null);

  // Filter lists, loaded for the verified actor (inactive entries included: Assets may still name them)
  const [listActorId, setListActorId] = useState<string | null>(null);
  const referenceLists = useReferenceLists(true, listActorId);

  // Generation tracking, abort control, and actor binding
  const searchGenRef = useRef<number>(0);
  const abortControllerRef = useRef<AbortController | null>(null);
  const currentActorIdRef = useRef<string | null>(null);
  const isMountedRef = useRef<boolean>(true);

  // Active query refs for revalidation re-fetch
  const activeFieldRef = useRef<SearchFieldType>(activeField);
  const activeValueRef = useRef<string>(activeValue);
  const activeFiltersRef = useRef<AssetListFilters>(activeFilters);
  const offsetRef = useRef<number>(offset);

  useEffect(() => {
    activeFieldRef.current = activeField;
    activeValueRef.current = activeValue;
    activeFiltersRef.current = activeFilters;
    offsetRef.current = offset;
  }, [activeField, activeValue, activeFilters, offset]);

  // Clear in-memory protected search state
  const clearSearchState = useCallback(() => {
    setResults(null);
    setTotalCount(0);
    setHasMore(false);
    setErrorMessage(null);
    setIsForbidden(false);
    setIsLoading(false);
    setCanReassign(false);
    setCanRecordLoan(false);
  }, []);

  // Verify authenticated session and bind actor with generation guarding
  const verifySession = useCallback(
    async (
      targetGen: number,
      signal?: AbortSignal
    ): Promise<{ valid: boolean; actorId?: string; actorChanged?: boolean }> => {
      try {
        const res = await fetch('/auth/session-check', {
          method: 'GET',
          credentials: 'include',
          signal,
        });

        // Guard: Discard obsolete or aborted response immediately before any side effects!
        if (targetGen !== searchGenRef.current || signal?.aborted || !isMountedRef.current) {
          return { valid: false };
        }

        if (!res.ok) {
          if (targetGen === searchGenRef.current && isMountedRef.current && !signal?.aborted) {
            clearSearchState();
            currentActorIdRef.current = null;
            navigate('/login', { replace: true });
          }
          return { valid: false };
        }

        let data: any = null;
        try {
          data = await res.json();
        } catch (parseErr: unknown) {
          if (
            signal?.aborted ||
            !isMountedRef.current ||
            targetGen !== searchGenRef.current ||
            (parseErr instanceof DOMException && parseErr.name === 'AbortError')
          ) {
            return { valid: false };
          }
          data = null;
        }

        // Guard: Discard obsolete or aborted response after body parsing!
        if (targetGen !== searchGenRef.current || signal?.aborted || !isMountedRef.current) {
          return { valid: false };
        }

        const actorId = data?.user?.id;
        if (!actorId) {
          if (targetGen === searchGenRef.current && isMountedRef.current && !signal?.aborted) {
            clearSearchState();
            currentActorIdRef.current = null;
            navigate('/login', { replace: true });
          }
          return { valid: false };
        }

        const actorChanged =
          currentActorIdRef.current !== null && currentActorIdRef.current !== actorId;
        if (actorChanged) {
          // Actor changed: reset search state and criteria immediately
          clearSearchState();
          setSelectedField('all');
          setSearchValue('');
          setSelectedFilters(NO_FILTERS);
          activeFieldRef.current = 'all';
          activeValueRef.current = '';
          activeFiltersRef.current = NO_FILTERS;
          offsetRef.current = 0;
          setSelection(new Map());
          setOpenPanel(null);
        }
        currentActorIdRef.current = actorId;
        setCsrfToken(data?.csrfToken ?? null);
        return { valid: true, actorId, actorChanged };
      } catch (err: unknown) {
        if (
          signal?.aborted ||
          !isMountedRef.current ||
          targetGen !== searchGenRef.current ||
          (err instanceof DOMException && err.name === 'AbortError')
        ) {
          return { valid: false };
        }
        if (targetGen === searchGenRef.current && isMountedRef.current) {
          clearSearchState();
          currentActorIdRef.current = null;
          navigate('/login', { replace: true });
        }
        return { valid: false };
      }
    },
    [navigate, clearSearchState]
  );

  // Execute search with generation tracking and actor epoch binding
  const executeSearch = useCallback(
    async (field: SearchFieldType, value: string, targetOffset: number, filters: AssetListFilters) => {
      // 1. Invalidate/abort obsolete requests before awaiting
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }

      const controller = new AbortController();
      abortControllerRef.current = controller;
      const currentGen = ++searchGenRef.current;

      // 2. Hide protected data before awaiting session validation
      clearSearchState();
      setIsLoading(true);
      setErrorMessage(null);
      setIsForbidden(false);

      // 3. Await session check with targetGen and controller signal
      const session = await verifySession(currentGen, controller.signal);
      if (
        !session.valid ||
        currentGen !== searchGenRef.current ||
        !isMountedRef.current ||
        controller.signal.aborted
      ) {
        if (currentGen === searchGenRef.current && isMountedRef.current) {
          setIsLoading(false);
        }
        return;
      }
      const capturedActorId = session.actorId;
      const effectiveField = session.actorChanged ? 'all' : field;
      const effectiveValue = session.actorChanged ? '' : value;
      const effectiveFilters = session.actorChanged ? NO_FILTERS : filters;
      const effectiveOffset = session.actorChanged ? 0 : targetOffset;
      setListActorId(capturedActorId ?? null);

      try {
        const queryParams = new URLSearchParams();
        // Finding 2: Literal nonempty whitespace string is an exact selector, not an empty browse
        if (effectiveField !== 'all' && effectiveValue !== '') {
          queryParams.set('field', effectiveField);
          queryParams.set('value', effectiveValue);
        }
        for (const [filter, filterValue] of Object.entries(effectiveFilters)) {
          if (filterValue) {
            queryParams.set(filter, filterValue);
          }
        }
        queryParams.set('limit', String(limit));
        queryParams.set('offset', String(effectiveOffset));

        const response = await fetch(`/assets/search?${queryParams.toString()}`, {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
        });

        // Discard response if superseded by a newer search request or actor changed or unmounted
        if (
          !isMountedRef.current ||
          currentGen !== searchGenRef.current ||
          controller.signal.aborted ||
          currentActorIdRef.current !== capturedActorId
        ) {
          return;
        }

        if (response.status === 401) {
          clearSearchState();
          currentActorIdRef.current = null;
          navigate('/login', { replace: true });
          return;
        }

        if (response.status === 403) {
          clearSearchState();
          setIsForbidden(true);
          setErrorMessage('คุณไม่มีสิทธิ์ในการค้นหาข้อมูลครุภัณฑ์ (403 Forbidden)');
          return;
        }

        if (!response.ok) {
          const errorData = await response.json().catch(() => null);
          if (
            !isMountedRef.current ||
            currentGen !== searchGenRef.current ||
            controller.signal.aborted ||
            currentActorIdRef.current !== capturedActorId
          ) {
            return;
          }
          const errorDetails = errorData?.error?.details
            ? Object.values(errorData.error.details).join(', ')
            : errorData?.error?.message || 'การค้นหาล้มเหลว กรุณาตรวจสอบเงื่อนไข';
          setErrorMessage(errorDetails);
          setResults([]);
          setTotalCount(0);
          setHasMore(false);
          return;
        }

        // Parse response body and re-verify generation and actor
        let data: SearchAssetResult;
        try {
          data = await response.json();
        } catch (parseErr: unknown) {
          if (
            controller.signal.aborted ||
            !isMountedRef.current ||
            currentGen !== searchGenRef.current ||
            (parseErr instanceof DOMException && parseErr.name === 'AbortError')
          ) {
            return;
          }
          throw parseErr;
        }

        if (
          isMountedRef.current &&
          currentGen === searchGenRef.current &&
          !controller.signal.aborted &&
          currentActorIdRef.current === capturedActorId
        ) {
          setResults(data.items);
          setTotalCount(data.total_count);
          setHasMore(data.has_more);
          setCanReassign(data.can_reassign === true);
          setCanRecordLoan(data.can_record_loan === true);
          setSelection((current) => withLatestRows(current, data.items));
          setOffset(data.offset);
          setActiveField(effectiveField);
          setActiveValue(effectiveValue);
          setActiveFilters(effectiveFilters);
        }
      } catch (err: unknown) {
        if (
          controller.signal.aborted ||
          !isMountedRef.current ||
          currentGen !== searchGenRef.current ||
          (err instanceof DOMException && err.name === 'AbortError')
        ) {
          return;
        }
        if (
          isMountedRef.current &&
          currentGen === searchGenRef.current &&
          currentActorIdRef.current === capturedActorId
        ) {
          setErrorMessage('เกิดข้อผิดพลาดในการเชื่อมต่อเครือข่าย');
        }
      } finally {
        if (
          isMountedRef.current &&
          currentGen === searchGenRef.current &&
          currentActorIdRef.current === capturedActorId
        ) {
          setIsLoading(false);
        }
      }
    },
    [limit, navigate, verifySession, clearSearchState]
  );

  // Focus and visibility return revalidation
  useEffect(() => {
    isMountedRef.current = true;
    let isWindowBlurred = false;

    const handleBlur = () => {
      isWindowBlurred = true;
    };

    const handleFocus = () => {
      if (isWindowBlurred) {
        isWindowBlurred = false;
        executeSearch(activeFieldRef.current, activeValueRef.current, offsetRef.current, activeFiltersRef.current);
      }
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && isWindowBlurred) {
        isWindowBlurred = false;
        executeSearch(activeFieldRef.current, activeValueRef.current, offsetRef.current, activeFiltersRef.current);
      } else if (document.visibilityState === 'hidden') {
        isWindowBlurred = true;
      }
    };

    window.addEventListener('blur', handleBlur);
    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      isMountedRef.current = false;
      ++searchGenRef.current;
      abortControllerRef.current?.abort();
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [verifySession, clearSearchState, executeSearch]);

  // Initial browse on mount
  useEffect(() => {
    isMountedRef.current = true;
    executeSearch('all', '', 0, NO_FILTERS);
    return () => {
      isMountedRef.current = false;
      ++searchGenRef.current;
      abortControllerRef.current?.abort();
    };
  }, [executeSearch]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    executeSearch(selectedField, searchValue, 0, selectedFilters);
  };

  const handleReset = () => {
    setSelectedField('all');
    setSearchValue('');
    setSelectedFilters(NO_FILTERS);
    executeSearch('all', '', 0, NO_FILTERS);
  };

  const handlePrevPage = () => {
    const prevOffset = Math.max(0, offset - limit);
    executeSearch(activeField, activeValue, prevOffset, activeFilters);
  };

  const handleNextPage = () => {
    if (hasMore) {
      const nextOffset = offset + limit;
      executeSearch(activeField, activeValue, nextOffset, activeFilters);
    }
  };

  const toggleSelected = (item: SearchAssetItem) => {
    setSelection((current) => {
      const next = new Map(current);
      if (next.has(item.id)) {
        next.delete(item.id);
      } else if (next.size < SELECTION_MAX_ASSETS) {
        next.set(item.id, selectedAssetOf(item));
      }
      return next;
    });
  };

  // After a save, the list is read again with nothing selected.
  const handleSelectionSaved = () => {
    setSelection(new Map());
    setOpenPanel(null);
    executeSearch(activeField, activeValue, offset, activeFilters);
  };

  const canSelect = canReassign || canRecordLoan;

  return (
    <main
      style={{
        minHeight: '100vh',
        backgroundColor: '#f3f4f6',
        padding: '2rem 1rem',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
      }}
    >
      <div
        style={{
          maxWidth: '1000px',
          margin: '0 auto',
          backgroundColor: '#ffffff',
          borderRadius: '8px',
          boxShadow: '0 1px 3px 0 rgba(0, 0, 0, 0.1), 0 1px 2px 0 rgba(0, 0, 0, 0.06)',
          padding: '2rem',
        }}
      >
        {/* Navigation & Header */}
        <nav
          aria-label="เมนูนำทางหลัก"
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '1.5rem',
            borderBottom: '1px solid #e5e7eb',
            paddingBottom: '1rem',
          }}
        >
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
            <Link
              to="/dashboard"
              id="back-dashboard-link"
              style={{
                color: '#4b5563',
                textDecoration: 'none',
                fontSize: '0.875rem',
                fontWeight: 500,
              }}
            >
              ← กลับสู่แดชบอร์ด
            </Link>
            <span style={{ color: '#d1d5db' }}>|</span>
            <Link
              to="/assets/register"
              id="link-asset-register"
              style={{
                color: '#2563eb',
                textDecoration: 'none',
                fontSize: '0.875rem',
                fontWeight: 500,
              }}
            >
              + ลงทะเบียนครุภัณฑ์
            </Link>
          </div>
        </nav>

        <header style={{ marginBottom: '1.5rem' }}>
          <h1
            style={{
              fontSize: '1.5rem',
              fontWeight: 700,
              color: '#111827',
              margin: '0 0 0.5rem 0',
            }}
          >
            ค้นหาและตรวจสอบครุภัณฑ์ (Asset Search)
          </h1>
          <p style={{ margin: 0, fontSize: '0.875rem', color: '#6b7280' }}>
            ค้นหาข้อมูลครุภัณฑ์ตามหมายเลขครุภัณฑ์, หมายเลขเครื่อง, รหัสอ้างอิงถาวร, หรือคำสำคัญในชื่อ
          </p>
        </header>

        {/* Error / Forbidden Alert */}
        {errorMessage && (
          <div
            role="alert"
            id="search-error-alert"
            style={{
              padding: '0.75rem 1rem',
              marginBottom: '1.5rem',
              borderRadius: '6px',
              backgroundColor: '#fee2e2',
              border: '1px solid #ef4444',
              color: '#991b1b',
              fontSize: '0.875rem',
            }}
          >
            {errorMessage}
          </div>
        )}

        {/* Search Controls Form */}
        {!isForbidden && (
          <form
            onSubmit={handleSubmit}
            id="asset-search-form"
            style={{
              backgroundColor: '#f9fafb',
              padding: '1.25rem',
              borderRadius: '6px',
              marginBottom: '1.5rem',
              border: '1px solid #e5e7eb',
            }}
          >
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(180px, 1fr) minmax(260px, 2fr) auto auto',
                gap: '0.75rem',
                alignItems: 'flex-end',
              }}
            >
              <div>
                <label
                  htmlFor="search-field"
                  style={{
                    display: 'block',
                    fontSize: '0.875rem',
                    fontWeight: 500,
                    color: '#374151',
                    marginBottom: '0.25rem',
                  }}
                >
                  ค้นหาตามฟิลด์
                </label>
                <select
                  id="search-field"
                  value={selectedField}
                  onChange={(e) => setSelectedField(e.target.value as SearchFieldType)}
                  style={{
                    width: '100%',
                    padding: '0.5rem 0.75rem',
                    borderRadius: '4px',
                    border: '1px solid #d1d5db',
                    fontSize: '0.875rem',
                    backgroundColor: '#ffffff',
                  }}
                >
                  <option value="all">ทั้งหมด (Browse all)</option>
                  <option value="name">ชื่อครุภัณฑ์ (Name)</option>
                  <option value="asset_number">หมายเลขครุภัณฑ์ (Asset Number)</option>
                  <option value="serial_number">หมายเลขเครื่อง (Serial Number)</option>
                  <option value="stable_id">รหัสอ้างอิงถาวร (Stable ID UUID)</option>
                  {REFERENCE_DIMENSIONS.map(({ legacyField, label }) => (
                    <option key={legacyField} value={legacyField}>
                      ข้อความเดิม: {label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label
                  htmlFor="search-value"
                  style={{
                    display: 'block',
                    fontSize: '0.875rem',
                    fontWeight: 500,
                    color: '#374151',
                    marginBottom: '0.25rem',
                  }}
                >
                  คำค้นหา
                </label>
                <input
                  id="search-value"
                  type="text"
                  value={searchValue}
                  onChange={(e) => setSearchValue(e.target.value)}
                  placeholder={
                    selectedField === 'all'
                      ? 'แสดงรายการทั้งหมด (ไม่ต้องระบุคำค้นหา)'
                      : 'ระบุข้อมูลที่ต้องการค้นหา...'
                  }
                  disabled={selectedField === 'all'}
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    padding: '0.5rem 0.75rem',
                    borderRadius: '4px',
                    border: '1px solid #d1d5db',
                    fontSize: '0.875rem',
                    backgroundColor: selectedField === 'all' ? '#f3f4f6' : '#ffffff',
                  }}
                />
              </div>

              <div>
                <button
                  type="submit"
                  id="search-submit-btn"
                  style={{
                    padding: '0.5rem 1.25rem',
                    backgroundColor: '#2563eb',
                    color: '#ffffff',
                    border: 'none',
                    borderRadius: '4px',
                    fontSize: '0.875rem',
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  {isLoading ? 'กำลังค้นหา...' : '🔍 ค้นหา'}
                </button>
              </div>

              <div>
                <button
                  type="button"
                  id="search-reset-btn"
                  onClick={handleReset}
                  style={{
                    padding: '0.5rem 1rem',
                    backgroundColor: '#ffffff',
                    color: '#4b5563',
                    border: '1px solid #d1d5db',
                    borderRadius: '4px',
                    fontSize: '0.875rem',
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  รีเซ็ต
                </button>
              </div>
            </div>

            {/* Current Assignment filters (T4 D7-A, F003-T1): each dimension narrows the results on its own */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                gap: '0.75rem',
                marginTop: '0.75rem',
              }}
            >
              {REFERENCE_DIMENSIONS.map(({ kind, idField, label }) => (
                <div key={kind}>
                  <label
                    htmlFor={`search-filter-${idField}`}
                    style={{
                      display: 'block',
                      fontSize: '0.875rem',
                      fontWeight: 500,
                      color: '#374151',
                      marginBottom: '0.25rem',
                    }}
                  >
                    {label}
                  </label>
                  <select
                    id={`search-filter-${idField}`}
                    value={selectedFilters[idField]}
                    onChange={(e) => setSelectedFilters((current) => ({ ...current, [idField]: e.target.value }))}
                    style={{
                      width: '100%',
                      padding: '0.5rem 0.75rem',
                      borderRadius: '4px',
                      border: '1px solid #d1d5db',
                      fontSize: '0.875rem',
                      backgroundColor: '#ffffff',
                    }}
                  >
                    <option value="">ทั้งหมด</option>
                    {referenceLists.lists[kind].map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entryLabel(entry)}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </div>
            <label
              htmlFor="search-filter-has_assignment_conflict"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.375rem',
                marginTop: '0.75rem',
                fontSize: '0.875rem',
                fontWeight: 500,
                color: '#374151',
              }}
            >
              <input
                id="search-filter-has_assignment_conflict"
                type="checkbox"
                checked={selectedFilters.has_assignment_conflict === 'true'}
                onChange={(e) =>
                  setSelectedFilters((current) => ({ ...current, has_assignment_conflict: e.target.checked ? 'true' : '' }))
                }
              />
              มีประวัติขัดแย้งค้างตรวจ
            </label>
            <label
              htmlFor="search-filter-on_loan"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.375rem',
                marginTop: '0.5rem',
                fontSize: '0.875rem',
                fontWeight: 500,
                color: '#374151',
              }}
            >
              <input
                id="search-filter-on_loan"
                type="checkbox"
                checked={selectedFilters.on_loan === 'true'}
                onChange={(e) => setSelectedFilters((current) => ({ ...current, on_loan: e.target.checked ? 'true' : '' }))}
              />
              {ON_LOAN_LABEL}
            </label>
            <label
              htmlFor="search-filter-under_repair"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.375rem',
                marginTop: '0.5rem',
                fontSize: '0.875rem',
                fontWeight: 500,
                color: '#374151',
              }}
            >
              <input
                id="search-filter-under_repair"
                type="checkbox"
                checked={selectedFilters.under_repair === 'true'}
                onChange={(e) => setSelectedFilters((current) => ({ ...current, under_repair: e.target.checked ? 'true' : '' }))}
              />
              {UNDER_REPAIR_FILTER_LABEL}
            </label>
            {referenceLists.error && (
              <div role="alert" style={{ marginTop: '0.5rem', fontSize: '0.8125rem', color: '#b91c1c' }}>
                {referenceLists.error}
              </div>
            )}
          </form>
        )}

        {/* F003-T5 (#55): outside the results, so that reading the list again keeps what is being entered */}
        {openPanel === 'REASSIGNMENT' && (
          <BulkReassignmentPanel
            selected={[...selection.values()]}
            actorId={listActorId}
            csrfToken={csrfToken}
            onCancel={() => setOpenPanel(null)}
            onFinished={handleSelectionSaved}
            onPermissionRevoked={() => setCanReassign(false)}
          />
        )}
        {/* F004-T4 (#78): one Loan of the selected rows. The server refuses by name any that cannot be lent. */}
        {openPanel === 'LOAN' && (
          <LoanStartForm
            assets={[...selection.values()]}
            actorId={listActorId}
            csrfToken={csrfToken}
            onStarted={async () => handleSelectionSaved()}
            onCancel={() => setOpenPanel(null)}
            onPermissionRevoked={() => setCanRecordLoan(false)}
          />
        )}

        {/* Loading State */}
        {isLoading && (
          <div
            role="status"
            aria-busy="true"
            id="search-loading-indicator"
            style={{
              padding: '2rem',
              textAlign: 'center',
              color: '#6b7280',
              fontSize: '0.875rem',
            }}
          >
            กำลังค้นหาข้อมูลครุภัณฑ์...
          </div>
        )}

        {/* Results Region */}
        {!isLoading && results !== null && !isForbidden && (
          <section role="region" aria-label="ผลการค้นหาครุภัณฑ์" id="search-results-region">
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: '1rem',
              }}
            >
              <h2
                style={{
                  fontSize: '1.125rem',
                  fontWeight: 600,
                  color: '#374151',
                  margin: 0,
                }}
              >
                รายการผลการค้นหา
              </h2>
              <span id="results-count-summary" style={{ fontSize: '0.875rem', color: '#6b7280' }}>
                {totalCount > 0
                  ? `พบ ${totalCount} รายการ (แสดง ${offset + 1} - ${Math.min(offset + results.length, totalCount)})`
                  : 'ไม่พบรายการ'}
              </span>
            </div>

            {canSelect && (
              <AssetSelectionBar
                selectedCount={selection.size}
                isPanelOpen={openPanel !== null}
                canReassign={canReassign}
                canRecordLoan={canRecordLoan}
                onOpenReassignment={() => setOpenPanel('REASSIGNMENT')}
                onOpenLoan={() => setOpenPanel('LOAN')}
                onClear={() => setSelection(new Map())}
              />
            )}

            {results.length === 0 ? (
              <div
                id="no-results-message"
                style={{
                  padding: '3rem 1rem',
                  textAlign: 'center',
                  backgroundColor: '#f9fafb',
                  borderRadius: '6px',
                  border: '1px dashed #d1d5db',
                  color: '#6b7280',
                  fontSize: '0.9375rem',
                }}
              >
                ไม่พบข้อมูลครุภัณฑ์ตามเงื่อนไขที่ระบุ
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table
                  id="asset-search-table"
                  aria-label="ตารางผลการค้นหาครุภัณฑ์"
                  style={{
                    width: '100%',
                    borderCollapse: 'collapse',
                    textAlign: 'left',
                    fontSize: '0.875rem',
                  }}
                >
                  <thead>
                    <tr style={{ backgroundColor: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
                      {canSelect && (
                        <th style={{ padding: '0.75rem 1rem', fontWeight: 600, color: '#374151' }}>เลือก</th>
                      )}
                      <th style={{ padding: '0.75rem 1rem', fontWeight: 600, color: '#374151' }}>
                        หมายเลขครุภัณฑ์
                      </th>
                      <th style={{ padding: '0.75rem 1rem', fontWeight: 600, color: '#374151' }}>
                        ชื่อครุภัณฑ์
                      </th>
                      <th style={{ padding: '0.75rem 1rem', fontWeight: 600, color: '#374151' }}>
                        หมายเลขเครื่อง
                      </th>
                      <th style={{ padding: '0.75rem 1rem', fontWeight: 600, color: '#374151' }}>
                        สถานที่ หน่วยงาน และผู้รับผิดชอบ
                      </th>
                      <th style={{ padding: '0.75rem 1rem', fontWeight: 600, color: '#374151' }}>
                        รหัสอ้างอิงถาวร (Stable ID)
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((item) => (
                      <tr
                        key={item.id}
                        data-testid={`search-result-row-${item.id}`}
                        style={{
                          borderBottom: '1px solid #e5e7eb',
                        }}
                      >
                        {canSelect && (
                          <td style={{ padding: '0.75rem 1rem' }}>
                            <input
                              type="checkbox"
                              data-testid={`asset-select-${item.id}`}
                              aria-label={`เลือก ${assetLabelOf(item, item.id)}`}
                              checked={selection.has(item.id)}
                              disabled={openPanel !== null || (!selection.has(item.id) && selection.size >= SELECTION_MAX_ASSETS)}
                              onChange={() => toggleSelected(item)}
                            />
                          </td>
                        )}
                        <td style={{ padding: '0.75rem 1rem', color: '#111827', fontWeight: 500 }}>
                          {item.asset_number || '-'}
                        </td>
                        <td style={{ padding: '0.75rem 1rem', color: '#111827' }}>
                          {item.name || '(ไม่มีชื่อ - บันทึกข้อมูลย้อนหลัง)'}
                          {item.on_loan && <OnLoanBadge testId={`search-result-on-loan-${item.id}`} />}
                          {item.under_repair && (
                            <UnderRepairBadge repairKind={item.under_repair.repair_kind} testId={`search-result-under-repair-${item.id}`} />
                          )}
                        </td>
                        <td style={{ padding: '0.75rem 1rem', color: '#6b7280' }}>
                          {item.serial_number || '-'}
                        </td>
                        <td data-testid={`search-result-reference-${item.id}`} style={{ padding: '0.75rem 1rem', color: '#374151' }}>
                          {REFERENCE_DIMENSIONS.every(({ entryField, legacyField }) => !item[entryField] && !item[legacyField])
                            ? '-'
                            : REFERENCE_DIMENSIONS.map(({ entryField, legacyField, label }) => {
                                const entry = item[entryField];
                                const legacyText = item[legacyField];
                                return entry || legacyText ? (
                                  <div key={entryField}>
                                    {label}: {entry && entryLabel(entry)}
                                    {legacyText && (
                                      <span style={{ color: '#6b7280' }}>
                                        {entry ? ' ' : ''}(ข้อความเดิม: {legacyText})
                                      </span>
                                    )}
                                  </div>
                                ) : null;
                              })}
                        </td>
                        <td style={{ padding: '0.75rem 1rem' }}>
                          <Link
                            to={`/assets/${item.id}`}
                            data-testid={`asset-detail-link-${item.id}`}
                            id={`asset-link-${item.id}`}
                            style={{
                              color: '#2563eb',
                              textDecoration: 'none',
                              fontFamily: 'monospace',
                              fontSize: '0.8125rem',
                            }}
                          >
                            {item.id}
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Pagination Controls */}
            {totalCount > limit && (
              <div
                id="pagination-controls"
                style={{
                  display: 'flex',
                  justifyContent: 'flex-end',
                  alignItems: 'center',
                  gap: '0.75rem',
                  marginTop: '1.5rem',
                }}
              >
                <button
                  type="button"
                  id="prev-page-btn"
                  onClick={handlePrevPage}
                  disabled={offset === 0 || isLoading}
                  style={{
                    padding: '0.375rem 0.75rem',
                    backgroundColor: offset === 0 ? '#f3f4f6' : '#ffffff',
                    color: offset === 0 ? '#9ca3af' : '#374151',
                    border: '1px solid #d1d5db',
                    borderRadius: '4px',
                    fontSize: '0.875rem',
                    cursor: offset === 0 ? 'not-allowed' : 'pointer',
                  }}
                >
                  ← ก่อนหน้า
                </button>
                <span id="page-indicator" style={{ fontSize: '0.875rem', color: '#4b5563' }}>
                  หน้า {Math.floor(offset / limit) + 1} จาก {Math.ceil(totalCount / limit)}
                </span>
                <button
                  type="button"
                  id="next-page-btn"
                  onClick={handleNextPage}
                  disabled={!hasMore || isLoading}
                  style={{
                    padding: '0.375rem 0.75rem',
                    backgroundColor: !hasMore ? '#f3f4f6' : '#ffffff',
                    color: !hasMore ? '#9ca3af' : '#374151',
                    border: '1px solid #d1d5db',
                    borderRadius: '4px',
                    fontSize: '0.875rem',
                    cursor: !hasMore ? 'not-allowed' : 'pointer',
                  }}
                >
                  ถัดไป →
                </button>
              </div>
            )}
          </section>
        )}
      </div>
    </main>
  );
};

export default AssetSearch;
