import React, { useEffect, useState, useCallback, useRef } from 'react';

export interface EvidenceItem {
  id: string;
  reference_type: string | null;
  reference_text: string | null;
  description: string | null;
  acquisition_id: string | null;
  version: number;
  recorded_at: string;
  created_by: string;
  asset_ids: string[];
  asset_ids_total?: number;
  has_more_assets?: boolean;
}

export interface EvidenceHistoryItem {
  id: string;
  evidence_id: string;
  version: number;
  action: 'CREATED' | 'CORRECTED';
  actor_id: string;
  reason: string | null;
  before_state: any;
  after_state: any;
  link_deltas: any;
  recorded_at: string;
}

export interface EvidencePanelProps {
  entityType: 'asset' | 'acquisition';
  entityId: string;
  acquisitionId?: string | null;
  csrfToken: string | null;
  currentUser?: { id: string; role?: string } | null;
  isReauthorizing?: boolean;
}

export type OperationKind = 'create' | 'link' | 'correct' | 'unlink';

export type OperationPhase =
  | 'UNSENT_PREFLIGHT'
  | 'SENT_UNKNOWN'
  | 'RECOVERY_REQUIRED'
  | 'CONFIRMED'
  | 'DEFINITIVELY_REJECTED'
  | 'SETTLED';

export interface CoordinatorOperation {
  operation_id: string;
  owner_actor_id: string;
  document_context_id: string;
  kind: OperationKind;
  endpoint: string;
  business_payload: any;
  retry_token: string;
  target_evidence_id?: string | null;
  target_version?: number | null;
  phase: OperationPhase;
  attempt_id: string;
  auth_epoch: number;
  created_at: number;
  last_attempt_at: number;
  receipt?: EvidenceReceipt;
  error?: string | null;
  // Number of POSTs sent for this operation. Only the very first one can be answered by a
  // proof that nothing was written (SF1).
  dispatch_count: number;
  // A later replay was denied by current grants: the original intent stays quarantined (SF1).
  auth_suspended: boolean;
  // Set synchronously while an attempt (preflight or POST) runs, so no entry point can start a
  // second one (SF2).
  in_flight: boolean;
  // Frozen at reservation: the panel the intent came from and every parent it names, before and
  // after, so a replay re-checks those grants wherever it is retried from (SF1, SF2).
  context_entity_type: 'asset' | 'acquisition';
  context_entity_id: string;
  parent_asset_ids: string[];
  parent_acquisition_ids: string[];
}

// The compact receipt the T7 API returns: create 201 and correction 200 (SF3).
export interface EvidenceReceipt {
  id: string;
  version: number;
  history_id: string | null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const uniqueIds = (ids: Array<string | null | undefined>): string[] =>
  Array.from(new Set(ids.filter((id): id is string => typeof id === 'string' && id.length > 0)));

// SF3: a 2xx settles an operation only when its body is the receipt this exact operation can
// produce; anything else leaves the original token in recovery.
export function validateOperationReceipt(
  op: CoordinatorOperation,
  status: number,
  body: unknown
): EvidenceReceipt | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { id, version, history_id } = body as Record<string, unknown>;
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) return null;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) return null;
  if (history_id !== null && (typeof history_id !== 'string' || !UUID_PATTERN.test(history_id))) return null;
  const receipt: EvidenceReceipt = { id, version, history_id };

  if (op.kind === 'create') {
    if (status !== 201 || version !== 1 || history_id === null) return null;
  } else {
    if (status !== 200 || id !== op.target_evidence_id || typeof op.target_version !== 'number') return null;
    const expected = history_id === null ? op.target_version : op.target_version + 1;
    if (version !== expected) return null;
  }

  // A replay must return the receipt already known for this operation, whatever the record's
  // current version is.
  const known = op.receipt;
  if (known && (known.id !== id || known.version !== version || known.history_id !== history_id)) return null;
  return receipt;
}

const DOCUMENT_CONTEXT_ID =
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : 'doc-ctx-' + Math.random().toString(36).substring(2);

class EvidenceOperationCoordinator {
  private operations = new Map<string, CoordinatorOperation>();
  private subscribers = new Set<() => void>();

  subscribe(callback: () => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  private notify() {
    this.subscribers.forEach((cb) => {
      try {
        cb();
      } catch (err) {
        console.error('Coordinator subscriber error:', err);
      }
    });
  }

  getOperationForActor(actorId: string | null | undefined): CoordinatorOperation | null {
    if (!actorId) return null;
    return this.operations.get(actorId) || null;
  }

  getUnresolvedOperation(actorId: string | null | undefined): CoordinatorOperation | null {
    if (!actorId) return null;
    const op = this.operations.get(actorId);
    if (!op) return null;
    if (
      op.phase === 'UNSENT_PREFLIGHT' ||
      op.phase === 'SENT_UNKNOWN' ||
      op.phase === 'RECOVERY_REQUIRED' ||
      op.phase === 'CONFIRMED'
    ) {
      return op;
    }
    return null;
  }

  hasActiveReservation(actorId: string | null | undefined): boolean {
    return this.getUnresolvedOperation(actorId) !== null;
  }

  reserve(params: {
    actorId: string;
    kind: OperationKind;
    endpoint: string;
    payload: any;
    retryToken: string;
    targetEvidenceId?: string | null;
    targetVersion?: number | null;
    authEpoch: number;
    context: { entityType: 'asset' | 'acquisition'; entityId: string };
    parents: { assetIds: Array<string | null | undefined>; acquisitionIds: Array<string | null | undefined> };
  }): { success: boolean; operation?: CoordinatorOperation; error?: string } {
    const existing = this.getUnresolvedOperation(params.actorId);
    if (existing) {
      return {
        success: false,
        error: 'An unresolved operation already exists for this actor. Complete or resolve it first.',
      };
    }

    const op: CoordinatorOperation = {
      operation_id: crypto.randomUUID(),
      owner_actor_id: params.actorId,
      document_context_id: DOCUMENT_CONTEXT_ID,
      kind: params.kind,
      endpoint: params.endpoint,
      business_payload: JSON.parse(JSON.stringify(params.payload)),
      retry_token: params.retryToken,
      target_evidence_id: params.targetEvidenceId || null,
      target_version: params.targetVersion ?? null,
      phase: 'UNSENT_PREFLIGHT',
      attempt_id: crypto.randomUUID(),
      auth_epoch: params.authEpoch,
      created_at: Date.now(),
      last_attempt_at: Date.now(),
      dispatch_count: 0,
      auth_suspended: false,
      in_flight: false,
      context_entity_type: params.context.entityType,
      context_entity_id: params.context.entityId,
      parent_asset_ids: uniqueIds(params.parents.assetIds),
      parent_acquisition_ids: uniqueIds(params.parents.acquisitionIds),
    };

    this.operations.set(params.actorId, op);
    this.notify();
    return { success: true, operation: op };
  }

  // True when `operationId` is still the actor's one unresolved operation.
  isCurrentOperation(actorId: string, operationId: string): boolean {
    return this.getUnresolvedOperation(actorId)?.operation_id === operationId;
  }

  // Synchronously claims the operation for one attempt; a second entry point gets false (SF2).
  beginAttempt(actorId: string, operationId: string): boolean {
    const op = this.getUnresolvedOperation(actorId);
    if (!op || op.operation_id !== operationId || op.in_flight) return false;
    op.in_flight = true;
    return true;
  }

  endAttempt(actorId: string, operationId: string) {
    const op = this.operations.get(actorId);
    if (op && op.operation_id === operationId && op.in_flight) {
      op.in_flight = false;
      this.notify();
    }
  }

  retireUnsent(actorId: string, operationId: string) {
    const op = this.operations.get(actorId);
    if (op && op.operation_id === operationId && op.phase === 'UNSENT_PREFLIGHT') {
      this.operations.delete(actorId);
      this.notify();
    }
  }

  markDispatched(actorId: string, operationId: string, attemptId: string, authEpoch: number): boolean {
    const op = this.operations.get(actorId);
    if (!op || op.operation_id !== operationId) return false;
    if (op.phase !== 'CONFIRMED') op.phase = 'SENT_UNKNOWN';
    op.attempt_id = attemptId;
    op.auth_epoch = authEpoch;
    op.dispatch_count += 1;
    op.auth_suspended = false;
    op.last_attempt_at = Date.now();
    this.notify();
    return true;
  }

  markRecoveryRequired(
    actorId: string,
    operationId: string,
    attemptId: string,
    error?: string,
    authSuspended = false
  ) {
    const op = this.operations.get(actorId);
    if (op && op.operation_id === operationId && op.attempt_id === attemptId) {
      if (op.phase !== 'SETTLED') {
        // A known receipt stays known: only its phase label can change.
        if (op.phase !== 'CONFIRMED') op.phase = 'RECOVERY_REQUIRED';
        op.error = error || null;
        op.auth_suspended = authSuspended;
        this.notify();
      }
    }
  }

  // Current grants deny the replay before anything is sent: the original intent stays (SF1).
  suspendForAuthorization(actorId: string, operationId: string, error: string) {
    const op = this.operations.get(actorId);
    if (op && op.operation_id === operationId && op.phase !== 'SETTLED') {
      op.auth_suspended = true;
      op.error = error;
      this.notify();
    }
  }

  markConfirmed(actorId: string, operationId: string, attemptId: string, receipt: EvidenceReceipt) {
    const op = this.operations.get(actorId);
    if (op && op.operation_id === operationId && op.attempt_id === attemptId && op.phase !== 'SETTLED') {
      op.phase = 'CONFIRMED';
      if (!op.receipt) op.receipt = receipt;
      op.error = null;
      op.auth_suspended = false;
      this.notify();
    }
  }

  // A 4xx answered this attempt. It releases the reservation (returns true) only when this was
  // the one and only dispatch; once an earlier attempt may have committed, the operation stays
  // in recovery, auth-suspended when grants denied it (SF1).
  rejectAttempt(actorId: string, operationId: string, attemptId: string, error: string, authDenied: boolean): boolean {
    const op = this.operations.get(actorId);
    if (!op || op.operation_id !== operationId || op.attempt_id !== attemptId) return false;
    if (op.phase === 'SETTLED') return false;
    if (op.dispatch_count !== 1 || op.receipt || op.phase === 'CONFIRMED') {
      this.markRecoveryRequired(actorId, operationId, attemptId, error, authDenied);
      return false;
    }
    op.phase = 'DEFINITIVELY_REJECTED';
    op.error = error;
    this.operations.delete(actorId);
    this.notify();
    return true;
  }

  // Settles only an operation with a validated receipt (SF3).
  settle(actorId: string, operationId: string) {
    const op = this.operations.get(actorId);
    if (op && op.operation_id === operationId && op.phase === 'CONFIRMED' && op.receipt) {
      op.phase = 'SETTLED';
      this.operations.delete(actorId);
      this.notify();
    }
  }
}

export const evidenceOperationCoordinator = new EvidenceOperationCoordinator();

export const EvidencePanel: React.FC<EvidencePanelProps> = ({
  entityType,
  entityId,
  acquisitionId,
  // csrfToken stays in the props contract; mutations use the token from a fresh session check (SF2).
  currentUser,
  isReauthorizing = false,
}) => {
  const [evidenceList, setEvidenceList] = useState<EvidenceItem[]>([]);
  const [evidenceTotal, setEvidenceTotal] = useState(0);
  const [evidenceOffset, setEvidenceOffset] = useState(0);
  const [hasMoreEvidence, setHasMoreEvidence] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // Dynamic capabilities from server
  const [canCreate, setCanCreate] = useState(false);
  const [canCorrect, setCanCorrect] = useState(false);

  // Operation coordinator subscription (F3 ARCH-A1 D1-D4)
  const [, setCoordinatorTick] = useState(0);
  useEffect(() => {
    return evidenceOperationCoordinator.subscribe(() => {
      setCoordinatorTick((t) => t + 1);
    });
  }, []);

  const [isSubmittingRetry, setIsSubmittingRetry] = useState(false);
  const [retryNotice, setRetryNotice] = useState<string | null>(null);
  const [loadingAssetsForId, setLoadingAssetsForId] = useState<string | null>(null);

  const currentActorId = currentUser?.id || null;
  const currentOp = evidenceOperationCoordinator.getUnresolvedOperation(currentActorId);
  const hasUnresolvedOp = currentOp !== null;

  // Creation state
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createRefType, setCreateRefType] = useState('');
  const [createRefText, setCreateRefText] = useState('');
  const [createDesc, setCreateDesc] = useState('');
  const [createIncludeAcq, setCreateIncludeAcq] = useState(entityType === 'acquisition');
  const [createAdditionalAssetIds, setCreateAdditionalAssetIds] = useState('');
  const [isSubmittingCreate, setIsSubmittingCreate] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Link Existing Evidence state (F5)
  const [showLinkExistingForm, setShowLinkExistingForm] = useState(false);
  const [linkExistingId, setLinkExistingId] = useState('');
  const [linkExistingVersion, setLinkExistingVersion] = useState<number | ''>('');
  const [linkExistingReason, setLinkExistingReason] = useState('');
  const [isSubmittingLinkExisting, setIsSubmittingLinkExisting] = useState(false);
  const [linkExistingError, setLinkExistingError] = useState<string | null>(null);

  // Correction state
  const [correctingEvidence, setCorrectingEvidence] = useState<EvidenceItem | null>(null);
  const [correctReason, setCorrectReason] = useState('');
  const [correctRefType, setCorrectRefType] = useState('');
  const [correctRefText, setCorrectRefText] = useState('');
  const [correctDesc, setCorrectDesc] = useState('');
  const [correctAcqAction, setCorrectAcqAction] = useState<'unchanged' | 'unlink' | 'change'>('unchanged');
  const [correctTargetAcqId, setCorrectTargetAcqId] = useState('');
  const [correctAddAssetIds, setCorrectAddAssetIds] = useState('');
  const [correctRemoveAssetIds, setCorrectRemoveAssetIds] = useState<string[]>([]);
  const [isSubmittingCorrect, setIsSubmittingCorrect] = useState(false);
  const [correctError, setCorrectError] = useState<string | null>(null);

  // History state
  const [viewingHistoryId, setViewingHistoryId] = useState<string | null>(null);
  const [historyItems, setHistoryItems] = useState<EvidenceHistoryItem[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);

  const isActionBlocked =
    hasUnresolvedOp ||
    isSubmittingCreate ||
    isSubmittingCorrect ||
    isSubmittingLinkExisting ||
    isSubmittingRetry;

  // Lifecycle and generation guards (F3)
  const isMountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const historyAbortRef = useRef<AbortController | null>(null);
  const mutationAbortRef = useRef<AbortController | null>(null);
  const assetContinuationAbortRef = useRef<AbortController | null>(null);
  const reqGenRef = useRef(0);
  const currentActorIdRef = useRef<string | null>(currentUser?.id || null);
  const authEpochRef = useRef(0);
  const dialogGenRef = useRef(0);
  const prevReauthorizingRef = useRef(isReauthorizing);
  // Live value for continuations that resume after an await (ARCH-A2 H3).
  const isReauthorizingRef = useRef(isReauthorizing);
  isReauthorizingRef.current = isReauthorizing;

  // Track window focus, visibility and navigation to advance epoch and cancel stale operations (F3)
  useEffect(() => {
    const handleWindowFocusOrVisibility = () => {
      authEpochRef.current++;
      reqGenRef.current++;
      if (abortRef.current) abortRef.current.abort();
    };
    window.addEventListener('focus', handleWindowFocusOrVisibility);
    window.addEventListener('visibilitychange', handleWindowFocusOrVisibility);
    window.addEventListener('popstate', handleWindowFocusOrVisibility);
    return () => {
      window.removeEventListener('focus', handleWindowFocusOrVisibility);
      window.removeEventListener('visibilitychange', handleWindowFocusOrVisibility);
      window.removeEventListener('popstate', handleWindowFocusOrVisibility);
    };
  }, []);

  // Track component lifecycle (F3)
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      authEpochRef.current++;
      dialogGenRef.current++;
      if (abortRef.current) abortRef.current.abort();
      if (historyAbortRef.current) historyAbortRef.current.abort();
      if (mutationAbortRef.current) mutationAbortRef.current.abort();
      if (assetContinuationAbortRef.current) assetContinuationAbortRef.current.abort();
    };
  }, []);

  // Fail-closed when user changes or session is reauthorizing (F3)
  useEffect(() => {
    const prevActor = currentActorIdRef.current;
    const currentActor = currentUser?.id || null;
    currentActorIdRef.current = currentActor;

    const actorChanged = prevActor !== currentActor;
    const reauthorizingChanged = prevReauthorizingRef.current !== isReauthorizing;
    prevReauthorizingRef.current = isReauthorizing;

    if (actorChanged || reauthorizingChanged) {
      authEpochRef.current++;
    }

    if (!currentUser || isReauthorizing || actorChanged) {
      dialogGenRef.current++;
      if (actorChanged) {
        // Reset in-flight submission flags for current actor context (F3 ARCH-A1)
        setIsSubmittingCreate(false);
        setIsSubmittingCorrect(false);
        setIsSubmittingLinkExisting(false);
        setIsSubmittingRetry(false);
        setRetryNotice(null);

        // Wipe all creation form drafts (F3 ARCH-A1)
        setCreateRefType('');
        setCreateRefText('');
        setCreateDesc('');
        setCreateAdditionalAssetIds('');
        setCreateError(null);
        setShowCreateForm(false);
        // Wipe all link existing form drafts (F3)
        setLinkExistingId('');
        setLinkExistingVersion('');
        setLinkExistingReason('');
        setLinkExistingError(null);
        setShowLinkExistingForm(false);
        // Wipe all correction form drafts (F3)
        setCorrectingEvidence(null);
        setCorrectReason('');
        setCorrectRefType('');
        setCorrectRefText('');
        setCorrectDesc('');
        setCorrectAcqAction('unchanged');
        setCorrectTargetAcqId('');
        setCorrectAddAssetIds('');
        setCorrectRemoveAssetIds([]);
        setCorrectError(null);
      }
      reqGenRef.current++;
      if (abortRef.current) abortRef.current.abort();
      if (historyAbortRef.current) historyAbortRef.current.abort();
      if (mutationAbortRef.current) mutationAbortRef.current.abort();
      if (assetContinuationAbortRef.current) assetContinuationAbortRef.current.abort();

      setEvidenceList([]);
      setEvidenceTotal(0);
      setCanCreate(false);
      setCanCorrect(false);
      setShowCreateForm(false);
      setShowLinkExistingForm(false);
      setCorrectingEvidence(null);
      setViewingHistoryId(null);
      setHistoryItems([]);
      setHistoryTotal(0);
      setHistoryOffset(0);
      setHasMoreHistory(false);
      setHistoryError(null);
      setFetchError(isReauthorizing ? 'กำลังยืนยันสิทธิ์ กรุณารอสักครู่...' : (!currentUser ? 'กรุณาเข้าสู่ระบบเพื่อดูหลักฐานอ้างอิง' : null));
    }
  }, [currentUser, isReauthorizing]);

  const fetchEvidence = useCallback(
    async (offset: number = 0, append: boolean = false) => {
      if (!entityId || !currentUser || isReauthorizing) return;

      if (abortRef.current) {
        abortRef.current.abort();
      }
      const controller = new AbortController();
      abortRef.current = controller;
      const currentGen = ++reqGenRef.current;

      setIsLoading(true);
      if (!append) {
        setFetchError(null);
      }

      const param = entityType === 'acquisition' ? `acquisition_id=${entityId}` : `asset_id=${entityId}`;
      const limit = 25;

      try {
        const res = await fetch(`/evidence?${param}&limit=${limit}&offset=${offset}`, {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
        });

        if (!isMountedRef.current || currentGen !== reqGenRef.current || controller.signal.aborted) {
          return;
        }

        if (res.status === 401 || res.status === 403) {
          // F3: Fail-closed, clear all facts and forms on authorization denial
          setEvidenceList([]);
          setEvidenceTotal(0);
          setCanCreate(false);
          setCanCorrect(false);
          setShowCreateForm(false);
          setShowLinkExistingForm(false);
          setCorrectingEvidence(null);
          setViewingHistoryId(null);
          setHistoryItems([]);
          setFetchError(res.status === 401 ? 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่' : 'ไม่มีสิทธิ์เข้าถึงหลักฐานอ้างอิง');
          setIsLoading(false);
          return;
        }

        if (!res.ok) {
          setFetchError(`เกิดข้อผิดพลาดในการโหลดหลักฐาน (${res.status})`);
          setIsLoading(false);
          return;
        }

        const data = await res.json();
        if (!isMountedRef.current || currentGen !== reqGenRef.current || controller.signal.aborted) {
          return;
        }

        const fetchedItems: EvidenceItem[] = data.items || [];
        setEvidenceTotal(data.total || 0);
        setEvidenceOffset(offset);
        setHasMoreEvidence(Boolean(data.has_more));
        setCanCreate(Boolean(data.can_create));
        setCanCorrect(Boolean(data.can_correct));

        if (append) {
          setEvidenceList((prev) => [...prev, ...fetchedItems]);
        } else {
          setEvidenceList(fetchedItems);
        }
        setIsLoading(false);
      } catch (err: unknown) {
        if (!isMountedRef.current || currentGen !== reqGenRef.current || controller.signal.aborted) {
          return;
        }
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
        setFetchError('ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้');
        setIsLoading(false);
      }
    },
    [entityType, entityId, currentUser, isReauthorizing]
  );

  useEffect(() => {
    isMountedRef.current = true;
    currentActorIdRef.current = currentUser?.id || null;

    if (currentUser && !isReauthorizing) {
      fetchEvidence(0, false);
    }

    const handleFocus = () => {
      if (document.visibilityState === 'visible' && isMountedRef.current && currentUser && !isReauthorizing) {
        fetchEvidence(0, false);
      }
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleFocus);

    return () => {
      isMountedRef.current = false;
      if (abortRef.current) abortRef.current.abort();
      if (historyAbortRef.current) historyAbortRef.current.abort();
      if (mutationAbortRef.current) mutationAbortRef.current.abort();
      if (assetContinuationAbortRef.current) assetContinuationAbortRef.current.abort();
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleFocus);
    };
  }, [fetchEvidence, currentUser, isReauthorizing]);

  // Load paginated history
  const fetchHistory = useCallback(
    async (evId: string, offset: number = 0, append: boolean = false) => {
      if (!currentUser || isReauthorizing) return;

      if (historyAbortRef.current) {
        historyAbortRef.current.abort();
      }
      const controller = new AbortController();
      historyAbortRef.current = controller;

      setIsLoadingHistory(true);
      if (!append) {
        setHistoryError(null);
      }

      const limit = 25;
      try {
        const res = await fetch(`/evidence/${evId}/history?limit=${limit}&offset=${offset}`, {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
        });

        if (!isMountedRef.current || controller.signal.aborted) return;

        if (res.status === 401 || res.status === 403) {
          setHistoryItems([]);
          setHistoryTotal(0);
          setHistoryError(res.status === 401 ? 'เซสชันหมดอายุ' : 'ไม่มีสิทธิ์ดูประวัติหลักฐานนี้');
          setIsLoadingHistory(false);
          return;
        }

        if (!res.ok) {
          setHistoryError(`ไม่สามารถโหลดประวัติได้ (${res.status})`);
          setIsLoadingHistory(false);
          return;
        }

        const data = await res.json();
        if (!isMountedRef.current || controller.signal.aborted) return;

        const items: EvidenceHistoryItem[] = data.items || [];
        setHistoryTotal(data.total || 0);
        setHistoryOffset(offset);
        setHasMoreHistory(Boolean(data.has_more));

        if (append) {
          setHistoryItems((prev) => [...prev, ...items]);
        } else {
          setHistoryItems(items);
        }
        setIsLoadingHistory(false);
      } catch (err: unknown) {
        if (!isMountedRef.current || controller.signal.aborted) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setHistoryError('เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์');
        setIsLoadingHistory(false);
      }
    },
    [currentUser, isReauthorizing]
  );

  const toggleHistory = (evId: string) => {
    if (viewingHistoryId === evId) {
      setViewingHistoryId(null);
      setHistoryItems([]);
      setHistoryTotal(0);
    } else {
      setViewingHistoryId(evId);
      setHistoryOffset(0);
      fetchHistory(evId, 0, false);
    }
  };

  // Clears every protected fact on screen when current grants are denied (F3).
  const redactProtectedDisplay = () => {
    setEvidenceList([]);
    setEvidenceTotal(0);
    setCanCreate(false);
    setCanCorrect(false);
    setCorrectingEvidence(null);
    setShowLinkExistingForm(false);
    setViewingHistoryId(null);
    setHistoryItems([]);
    setCorrectReason('');
    setCorrectRefType('');
    setCorrectRefText('');
    setCorrectDesc('');
    setCorrectAddAssetIds('');
    setCorrectRemoveAssetIds([]);
  };

  // SF2: the server's proof of who the cookie actor is right now, and its current CSRF token.
  const verifySessionActor = async (
    ownerActorId: string,
    signal: AbortSignal
  ): Promise<{ ok: true; csrfToken: string } | { ok: false; reason: 'other-actor' | 'no-session' | 'unreachable' }> => {
    try {
      const res = await fetch('/auth/session-check', { method: 'GET', credentials: 'include', signal });
      if (res.status === 401) return { ok: false, reason: 'no-session' };
      if (!res.ok) return { ok: false, reason: 'unreachable' };
      const data: any = await res.json().catch(() => null);
      const userId = data && typeof data === 'object' && data.user ? data.user.id : null;
      if (typeof userId !== 'string') return { ok: false, reason: 'no-session' };
      if (userId !== ownerActorId) return { ok: false, reason: 'other-actor' };
      if (typeof data.csrfToken !== 'string' || data.csrfToken.length === 0) return { ok: false, reason: 'unreachable' };
      return { ok: true, csrfToken: data.csrfToken };
    } catch {
      return { ok: false, reason: 'unreachable' };
    }
  };

  // SF2: a cookie that is not the owner's shows none of the owner's facts or drafts.
  const shieldOwnerScreen = (message: string) => {
    redactProtectedDisplay();
    setShowCreateForm(false);
    setCreateRefType('');
    setCreateRefText('');
    setCreateDesc('');
    setCreateAdditionalAssetIds('');
    setLinkExistingId('');
    setLinkExistingVersion('');
    setLinkExistingReason('');
    setFetchError(message);
  };

  // SF2: before a replay, the actor must still hold the Evidence action and view every parent the
  // operation named when it was reserved, checked through the existing read endpoints.
  const verifyReplayGrants = async (
    op: CoordinatorOperation,
    signal: AbortSignal
  ): Promise<'ok' | 'denied' | 'unreachable'> => {
    const assetIds = new Set(op.parent_asset_ids);
    const acquisitionIds = new Set(op.parent_acquisition_ids);
    if (op.context_entity_type === 'acquisition') acquisitionIds.add(op.context_entity_id);
    else assetIds.add(op.context_entity_id);

    const actionFlag = op.kind === 'create' ? 'can_create' : 'can_correct';
    const listUrls = [
      ...[...assetIds].map((id) => `/evidence?asset_id=${encodeURIComponent(id)}&limit=1&offset=0`),
      ...[...acquisitionIds].map((id) => `/evidence?acquisition_id=${encodeURIComponent(id)}&limit=1&offset=0`),
    ];
    const recordUrl = op.kind !== 'create' && op.target_evidence_id ? `/evidence/${op.target_evidence_id}` : null;

    try {
      const responses = await Promise.all(
        [...listUrls, ...(recordUrl ? [recordUrl] : [])].map((url) =>
          fetch(url, { method: 'GET', credentials: 'include', signal })
        )
      );
      if (responses.some((res) => res.status === 401 || res.status === 403)) return 'denied';
      if (responses.some((res) => !res.ok)) return 'unreachable';
      const lists = await Promise.all(responses.slice(0, listUrls.length).map((res) => res.json().catch(() => null)));
      if (lists.some((data) => !data || data[actionFlag] !== true)) return 'denied';
      return 'ok';
    } catch {
      return 'unreachable';
    }
  };

  // Coordinator executor for create/correct/link/unlink with retry token and uncertain locking
  // (F1, F3 ARCH-A1 D1-D4, ARCH-A2 SF1-SF3).
  // - Coordinator transitions are keyed by owner/operation/attempt and apply whatever the screen
  //   shows; screen writes happen only while `isUiOwner()` holds at the moment of the write (H3).
  // - The first POST of an operation can be rejected definitively; once an earlier attempt was
  //   dispatched, no later 4xx proves it did not commit (H1).
  // - A replay first re-checks current grants; every POST is preceded, with no other await in
  //   between, by a server check that the cookie actor is the owner (H2).
  // - A 2xx settles only with a receipt this exact operation can produce (H4).
  const executeCoordinatorOperation = async (
    op: CoordinatorOperation,
    checkOwner?: () => boolean
  ): Promise<{
    success: boolean;
    uncertain?: boolean;
    definitivelyRejected?: boolean;
    error?: string;
    receipt?: EvidenceReceipt;
  }> => {
    const owner = op.owner_actor_id;
    const isReplay = op.dispatch_count > 0;
    const capturedEpoch = authEpochRef.current;
    const cancelled = 'การดำเนินการถูกยกเลิก';
    const isUiOwner = () =>
      isMountedRef.current &&
      !isReauthorizingRef.current &&
      currentActorIdRef.current === owner &&
      authEpochRef.current === capturedEpoch &&
      (checkOwner ? checkOwner() : true);
    const cancel = (error: string) => {
      if (!isReplay) evidenceOperationCoordinator.retireUnsent(owner, op.operation_id);
      return { success: false, error };
    };
    // The cookie is not the owner's (or has no session): nothing is sent, the owner's operation
    // stays as it is, and the screen stops showing the owner's facts.
    const refuseForeignSession = (reason: 'other-actor' | 'no-session' | 'unreachable') => {
      const error =
        reason === 'other-actor'
          ? 'เซสชันปัจจุบันเป็นของผู้ใช้อื่น จึงไม่ส่งรายการของผู้ใช้เดิม'
          : reason === 'no-session'
            ? 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่'
            : 'ไม่สามารถยืนยันผู้ใช้ปัจจุบันได้ กรุณาลองใหม่';
      if (!isReplay) evidenceOperationCoordinator.retireUnsent(owner, op.operation_id);
      if (reason !== 'unreachable' && isUiOwner()) shieldOwnerScreen(error);
      return { success: false, error };
    };

    if (!isUiOwner()) return cancel(cancelled);
    if (!evidenceOperationCoordinator.beginAttempt(owner, op.operation_id)) {
      return { success: false, error: 'รายการนี้กำลังดำเนินการอยู่' };
    }

    if (mutationAbortRef.current) {
      mutationAbortRef.current.abort();
    }
    const controller = new AbortController();
    mutationAbortRef.current = controller;

    try {
      if (isReplay) {
        const grants = await verifyReplayGrants(op, controller.signal);
        if (!evidenceOperationCoordinator.isCurrentOperation(owner, op.operation_id)) {
          return { success: false, error: cancelled };
        }
        if (grants === 'unreachable') {
          return { success: false, uncertain: true, error: 'ไม่สามารถตรวจสอบสิทธิ์ปัจจุบันได้ กรุณาลองใหม่' };
        }
        if (grants === 'denied') {
          // Denied for whom? Only the owner's own denial suspends the owner's operation.
          const who = await verifySessionActor(owner, controller.signal);
          if (!evidenceOperationCoordinator.isCurrentOperation(owner, op.operation_id)) {
            return { success: false, error: cancelled };
          }
          if (!who.ok) return refuseForeignSession(who.reason);
          const error = 'ไม่มีสิทธิ์ส่งรายการเดิมซ้ำในขณะนี้ รายการเดิมยังถูกกักไว้จนกว่าสิทธิ์จะกลับมา';
          evidenceOperationCoordinator.suspendForAuthorization(owner, op.operation_id, error);
          if (isUiOwner()) redactProtectedDisplay();
          return { success: false, uncertain: true, error };
        }
      }

      const proof = await verifySessionActor(owner, controller.signal);
      if (!evidenceOperationCoordinator.isCurrentOperation(owner, op.operation_id)) {
        return { success: false, error: cancelled };
      }
      if (!proof.ok) return refuseForeignSession(proof.reason);
      // Synchronous from here to the POST: no await may separate the actor proof from dispatch.
      if (!isUiOwner()) return cancel(cancelled);

      const attemptId = crypto.randomUUID();
      if (!evidenceOperationCoordinator.markDispatched(owner, op.operation_id, attemptId, capturedEpoch)) {
        return { success: false, error: cancelled };
      }
      const currentGen = ++reqGenRef.current;

      let res: Response;
      try {
        res = await fetch(op.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-csrf-token': proof.csrfToken,
            'x-retry-token': op.retry_token,
          },
          credentials: 'include',
          signal: controller.signal,
          body: JSON.stringify({
            ...op.business_payload,
            retry_token: op.retry_token,
          }),
        });
      } catch (err: unknown) {
        const aborted = err instanceof DOMException && err.name === 'AbortError';
        const error = aborted
          ? 'คำขอถูกยกเลิกหลังส่งออกไปแล้ว จึงยังไม่ทราบผลการบันทึก'
          : 'การเชื่อมต่อขัดข้องระหว่างบันทึกข้อมูล กรุณากดปุ่ม "ส่งข้อมูลซ้ำ (Retry)" เพื่อส่งซ้ำด้วยโทเค็นเดิมอย่างปลอดภัย';
        evidenceOperationCoordinator.markRecoveryRequired(owner, op.operation_id, attemptId, error);
        return { success: false, uncertain: true, error };
      }

      // Decode before classifying; `undefined` means the body could not be decoded.
      const body: unknown = await res.json().catch(() => undefined);

      if (res.status >= 400 && res.status < 500) {
        const authDenied = res.status === 401 || res.status === 403;
        const error =
          (body as any)?.message ||
          (res.status === 401
            ? 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่'
            : res.status === 403
              ? 'ไม่มีสิทธิ์ดำเนินการนี้ (Forbidden)'
              : `เกิดข้อผิดพลาดในการบันทึก (${res.status})`);
        const released = evidenceOperationCoordinator.rejectAttempt(owner, op.operation_id, attemptId, error, authDenied);
        if (authDenied && isUiOwner()) redactProtectedDisplay();
        return released ? { success: false, definitivelyRejected: true, error } : { success: false, uncertain: true, error };
      }

      if (res.ok) {
        const receipt = validateOperationReceipt(op, res.status, body);
        if (!receipt) {
          const error = 'ได้รับคำตอบที่ยืนยันผลการบันทึกไม่ได้ กรุณากดปุ่ม "ส่งข้อมูลซ้ำ (Retry)" เพื่อตรวจสอบด้วยโทเค็นเดิม';
          evidenceOperationCoordinator.markRecoveryRequired(owner, op.operation_id, attemptId, error);
          return { success: false, uncertain: true, error };
        }
        evidenceOperationCoordinator.markConfirmed(owner, op.operation_id, attemptId, receipt);
        if (!isUiOwner() || currentGen !== reqGenRef.current || controller.signal.aborted) {
          // Committed, but this screen no longer belongs to the attempt: the owner acknowledges later.
          return { success: false, uncertain: true, error: 'บันทึกสำเร็จแล้ว กรุณากด "ส่งข้อมูลซ้ำ (Retry)" เพื่อยืนยันผล' };
        }
        evidenceOperationCoordinator.settle(owner, op.operation_id);
        return { success: true, receipt };
      }

      // 5xx: uncertain
      const uncertainError = 'เซิร์ฟเวอร์ยังไม่ยืนยันผลการบันทึก กรุณากดปุ่ม "ส่งข้อมูลซ้ำ (Retry)" เพื่อดำเนินการต่อด้วยโทเค็นเดิม';
      evidenceOperationCoordinator.markRecoveryRequired(owner, op.operation_id, attemptId, uncertainError);
      return { success: false, uncertain: true, error: uncertainError };
    } finally {
      evidenceOperationCoordinator.endAttempt(owner, op.operation_id);
    }
  };

  // Replay the immutable stored operation independently of form mode (F1, F3 ARCH-A1 D1-D4, ARCH-A2 SF2)
  const handleRetryMutation = async () => {
    const currentActor = currentActorIdRef.current;
    if (!currentActor) return;
    const op = evidenceOperationCoordinator.getUnresolvedOperation(currentActor);
    if (!op || op.owner_actor_id !== currentActor) return;
    if (!isMountedRef.current || isReauthorizingRef.current) return;
    const capturedEpoch = authEpochRef.current;
    const ownsScreen = () =>
      isMountedRef.current &&
      !isReauthorizingRef.current &&
      currentActorIdRef.current === currentActor &&
      authEpochRef.current === capturedEpoch;

    setRetryNotice(null);
    setIsSubmittingRetry(true);
    const result = await executeCoordinatorOperation(op);
    if (isMountedRef.current && currentActorIdRef.current === currentActor) {
      setIsSubmittingRetry(false);
    }
    if (!ownsScreen()) {
      return;
    }

    if (result.success) {
      setShowCreateForm(false);
      setShowLinkExistingForm(false);
      setCorrectingEvidence(null);
      fetchEvidence(0, false);
      if (viewingHistoryId && op.target_evidence_id === viewingHistoryId) {
        fetchHistory(viewingHistoryId, 0, false);
      }
    } else if (result.definitivelyRejected) {
      if (op.kind === 'create') {
        setCreateError(result.error || 'บันทึกหลักฐานไม่สำเร็จ');
      } else if (op.kind === 'link') {
        setLinkExistingError(result.error || 'เชื่อมโยงหลักฐานไม่สำเร็จ');
      } else {
        setCorrectError(result.error || 'แก้ไขหลักฐานไม่สำเร็จ');
      }
    } else if (result.error) {
      setRetryNotice(result.error);
    }
  };

  // Item-level linked asset pagination (F6)
  const handleLoadMoreAssets = async (item: EvidenceItem) => {
    if (loadingAssetsForId || !isMountedRef.current || !currentUser || isReauthorizing) return;
    if (assetContinuationAbortRef.current) {
      assetContinuationAbortRef.current.abort();
    }
    const controller = new AbortController();
    assetContinuationAbortRef.current = controller;
    const currentGen = ++reqGenRef.current;

    setLoadingAssetsForId(item.id);
    try {
      const nextOffset = item.asset_ids.length;
      const res = await fetch(`/evidence/${item.id}?asset_limit=25&asset_offset=${nextOffset}`, {
        method: 'GET',
        credentials: 'include',
        signal: controller.signal,
      });

      if (!isMountedRef.current || controller.signal.aborted || currentGen !== reqGenRef.current || currentActorIdRef.current !== (currentUser?.id || null) || isReauthorizing) {
        return;
      }

      if (res.status === 401 || res.status === 403) {
        setEvidenceList([]);
        setEvidenceTotal(0);
        setCanCreate(false);
        setCanCorrect(false);
        setCorrectingEvidence(null);
        setShowLinkExistingForm(false);
        setViewingHistoryId(null);
        setHistoryItems([]);
        return;
      }
      if (res.ok) {
        const data = await res.json();
        if (!isMountedRef.current || controller.signal.aborted || currentGen !== reqGenRef.current || currentActorIdRef.current !== (currentUser?.id || null) || isReauthorizing) {
          return;
        }
        const newAssets: string[] = data.asset_ids || [];
        setEvidenceList((prev) =>
          prev.map((it) => {
            if (it.id === item.id) {
              const combined = Array.from(new Set([...it.asset_ids, ...newAssets]));
              return {
                ...it,
                asset_ids: combined,
                has_more_assets: Boolean(data.has_more_assets),
                asset_ids_total: data.asset_ids_total ?? it.asset_ids_total,
              };
            }
            return it;
          })
        );
        if (correctingEvidence && correctingEvidence.id === item.id) {
          setCorrectingEvidence((prev) => {
            if (!prev) return null;
            const combined = Array.from(new Set([...prev.asset_ids, ...newAssets]));
            return {
              ...prev,
              asset_ids: combined,
              has_more_assets: Boolean(data.has_more_assets),
              asset_ids_total: data.asset_ids_total ?? prev.asset_ids_total,
            };
          });
        }
      }
    } catch {
      // Abort or network error
    } finally {
      if (isMountedRef.current) {
        setLoadingAssetsForId(null);
      }
    }
  };

  // Dialog form helpers with generation tracking (F3 ARCH-A1 D1)
  const openCreateForm = () => {
    if (evidenceOperationCoordinator.hasActiveReservation(currentUser?.id)) return;
    dialogGenRef.current++;
    setShowLinkExistingForm(false);
    setCorrectingEvidence(null);
    setShowCreateForm(true);
  };
  const closeCreateForm = () => {
    if (evidenceOperationCoordinator.hasActiveReservation(currentUser?.id)) return;
    dialogGenRef.current++;
    setShowCreateForm(false);
  };
  const openLinkExistingForm = () => {
    if (evidenceOperationCoordinator.hasActiveReservation(currentUser?.id)) return;
    dialogGenRef.current++;
    setShowCreateForm(false);
    setCorrectingEvidence(null);
    setShowLinkExistingForm(true);
  };
  const closeLinkExistingForm = () => {
    if (evidenceOperationCoordinator.hasActiveReservation(currentUser?.id)) return;
    dialogGenRef.current++;
    setShowLinkExistingForm(false);
  };
  const openCorrectionForm = (item: EvidenceItem) => {
    if (evidenceOperationCoordinator.hasActiveReservation(currentUser?.id)) return;
    dialogGenRef.current++;
    setShowCreateForm(false);
    setShowLinkExistingForm(false);
    setCorrectingEvidence(item);
    setCorrectReason('');
    setCorrectRefType(item.reference_type || '');
    setCorrectRefText(item.reference_text || '');
    setCorrectDesc(item.description || '');
    setCorrectAcqAction('unchanged');
    setCorrectTargetAcqId('');
    setCorrectAddAssetIds('');
    setCorrectRemoveAssetIds([]);
    setCorrectError(null);
  };
  const closeCorrectionForm = () => {
    if (evidenceOperationCoordinator.hasActiveReservation(currentUser?.id)) return;
    dialogGenRef.current++;
    setCorrectingEvidence(null);
  };

  // Submit Evidence Creation (F3 ARCH-A1 D1-D4)
  const handleCreateSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!currentUser?.id) return;
    const capturedActor = currentUser.id;
    const capturedEpoch = authEpochRef.current;
    const capturedDialogGen = dialogGenRef.current;
    const capturedPath = typeof window !== 'undefined' ? window.location.pathname : '';

    const isOwned = () =>
      isMountedRef.current &&
      !isReauthorizingRef.current &&
      Boolean(currentUser) &&
      currentUser?.id === capturedActor &&
      currentActorIdRef.current === capturedActor &&
      authEpochRef.current === capturedEpoch &&
      dialogGenRef.current === capturedDialogGen &&
      (typeof window === 'undefined' || window.location.pathname === capturedPath) &&
      showCreateForm;

    if (!isOwned()) {
      return;
    }
    setCreateError(null);

    const addAssetList = createAdditionalAssetIds
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const allAssetIds = entityType === 'asset' ? Array.from(new Set([entityId, ...addAssetList])) : addAssetList;
    const targetAcqId = entityType === 'acquisition' ? entityId : createIncludeAcq && acquisitionId ? acquisitionId : null;

    const token = crypto.randomUUID();
    const payload = {
      reference_type: createRefType.trim().length > 0 ? createRefType.trim() : null,
      reference_text: createRefText.trim().length > 0 ? createRefText.trim() : null,
      description: createDesc.trim().length > 0 ? createDesc.trim() : null,
      acquisition_id: targetAcqId,
      asset_ids: allAssetIds,
    };

    const reserveResult = evidenceOperationCoordinator.reserve({
      actorId: capturedActor,
      kind: 'create',
      endpoint: '/evidence',
      payload,
      retryToken: token,
      authEpoch: capturedEpoch,
      context: { entityType, entityId },
      parents: { assetIds: allAssetIds, acquisitionIds: [targetAcqId] },
    });
    if (!reserveResult.success) {
      setCreateError(reserveResult.error || 'Cannot reserve operation');
      return;
    }
    const op = reserveResult.operation!;

    if (!isOwned()) {
      evidenceOperationCoordinator.retireUnsent(capturedActor, op.operation_id);
      return;
    }

    setIsSubmittingCreate(true);
    const result = await executeCoordinatorOperation(op, isOwned);
    if (isMountedRef.current && currentActorIdRef.current === capturedActor) {
      setIsSubmittingCreate(false);
    }

    if (!isOwned()) {
      return;
    }

    if (result.success) {
      closeCreateForm();
      setCreateRefType('');
      setCreateRefText('');
      setCreateDesc('');
      setCreateAdditionalAssetIds('');
      fetchEvidence(0, false);
    } else if (result.definitivelyRejected) {
      setCreateError(result.error || 'บันทึกหลักฐานไม่สำเร็จ');
    } else if (!result.uncertain && result.error) {
      setCreateError(result.error);
    }
  };

  // Submit Link Existing Evidence (F3, F5 ARCH-A1 D1-D4)
  const handleLinkExistingSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!currentUser?.id) return;
    const capturedActor = currentUser.id;
    const capturedEpoch = authEpochRef.current;
    const capturedDialogGen = dialogGenRef.current;
    const capturedPath = typeof window !== 'undefined' ? window.location.pathname : '';

    const isOwned = () =>
      isMountedRef.current &&
      !isReauthorizingRef.current &&
      Boolean(currentUser) &&
      currentUser?.id === capturedActor &&
      currentActorIdRef.current === capturedActor &&
      authEpochRef.current === capturedEpoch &&
      dialogGenRef.current === capturedDialogGen &&
      (typeof window === 'undefined' || window.location.pathname === capturedPath) &&
      showLinkExistingForm;

    if (!isOwned()) {
      return;
    }
    setLinkExistingError(null);

    const trimmedId = linkExistingId.trim();
    if (!trimmedId) {
      setLinkExistingError('กรุณาระบุ Evidence UUID ที่ต้องการเชื่อมโยง');
      return;
    }
    if (!linkExistingReason.trim()) {
      setLinkExistingError('กรุณาระบุเหตุผลการเชื่อมโยง (Mandatory Reason)');
      return;
    }

    let expVersion: number;
    if (typeof linkExistingVersion === 'number') {
      expVersion = linkExistingVersion;
    } else {
      try {
        if (!isOwned()) return;
        const checkRes = await fetch(`/evidence/${trimmedId}`, {
          credentials: 'include',
          signal: abortRef.current?.signal,
        });
        if (!isOwned()) return;
        if (!checkRes.ok) {
          setLinkExistingError(`ไม่พบหลักฐาน UUID ${trimmedId} (${checkRes.status})`);
          return;
        }
        const checkData = await checkRes.json();
        if (!isOwned()) return;
        expVersion = Number(checkData.version);
      } catch {
        if (!isOwned()) return;
        setLinkExistingError('ไม่สามารถตรวจสอบเวอร์ชันของหลักฐานเป้าหมายได้');
        return;
      }
    }

    if (!isOwned()) return;

    const token = crypto.randomUUID();
    const body: any = {
      expected_version: expVersion,
      reason: linkExistingReason.trim(),
    };

    if (entityType === 'asset') {
      body.add_asset_ids = [entityId];
    } else if (entityType === 'acquisition') {
      body.acquisition_id = entityId;
    }

    const reserveResult = evidenceOperationCoordinator.reserve({
      actorId: capturedActor,
      kind: 'link',
      endpoint: `/evidence/${trimmedId}/correct`,
      payload: body,
      retryToken: token,
      targetEvidenceId: trimmedId,
      targetVersion: expVersion,
      authEpoch: capturedEpoch,
      context: { entityType, entityId },
      parents: {
        assetIds: entityType === 'asset' ? [entityId] : [],
        acquisitionIds: entityType === 'acquisition' ? [entityId] : [],
      },
    });
    if (!reserveResult.success) {
      setLinkExistingError(reserveResult.error || 'Cannot reserve operation');
      return;
    }
    const op = reserveResult.operation!;

    if (!isOwned()) {
      evidenceOperationCoordinator.retireUnsent(capturedActor, op.operation_id);
      return;
    }

    setIsSubmittingLinkExisting(true);
    const result = await executeCoordinatorOperation(op, isOwned);
    if (isMountedRef.current && currentActorIdRef.current === capturedActor) {
      setIsSubmittingLinkExisting(false);
    }

    if (!isOwned()) {
      return;
    }

    if (result.success) {
      closeLinkExistingForm();
      setLinkExistingId('');
      setLinkExistingVersion('');
      setLinkExistingReason('');
      fetchEvidence(0, false);
    } else if (result.definitivelyRejected) {
      setLinkExistingError(result.error || 'เชื่อมโยงหลักฐานไม่สำเร็จ');
    } else if (!result.uncertain && result.error) {
      setLinkExistingError(result.error);
    }
  };

  // Submit Correction (F1, F3, F4, F5 ARCH-A1 D1-D4)
  const handleCorrectionSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!currentUser?.id || !correctingEvidence) return;
    const capturedActor = currentUser.id;
    const capturedEpoch = authEpochRef.current;
    const capturedDialogGen = dialogGenRef.current;
    const capturedPath = typeof window !== 'undefined' ? window.location.pathname : '';

    const isOwned = () =>
      isMountedRef.current &&
      !isReauthorizingRef.current &&
      Boolean(currentUser) &&
      currentUser?.id === capturedActor &&
      currentActorIdRef.current === capturedActor &&
      authEpochRef.current === capturedEpoch &&
      dialogGenRef.current === capturedDialogGen &&
      (typeof window === 'undefined' || window.location.pathname === capturedPath) &&
      correctingEvidence !== null;

    if (!isOwned() || !correctingEvidence) {
      return;
    }
    setCorrectError(null);

    const activeEvidenceId = correctingEvidence.id;

    if (!correctReason.trim()) {
      setCorrectError('กรุณาระบุเหตุผลการแก้ไข (Mandatory Reason)');
      return;
    }

    const addAssetList = correctAddAssetIds
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);

    const token = crypto.randomUUID();
    const body: any = {
      expected_version: correctingEvidence.version,
      reason: correctReason.trim(),
      reference_type: correctRefType.trim().length > 0 ? correctRefType.trim() : null,
      reference_text: correctRefText.trim().length > 0 ? correctRefText.trim() : null,
      description: correctDesc.trim().length > 0 ? correctDesc.trim() : null,
    };

    if (correctAcqAction === 'unlink') {
      body.acquisition_id = null;
    } else if (correctAcqAction === 'change') {
      body.acquisition_id = correctTargetAcqId.trim();
    }

    if (addAssetList.length > 0) {
      body.add_asset_ids = addAssetList;
    }
    if (correctRemoveAssetIds.length > 0) {
      body.remove_asset_ids = correctRemoveAssetIds;
    }

    const reserveResult = evidenceOperationCoordinator.reserve({
      actorId: capturedActor,
      kind: 'correct',
      endpoint: `/evidence/${activeEvidenceId}/correct`,
      payload: body,
      retryToken: token,
      targetEvidenceId: activeEvidenceId,
      targetVersion: correctingEvidence.version,
      authEpoch: capturedEpoch,
      context: { entityType, entityId },
      parents: {
        assetIds: [...addAssetList, ...correctRemoveAssetIds],
        // The Acquisition before and after the correction (P5)
        acquisitionIds: [
          correctingEvidence.acquisition_id,
          typeof body.acquisition_id === 'string' ? body.acquisition_id : null,
        ],
      },
    });
    if (!reserveResult.success) {
      setCorrectError(reserveResult.error || 'Cannot reserve operation');
      return;
    }
    const op = reserveResult.operation!;

    if (!isOwned()) {
      evidenceOperationCoordinator.retireUnsent(capturedActor, op.operation_id);
      return;
    }

    setIsSubmittingCorrect(true);
    const result = await executeCoordinatorOperation(op, isOwned);
    if (isMountedRef.current && currentActorIdRef.current === capturedActor) {
      setIsSubmittingCorrect(false);
    }

    if (!isOwned()) {
      return;
    }

    if (result.success) {
      closeCorrectionForm();
      fetchEvidence(0, false);
      if (viewingHistoryId === activeEvidenceId) {
        fetchHistory(activeEvidenceId, 0, false);
      }
    } else if (result.definitivelyRejected) {
      setCorrectError(result.error || 'แก้ไขหลักฐานไม่สำเร็จ');
    } else if (!result.uncertain && result.error) {
      setCorrectError(result.error);
    }
  };

  // Unlink specific asset from evidence (F3 ARCH-A1 D1-D4)
  const handleUnlinkAsset = async (evidenceItem: EvidenceItem, assetIdToUnlink: string) => {
    if (!currentUser?.id) return;
    const capturedActor = currentUser.id;
    const capturedEpoch = authEpochRef.current;
    const capturedPath = typeof window !== 'undefined' ? window.location.pathname : '';

    const isOwned = () =>
      isMountedRef.current &&
      !isReauthorizingRef.current &&
      Boolean(currentUser) &&
      currentUser?.id === capturedActor &&
      currentActorIdRef.current === capturedActor &&
      authEpochRef.current === capturedEpoch &&
      (typeof window === 'undefined' || window.location.pathname === capturedPath);

    if (!isOwned()) {
      return;
    }

    if (evidenceOperationCoordinator.hasActiveReservation(capturedActor)) {
      alert('มีรายการที่อยู่ระหว่างดำเนินการ กรุณาดำเนินการรายการเดิมให้เสร็จสิ้นก่อน');
      return;
    }

    const reasonPrompt = window.prompt(`ระบุเหตุผลในการถอดการเชื่อมโยงสินทรัพย์ (Mandatory Reason):`);
    if (!reasonPrompt || !reasonPrompt.trim()) {
      alert('จำเป็นต้องระบุเหตุผลในการแก้ไขความเชื่อมโยง');
      return;
    }

    if (!isOwned()) {
      return;
    }

    const token = crypto.randomUUID();
    const payload = {
      expected_version: evidenceItem.version,
      reason: reasonPrompt.trim(),
      remove_asset_ids: [assetIdToUnlink],
    };

    const reserveResult = evidenceOperationCoordinator.reserve({
      actorId: capturedActor,
      kind: 'unlink',
      endpoint: `/evidence/${evidenceItem.id}/correct`,
      payload,
      retryToken: token,
      targetEvidenceId: evidenceItem.id,
      targetVersion: evidenceItem.version,
      authEpoch: capturedEpoch,
      context: { entityType, entityId },
      parents: { assetIds: [assetIdToUnlink], acquisitionIds: [evidenceItem.acquisition_id] },
    });
    if (!reserveResult.success) {
      alert(reserveResult.error || 'Cannot reserve operation');
      return;
    }
    const op = reserveResult.operation!;

    if (!isOwned()) {
      evidenceOperationCoordinator.retireUnsent(capturedActor, op.operation_id);
      return;
    }

    const result = await executeCoordinatorOperation(op, isOwned);

    if (!isOwned()) {
      return;
    }

    if (result.success) {
      fetchEvidence(0, false);
      if (viewingHistoryId === evidenceItem.id) {
        fetchHistory(evidenceItem.id, 0, false);
      }
    } else if (result.definitivelyRejected) {
      alert(result.error || 'ไม่สามารถถอดการเชื่อมโยงสินทรัพย์ได้');
    } else if (!result.uncertain && result.error) {
      alert(result.error);
    }
  };

  return (
    <section
      data-testid="evidence-panel-section"
      style={{
        marginTop: '2rem',
        padding: '1.5rem',
        backgroundColor: '#ffffff',
        borderRadius: '8px',
        border: '1px solid #e5e7eb',
        boxShadow: '0 1px 3px rgba(0, 0, 0, 0.05)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1rem',
          flexWrap: 'wrap',
          gap: '0.5rem',
        }}
      >
        <div>
          <h2 style={{ fontSize: '1.25rem', fontWeight: 600, color: '#111827', margin: 0 }}>
            หลักฐานและเอกสารอ้างอิง (Evidence & References)
          </h2>
          <span style={{ fontSize: '0.8125rem', color: '#6b7280' }}>
            {entityType === 'acquisition' ? 'การได้มา' : 'สินทรัพย์'}: {entityId}
            {evidenceTotal > 0 && ` (ทั้งหมด ${evidenceTotal} รายการ)`}
          </span>
        </div>

        <div style={{ display: 'flex', gap: '0.5rem' }}>
          {canCreate && (
            <button
              data-testid="add-evidence-btn"
              onClick={() => {
                if (showCreateForm) {
                  closeCreateForm();
                } else {
                  openCreateForm();
                }
              }}
              disabled={isActionBlocked}
              style={{
                padding: '0.5rem 1rem',
                backgroundColor: showCreateForm ? '#4b5563' : '#2563eb',
                color: '#ffffff',
                border: 'none',
                borderRadius: '4px',
                fontWeight: 500,
                cursor: isActionBlocked ? 'not-allowed' : 'pointer',
                fontSize: '0.875rem',
              }}
            >
              {showCreateForm ? 'ยกเลิก' : '+ บันทึกหลักฐานใหม่'}
            </button>
          )}

          {canCorrect && (
            <button
              data-testid="link-existing-evidence-btn"
              onClick={() => {
                if (showLinkExistingForm) {
                  closeLinkExistingForm();
                } else {
                  openLinkExistingForm();
                }
              }}
              disabled={isActionBlocked}
              style={{
                padding: '0.5rem 1rem',
                backgroundColor: showLinkExistingForm ? '#4b5563' : '#059669',
                color: '#ffffff',
                border: 'none',
                borderRadius: '4px',
                fontWeight: 500,
                cursor: isActionBlocked ? 'not-allowed' : 'pointer',
                fontSize: '0.875rem',
              }}
            >
              {showLinkExistingForm ? 'ยกเลิก' : '🔗 เชื่อมโยงหลักฐานเดิม'}
            </button>
          )}
        </div>
      </div>

      {/* Uncertain Mutation Banner (F1, F3 ARCH-A1 D1-D4) */}
      {currentOp && (currentOp.phase === 'RECOVERY_REQUIRED' || currentOp.phase === 'CONFIRMED') && (
        <div
          data-testid="uncertain-mutation-alert"
          style={{
            padding: '1rem',
            backgroundColor: '#fffbeb',
            border: '1px solid #f59e0b',
            borderRadius: '6px',
            marginBottom: '1rem',
            color: '#92400e',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: '0.5rem' }}>⚠️ ผลการส่งข้อมูลยังไม่ได้รับการยืนยัน (Uncertain State)</div>
          <p style={{ margin: '0 0 0.75rem 0', fontSize: '0.875rem' }}>
            เซิร์ฟเวอร์ยังไม่ตอบกลับการดำเนินการ กรุณากดส่งข้อมูลซ้ำ (Retry) เพื่อใช้โทเค็นเดิมอย่างปลอดภัย โดยไม่มีการสร้างข้อมูลซ้ำซ้อน
          </p>
          {currentOp.auth_suspended && (
            <p data-testid="uncertain-mutation-auth-suspended" style={{ margin: '0 0 0.75rem 0', fontSize: '0.875rem' }}>
              สิทธิ์ปัจจุบันไม่อนุญาตให้ส่งรายการเดิมซ้ำ รายการเดิมยังถูกกักไว้ เมื่อสิทธิ์กลับมาให้กด Retry เพื่อส่งรายการเดิมด้วยโทเค็นเดิม
            </p>
          )}
          {retryNotice && (
            <p data-testid="uncertain-mutation-notice" style={{ margin: '0 0 0.75rem 0', fontSize: '0.875rem' }}>
              {retryNotice}
            </p>
          )}
          <button
            data-testid="retry-mutation-btn"
            onClick={handleRetryMutation}
            disabled={isSubmittingRetry}
            style={{
              padding: '0.5rem 1rem',
              backgroundColor: '#d97706',
              color: '#ffffff',
              border: 'none',
              borderRadius: '4px',
              fontWeight: 600,
              cursor: isSubmittingRetry ? 'not-allowed' : 'pointer',
            }}
          >
            {isSubmittingRetry ? 'กำลังส่งข้อมูลซ้ำ...' : '🔄 ส่งข้อมูลซ้ำ (Retry Mutation)'}
          </button>
        </div>
      )}

      {/* Creation Form (Custodian) */}
      {showCreateForm && (
        <form
          data-testid="evidence-create-form"
          onSubmit={handleCreateSubmit}
          style={{
            padding: '1.25rem',
            backgroundColor: '#f9fafb',
            borderRadius: '6px',
            border: '1px solid #d1d5db',
            marginBottom: '1.5rem',
          }}
        >
          <h3 style={{ margin: '0 0 1rem 0', fontSize: '1rem', fontWeight: 600, color: '#1f2937' }}>
            บันทึกหลักฐานใหม่ (Create Evidence)
          </h3>

          {createError && (
            <div data-testid="evidence-create-error" style={{ color: '#dc2626', marginBottom: '0.75rem', fontSize: '0.875rem' }}>
              {createError}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '1rem', marginBottom: '0.75rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 500, color: '#374151', marginBottom: '0.25rem' }}>
                ประเภทเอกสาร (Type - ≤100 ตัวอักษร)
              </label>
              <input
                data-testid="create-ref-type-input"
                type="text"
                value={createRefType}
                onChange={(e) => setCreateRefType(e.target.value)}
                placeholder="เช่น ใบเสร็จ, สัญญาซื้อขาย"
                disabled={isActionBlocked}
                style={{ width: '100%', padding: '0.5rem', border: '1px solid #d1d5db', borderRadius: '4px' }}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 500, color: '#374151', marginBottom: '0.25rem' }}>
                ข้อความอ้างอิง (Reference Text - ≤500 ตัวอักษร)
              </label>
              <input
                data-testid="create-ref-text-input"
                type="text"
                value={createRefText}
                onChange={(e) => setCreateRefText(e.target.value)}
                placeholder="เช่น INV-2026-001 หรือ เลขที่สัญญา"
                disabled={isActionBlocked}
                style={{ width: '100%', padding: '0.5rem', border: '1px solid #d1d5db', borderRadius: '4px' }}
              />
            </div>
          </div>

          <div style={{ marginBottom: '0.75rem' }}>
            <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 500, color: '#374151', marginBottom: '0.25rem' }}>
              รายละเอียดหลักฐาน (Description - ≤2000 ตัวอักษร)
            </label>
            <textarea
              data-testid="create-desc-input"
              value={createDesc}
              onChange={(e) => setCreateDesc(e.target.value)}
              placeholder="รายละเอียดของหลักฐาน วันที่ ผู้ออกเอกสาร ฯลฯ"
              rows={3}
              disabled={isActionBlocked}
              style={{ width: '100%', padding: '0.5rem', border: '1px solid #d1d5db', borderRadius: '4px' }}
            />
          </div>

          {entityType === 'asset' && acquisitionId && (
            <div style={{ marginBottom: '0.75rem' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '0.875rem', color: '#374151' }}>
                <input
                  type="checkbox"
                  checked={createIncludeAcq}
                  onChange={(e) => setCreateIncludeAcq(e.target.checked)}
                  disabled={isActionBlocked}
                />
                เชื่อมโยงไปยังการได้มาของสินทรัพย์นี้ด้วย ({acquisitionId})
              </label>
            </div>
          )}

          <div style={{ marginBottom: '1rem' }}>
            <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 500, color: '#374151', marginBottom: '0.25rem' }}>
              สินทรัพย์อื่นที่เกี่ยวข้อง (Asset UUIDs คั่นด้วยจุลภาค)
            </label>
            <input
              data-testid="create-additional-assets-input"
              type="text"
              value={createAdditionalAssetIds}
              onChange={(e) => setCreateAdditionalAssetIds(e.target.value)}
              placeholder="UUID1, UUID2..."
              disabled={isActionBlocked}
              style={{ width: '100%', padding: '0.5rem', border: '1px solid #d1d5db', borderRadius: '4px' }}
            />
          </div>

          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              data-testid="create-evidence-submit-btn"
              type="submit"
              disabled={isActionBlocked}
              style={{
                padding: '0.5rem 1rem',
                backgroundColor: '#2563eb',
                color: '#ffffff',
                border: 'none',
                borderRadius: '4px',
                fontWeight: 500,
                cursor: isActionBlocked ? 'not-allowed' : 'pointer',
              }}
            >
              {isSubmittingCreate ? 'กำลังบันทึก...' : 'บันทึกหลักฐาน'}
            </button>
            <button
              type="button"
              onClick={closeCreateForm}
              disabled={isActionBlocked}
              style={{
                padding: '0.5rem 1rem',
                backgroundColor: '#ffffff',
                color: '#374151',
                border: '1px solid #d1d5db',
                borderRadius: '4px',
                cursor: isActionBlocked ? 'not-allowed' : 'pointer',
              }}
            >
              ยกเลิก
            </button>
          </div>
        </form>
      )}

      {/* Link Existing Evidence Form (F5) */}
      {showLinkExistingForm && (
        <form
          data-testid="link-existing-evidence-form"
          onSubmit={handleLinkExistingSubmit}
          style={{
            padding: '1.25rem',
            backgroundColor: '#ecfdf5',
            borderRadius: '6px',
            border: '1px solid #a7f3d0',
            marginBottom: '1.5rem',
          }}
        >
          <h3 style={{ margin: '0 0 1rem 0', fontSize: '1rem', fontWeight: 600, color: '#065f46' }}>
            🔗 เชื่อมโยงหลักฐานที่มีอยู่แล้ว (Link Existing Evidence)
          </h3>

          {linkExistingError && (
            <div data-testid="link-existing-evidence-error" style={{ color: '#dc2626', marginBottom: '0.75rem', fontSize: '0.875rem' }}>
              {linkExistingError}
            </div>
          )}

          <div style={{ marginBottom: '0.75rem' }}>
            <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 500, color: '#065f46', marginBottom: '0.25rem' }}>
              Evidence UUID *
            </label>
            <input
              data-testid="link-existing-id-input"
              type="text"
              value={linkExistingId}
              onChange={(e) => setLinkExistingId(e.target.value)}
              placeholder="ระบุ UUID ของ Evidence ที่มีอยู่ในระบบ"
              disabled={isActionBlocked}
              style={{ width: '100%', padding: '0.5rem', border: '1px solid #a7f3d0', borderRadius: '4px' }}
            />
          </div>

          <div style={{ marginBottom: '0.75rem' }}>
            <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 500, color: '#065f46', marginBottom: '0.25rem' }}>
              เหตุผลการเชื่อมโยง (Mandatory Reason *)
            </label>
            <input
              data-testid="link-existing-reason-input"
              type="text"
              value={linkExistingReason}
              onChange={(e) => setLinkExistingReason(e.target.value)}
              placeholder="เช่น เชื่อมโยงเอกสารซื้อขายฉบับเดียวกันเข้ากับสินทรัพย์นี้"
              disabled={isActionBlocked}
              style={{ width: '100%', padding: '0.5rem', border: '1px solid #a7f3d0', borderRadius: '4px' }}
            />
          </div>

          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              data-testid="submit-link-existing-btn"
              type="submit"
              disabled={isActionBlocked}
              style={{
                padding: '0.5rem 1rem',
                backgroundColor: '#059669',
                color: '#ffffff',
                border: 'none',
                borderRadius: '4px',
                fontWeight: 500,
                cursor: isActionBlocked ? 'not-allowed' : 'pointer',
              }}
            >
              {isSubmittingLinkExisting ? 'กำลังเชื่อมโยง...' : 'เชื่อมโยงหลักฐาน'}
            </button>
            <button
              type="button"
              onClick={closeLinkExistingForm}
              disabled={isActionBlocked}
              style={{
                padding: '0.5rem 1rem',
                backgroundColor: '#ffffff',
                color: '#374151',
                border: '1px solid #d1d5db',
                borderRadius: '4px',
                cursor: isActionBlocked ? 'not-allowed' : 'pointer',
              }}
            >
              ยกเลิก
            </button>
          </div>
        </form>
      )}

      {/* Reasoned Correction Form (D8) */}
      {correctingEvidence && (
        <form
          data-testid="evidence-correct-form"
          onSubmit={handleCorrectionSubmit}
          style={{
            padding: '1.25rem',
            backgroundColor: '#fffbeb',
            borderRadius: '6px',
            border: '1px solid #fde68a',
            marginBottom: '1.5rem',
          }}
        >
          <h3 style={{ margin: '0 0 1rem 0', fontSize: '1rem', fontWeight: 600, color: '#92400e' }}>
            แก้ไขข้อมูลหลักฐานพร้อมระบุเหตุผล (Reasoned Correction - v{correctingEvidence.version})
          </h3>

          {correctError && (
            <div data-testid="correct-evidence-error" style={{ color: '#dc2626', marginBottom: '0.75rem', fontSize: '0.875rem' }}>
              {correctError}
            </div>
          )}

          <div style={{ marginBottom: '0.75rem' }}>
            <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: '#b45309', marginBottom: '0.25rem' }}>
              เหตุผลในการแก้ไข (Mandatory Reason *)
            </label>
            <input
              data-testid="correct-reason-input"
              type="text"
              value={correctReason}
              onChange={(e) => setCorrectReason(e.target.value)}
              placeholder="ระบุเหตุผล เช่น แก้ไขข้อผิดพลาดของเลขที่ใบเสร็จ หรือ ปรับปรุงการเชื่อมโยง"
              disabled={isActionBlocked}
              style={{ width: '100%', padding: '0.5rem', border: '1px solid #fde68a', borderRadius: '4px' }}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: '1rem', marginBottom: '0.75rem' }}>
            <div>
              <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 500, color: '#374151', marginBottom: '0.25rem' }}>
                ประเภทเอกสาร (Type)
              </label>
              <input
                data-testid="correct-ref-type-input"
                type="text"
                value={correctRefType}
                onChange={(e) => setCorrectRefType(e.target.value)}
                disabled={isActionBlocked}
                style={{ width: '100%', padding: '0.5rem', border: '1px solid #d1d5db', borderRadius: '4px' }}
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 500, color: '#374151', marginBottom: '0.25rem' }}>
                ข้อความอ้างอิง (Reference Text)
              </label>
              <input
                data-testid="correct-ref-text-input"
                type="text"
                value={correctRefText}
                onChange={(e) => setCorrectRefText(e.target.value)}
                disabled={isActionBlocked}
                style={{ width: '100%', padding: '0.5rem', border: '1px solid #d1d5db', borderRadius: '4px' }}
              />
            </div>
          </div>

          <div style={{ marginBottom: '0.75rem' }}>
            <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 500, color: '#374151', marginBottom: '0.25rem' }}>
              รายละเอียด (Description)
            </label>
            <textarea
              data-testid="correct-desc-input"
              value={correctDesc}
              onChange={(e) => setCorrectDesc(e.target.value)}
              rows={2}
              disabled={isActionBlocked}
              style={{ width: '100%', padding: '0.5rem', border: '1px solid #d1d5db', borderRadius: '4px' }}
            />
          </div>

          {/* Acquisition Link Action (F5) */}
          <div style={{ marginBottom: '0.75rem', padding: '0.75rem', backgroundColor: '#fef3c7', borderRadius: '4px' }}>
            <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 600, color: '#92400e', marginBottom: '0.25rem' }}>
              การเชื่อมโยงกับการได้มา (Acquisition Parent Action)
            </label>
            <div style={{ display: 'flex', gap: '1rem', fontSize: '0.8125rem', marginBottom: '0.5rem' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                <input
                  type="radio"
                  name="acqAction"
                  checked={correctAcqAction === 'unchanged'}
                  onChange={() => setCorrectAcqAction('unchanged')}
                  disabled={isActionBlocked}
                />
                คงเดิม ({correctingEvidence.acquisition_id || 'ไม่มี'})
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                <input
                  type="radio"
                  name="acqAction"
                  checked={correctAcqAction === 'unlink'}
                  onChange={() => setCorrectAcqAction('unlink')}
                  disabled={isActionBlocked}
                />
                ถอดการเชื่อมโยงการได้มา (Unlink)
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                <input
                  type="radio"
                  name="acqAction"
                  checked={correctAcqAction === 'change'}
                  onChange={() => setCorrectAcqAction('change')}
                  disabled={isActionBlocked}
                />
                เปลี่ยนการได้มา (Reassociate)
              </label>
            </div>
            {correctAcqAction === 'change' && (
              <input
                data-testid="correction-target-acq-input"
                type="text"
                value={correctTargetAcqId}
                onChange={(e) => setCorrectTargetAcqId(e.target.value)}
                placeholder="ระบุ Acquisition UUID ใหม่"
                disabled={isActionBlocked}
                style={{ width: '100%', padding: '0.375rem', border: '1px solid #d1d5db', borderRadius: '4px', fontSize: '0.8125rem' }}
              />
            )}
          </div>

          <div style={{ marginBottom: '0.75rem' }}>
            <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 500, color: '#374151', marginBottom: '0.25rem' }}>
              เพิ่มการเชื่อมโยงสินทรัพย์ (Add Asset UUIDs)
            </label>
            <input
              data-testid="correction-add-assets-input"
              type="text"
              value={correctAddAssetIds}
              onChange={(e) => setCorrectAddAssetIds(e.target.value)}
              placeholder="UUID1, UUID2..."
              disabled={isActionBlocked}
              style={{ width: '100%', padding: '0.5rem', border: '1px solid #d1d5db', borderRadius: '4px' }}
            />
          </div>

          {correctingEvidence.asset_ids.length > 0 && (
            <div style={{ marginBottom: '1rem' }}>
              <label style={{ display: 'block', fontSize: '0.8125rem', fontWeight: 500, color: '#374151', marginBottom: '0.25rem' }}>
                เลือกสินทรัพย์ที่ต้องการถอดการเชื่อมโยง (Remove Links)
              </label>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
                {correctingEvidence.asset_ids.map((aid) => {
                  const isChecked = correctRemoveAssetIds.includes(aid);
                  return (
                    <label
                      key={aid}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '0.25rem',
                        fontSize: '0.75rem',
                        backgroundColor: '#ffffff',
                        padding: '0.25rem 0.5rem',
                        border: '1px solid #d1d5db',
                        borderRadius: '4px',
                      }}
                    >
                      <input
                        data-testid={`correct-remove-asset-checkbox-${aid}`}
                        type="checkbox"
                        checked={isChecked}
                        disabled={isActionBlocked}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setCorrectRemoveAssetIds((prev) => [...prev, aid]);
                          } else {
                            setCorrectRemoveAssetIds((prev) => prev.filter((id) => id !== aid));
                          }
                        }}
                      />
                      {aid}
                    </label>
                  );
                })}
              </div>
              {(correctingEvidence.has_more_assets ||
                (correctingEvidence.asset_ids_total && correctingEvidence.asset_ids_total > correctingEvidence.asset_ids.length)) && (
                <button
                  type="button"
                  data-testid="correction-load-more-assets-btn"
                  onClick={() => handleLoadMoreAssets(correctingEvidence)}
                  disabled={loadingAssetsForId === correctingEvidence.id || isActionBlocked}
                  style={{
                    marginTop: '0.5rem',
                    fontSize: '0.75rem',
                    color: '#2563eb',
                    backgroundColor: 'transparent',
                    border: 'none',
                    cursor: loadingAssetsForId === correctingEvidence.id || isActionBlocked ? 'not-allowed' : 'pointer',
                    padding: 0,
                  }}
                >
                  {loadingAssetsForId === correctingEvidence.id ? 'กำลังโหลดสินทรัพย์เพิ่มเติม...' : '➕ โหลดสินทรัพย์เพื่อเลือกถอดเพิ่มเติม'}
                </button>
              )}
            </div>
          )}

          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button
              data-testid="correct-evidence-submit-btn"
              type="submit"
              disabled={isActionBlocked}
              style={{
                padding: '0.5rem 1rem',
                backgroundColor: '#d97706',
                color: '#ffffff',
                border: 'none',
                borderRadius: '4px',
                fontWeight: 500,
                cursor: isActionBlocked ? 'not-allowed' : 'pointer',
              }}
            >
              {isSubmittingCorrect ? 'กำลังบันทึกการแก้ไข...' : 'บันทึกการแก้ไข'}
            </button>
            <button
              type="button"
              onClick={closeCorrectionForm}
              disabled={isActionBlocked}
              style={{
                padding: '0.5rem 1rem',
                backgroundColor: '#ffffff',
                color: '#374151',
                border: '1px solid #d1d5db',
                borderRadius: '4px',
                cursor: isActionBlocked ? 'not-allowed' : 'pointer',
              }}
            >
              ยกเลิก
            </button>
          </div>
        </form>
      )}

      {/* Main Evidence List Area */}
      {isLoading ? (
        <div style={{ color: '#6b7280', padding: '1rem 0' }}>กำลังโหลดข้อมูลหลักฐานอ้างอิง...</div>
      ) : fetchError ? (
        <div data-testid="evidence-fetch-error" style={{ color: '#dc2626', padding: '1rem 0' }}>{fetchError}</div>
      ) : evidenceList.length === 0 ? (
        <div data-testid="no-evidence-message" style={{ color: '#6b7280', padding: '1rem 0', fontStyle: 'italic' }}>
          ยังไม่มีหลักฐานหรือเอกสารอ้างอิงที่เชื่อมโยงกับรายการนี้
        </div>
      ) : (
        <div data-testid="evidence-table" style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          {evidenceList.map((item) => (
            <div
              key={item.id}
              data-testid={`evidence-row-${item.id}`}
              style={{
                padding: '1rem',
                backgroundColor: '#f9fafb',
                borderRadius: '6px',
                border: '1px solid #e5e7eb',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  marginBottom: '0.5rem',
                  flexWrap: 'wrap',
                  gap: '0.5rem',
                }}
              >
                <div>
                  <span
                    style={{
                      display: 'inline-block',
                      backgroundColor: '#e0e7ff',
                      color: '#3730a3',
                      fontSize: '0.75rem',
                      fontWeight: 600,
                      padding: '0.125rem 0.5rem',
                      borderRadius: '4px',
                      marginRight: '0.5rem',
                    }}
                  >
                    {item.reference_type || 'หลักฐานทั่วไป'} (<span data-testid={`evidence-version-${item.id}`}>v{item.version}</span>)
                  </span>
                  <span data-testid="evidence-id" style={{ fontSize: '0.75rem', color: '#6b7280', fontFamily: 'monospace' }}>
                    ID: {item.id}
                  </span>
                </div>

                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  {canCorrect && (
                    <button
                      data-testid={`correct-evidence-btn-${item.id}`}
                      onClick={() => openCorrectionForm(item)}
                      disabled={isActionBlocked}
                      style={{
                        padding: '0.25rem 0.5rem',
                        fontSize: '0.75rem',
                        backgroundColor: '#ffffff',
                        color: '#d97706',
                        border: '1px solid #d97706',
                        borderRadius: '4px',
                        cursor: isActionBlocked ? 'not-allowed' : 'pointer',
                      }}
                    >
                      ✏️ แก้ไข (Correct)
                    </button>
                  )}

                  <button
                    data-testid={`view-history-btn-${item.id}`}
                    onClick={() => toggleHistory(item.id)}
                    style={{
                      padding: '0.25rem 0.5rem',
                      fontSize: '0.75rem',
                      backgroundColor: '#ffffff',
                      color: '#4b5563',
                      border: '1px solid #9ca3af',
                      borderRadius: '4px',
                      cursor: 'pointer',
                    }}
                  >
                    {viewingHistoryId === item.id ? 'ซ่อนประวัติ' : '📜 ดูประวัติ'}
                  </button>
                </div>
              </div>

              {/* Reference Text - Safe Plain Text Rendering (B2) */}
              {item.reference_text && (
                <div style={{ marginBottom: '0.375rem' }}>
                  <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#374151' }}>เลขอ้างอิง: </span>
                  <span data-testid={`evidence-ref-text-${item.id}`} style={{ fontSize: '0.875rem', color: '#111827' }}>
                    {item.reference_text}
                  </span>
                </div>
              )}

              {/* Description - Safe Plain Text Rendering (B2) */}
              {item.description && (
                <div style={{ marginBottom: '0.5rem' }}>
                  <span style={{ fontSize: '0.8125rem', fontWeight: 600, color: '#374151' }}>รายละเอียด: </span>
                  <span data-testid="evidence-description" style={{ fontSize: '0.875rem', color: '#4b5563', whiteSpace: 'pre-wrap' }}>
                    {item.description}
                  </span>
                </div>
              )}

              {/* Parents disclosure (B1) */}
              <div style={{ fontSize: '0.75rem', color: '#6b7280', marginTop: '0.5rem' }}>
                <div>
                  <strong>การได้มา (Acquisition):</strong>{' '}
                  <span data-testid="evidence-acquisition-id">
                    {item.acquisition_id ? item.acquisition_id : 'ไม่มี (Asset-only Evidence)'}
                  </span>
                </div>
                <div style={{ marginTop: '0.25rem' }}>
                  <strong>สินทรัพย์ที่เชื่อมโยง ({item.asset_ids_total ?? item.asset_ids.length} รายการ):</strong>
                  {item.asset_ids.length === 0 ? (
                    <span style={{ fontStyle: 'italic', marginLeft: '0.25rem' }}>ไม่มีสินทรัพย์เชื่อมโยงโดยตรง</span>
                  ) : (
                    <ul style={{ margin: '0.25rem 0 0 1rem', padding: 0 }}>
                      {item.asset_ids.map((aid) => (
                        <li key={aid} style={{ marginBottom: '0.125rem' }}>
                          <span data-testid="linked-asset-id" style={{ fontFamily: 'monospace' }}>
                            {aid}
                          </span>
                          {canCorrect && (
                            <button
                              data-testid={`unlink-asset-btn-${aid}`}
                              onClick={() => handleUnlinkAsset(item, aid)}
                              disabled={isActionBlocked}
                              style={{
                                marginLeft: '0.5rem',
                                color: '#dc2626',
                                backgroundColor: 'transparent',
                                border: 'none',
                                cursor: isActionBlocked ? 'not-allowed' : 'pointer',
                                fontSize: '0.75rem',
                              }}
                            >
                              [ถอดการเชื่อมโยง]
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {(item.has_more_assets || (item.asset_ids_total && item.asset_ids_total > item.asset_ids.length)) && (
                    <button
                      type="button"
                      data-testid={`load-more-assets-btn-${item.id}`}
                      onClick={() => handleLoadMoreAssets(item)}
                      disabled={loadingAssetsForId === item.id}
                      style={{
                        marginTop: '0.25rem',
                        fontSize: '0.75rem',
                        color: '#2563eb',
                        backgroundColor: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                        padding: 0,
                      }}
                    >
                      {loadingAssetsForId === item.id ? 'กำลังโหลดสินทรัพย์เพิ่มเติม...' : '➕ โหลดสินทรัพย์ที่เชื่อมโยงเพิ่มเติม'}
                    </button>
                  )}
                </div>
              </div>

              {/* History Trace Section (B4, F5, F6) */}
              {viewingHistoryId === item.id && (
                <div
                  data-testid="evidence-history-section"
                  style={{
                    marginTop: '1rem',
                    padding: '0.75rem',
                    backgroundColor: '#ffffff',
                    border: '1px solid #d1d5db',
                    borderRadius: '4px',
                  }}
                >
                  <h4 style={{ margin: '0 0 0.5rem 0', fontSize: '0.875rem', fontWeight: 600, color: '#374151' }}>
                    ประวัติการแก้ไขหลักฐาน (Evidence History - {historyTotal} รายการ)
                  </h4>

                  {isLoadingHistory && historyItems.length === 0 ? (
                    <div style={{ fontSize: '0.75rem', color: '#6b7280' }}>กำลังโหลดประวัติ...</div>
                  ) : historyError ? (
                    <div style={{ fontSize: '0.75rem', color: '#dc2626' }}>{historyError}</div>
                  ) : historyItems.length === 0 ? (
                    <div style={{ fontSize: '0.75rem', color: '#6b7280' }}>ไม่มีข้อมูลประวัติ</div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                      {historyItems.map((h) => (
                        <div
                          key={h.id}
                          data-testid="evidence-history-item"
                          style={{
                            padding: '0.5rem',
                            backgroundColor: '#f3f4f6',
                            borderRadius: '4px',
                            fontSize: '0.75rem',
                            color: '#374151',
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.25rem' }}>
                            <span style={{ fontWeight: 600 }}>
                              {h.action} (v{h.version})
                            </span>
                            <span style={{ color: '#6b7280' }}>
                              {h.recorded_at ? new Date(h.recorded_at).toLocaleString('th-TH') : ''}
                            </span>
                          </div>

                          <div style={{ color: '#4b5563', marginBottom: '0.25rem' }}>
                            <strong>ผู้ดำเนินการ (Actor ID):</strong> {h.actor_id}
                          </div>

                          {h.reason && (
                            <div style={{ color: '#92400e', marginBottom: '0.25rem' }}>
                              <strong>เหตุผล (Reason):</strong> {h.reason}
                            </div>
                          )}

                          {/* Before / After metadata and link changes (F5) */}
                          {h.before_state ? (
                            <div style={{ marginTop: '0.25rem', fontSize: '0.71875rem', color: '#4b5563' }}>
                              <div>
                                <strong>ก่อนหน้า:</strong> ref_type: "{h.before_state?.reference_type || '-'}", ref_text: "{h.before_state?.reference_text || '-'}", desc: "{h.before_state?.description || '-'}", acq: {h.before_state?.acquisition_id || '-'}
                              </div>
                              <div>
                                <strong>การเปลี่ยนแปลง:</strong> ref_type: "{h.after_state?.reference_type || '-'}", ref_text: "{h.after_state?.reference_text || '-'}", desc: "{h.after_state?.description || '-'}", acq: {h.after_state?.acquisition_id || '-'}
                              </div>
                            </div>
                          ) : (
                            <div style={{ marginTop: '0.25rem', fontSize: '0.71875rem', color: '#4b5563' }}>
                              <div>
                                <strong>ข้อมูลเริ่มต้น (Initial Facts):</strong> ref_type: "{h.after_state?.reference_type || '-'}", ref_text: "{h.after_state?.reference_text || '-'}", desc: "{h.after_state?.description || '-'}", acq: {h.after_state?.acquisition_id || '-'}
                              </div>
                            </div>
                          )}

                          {h.link_deltas && (
                            <div style={{ marginTop: '0.25rem', fontSize: '0.71875rem', color: '#2563eb' }}>
                              {h.link_deltas.added_asset_ids?.length > 0 && (
                                <div>+ เพิ่มสินทรัพย์: {h.link_deltas.added_asset_ids.join(', ')}</div>
                              )}
                              {h.link_deltas.removed_asset_ids?.length > 0 && (
                                <div>- ถอดสินทรัพย์: {h.link_deltas.removed_asset_ids.join(', ')}</div>
                              )}
                              {h.link_deltas.previous_acquisition_id !== h.link_deltas.new_acquisition_id && (
                                <div>
                                  เปลี่ยนการได้มา: {h.link_deltas.previous_acquisition_id || 'null'} → {h.link_deltas.new_acquisition_id || 'null'}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ))}

                      {hasMoreHistory && (
                        <button
                          data-testid="load-more-history-btn"
                          onClick={() => fetchHistory(item.id, historyOffset + 25, true)}
                          disabled={isLoadingHistory}
                          style={{
                            padding: '0.375rem 0.75rem',
                            fontSize: '0.75rem',
                            backgroundColor: '#ffffff',
                            color: '#4b5563',
                            border: '1px solid #d1d5db',
                            borderRadius: '4px',
                            cursor: 'pointer',
                          }}
                        >
                          {isLoadingHistory ? 'กำลังโหลด...' : 'โหลดประวัติเพิ่มเติม...'}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}

          {/* Pagination Controls for Evidence List (F6) */}
          {hasMoreEvidence && (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: '1rem' }}>
              <button
                data-testid="load-more-evidence-btn"
                onClick={() => fetchEvidence(evidenceOffset + 25, true)}
                disabled={isLoading}
                style={{
                  padding: '0.5rem 1rem',
                  fontSize: '0.875rem',
                  backgroundColor: '#ffffff',
                  color: '#2563eb',
                  border: '1px solid #2563eb',
                  borderRadius: '4px',
                  fontWeight: 500,
                  cursor: 'pointer',
                }}
              >
                {isLoading ? 'กำลังโหลด...' : 'โหลดรายการหลักฐานเพิ่มเติม'}
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
};
