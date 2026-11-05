import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { requireCapability } from '../middleware/authorization.ts';
import {
  AssetService,
  DuplicateCandidateWarningError,
  BulkDuplicateCandidateWarningError,
  NotFoundError,
  RetryTokenConflictError,
  StaleBeforeConflictError,
  ValidationError,
  type CorrectAssetInput,
  type RegisterAssetInput,
  type BulkRegisterAssetInput,
} from '../services/asset.service.ts';
import {
  LEGACY_TEXT_FIELDS,
  REFERENCE_ID_FIELDS,
  namesAssignmentValues,
} from '../services/assignment.service.ts';
import { isValidUuid, CapabilityService } from '../services/capability.service.ts';

export interface AssetRoutesOptions {
  assetService?: AssetService;
  capabilityService?: CapabilityService;
  db?: any;
  publicAppOrigin?: string;
}

// T4 (#25, D7-A): optional reference context, validated in AssetService.
const referenceContextFields = {
  location_id: z.string().nullable().optional(),
  organization_unit_id: z.string().nullable().optional(),
  responsible_person_id: z.string().nullable().optional(),
  legacy_location_text: z.string().nullable().optional(),
  legacy_organization_unit_text: z.string().nullable().optional(),
  legacy_responsible_person_text: z.string().nullable().optional(),
};

// F003-T1 (#51): the Initial Assignment a registration records with those values. A null
// effective_date is "ไม่ทราบ" (unknown).
const initialAssignmentFields = {
  ...referenceContextFields,
  effective_date: z.string().nullable().optional(),
  document_reference: z.string().nullable().optional(),
  remark: z.string().nullable().optional(),
};

// T4 (#25): a correction names the expected-before value of each reference field it changes.
const expectedReferenceContextFields = {
  expected_location_id: z.string().nullable().optional(),
  expected_organization_unit_id: z.string().nullable().optional(),
  expected_responsible_person_id: z.string().nullable().optional(),
  expected_legacy_location_text: z.string().nullable().optional(),
  expected_legacy_organization_unit_text: z.string().nullable().optional(),
  expected_legacy_responsible_person_text: z.string().nullable().optional(),
};

const RegisterAssetSchema = z
  .object({
    name: z.string().nullable().optional(),
    asset_number: z.string().nullable().optional(),
    serial_number: z.string().nullable().optional(),
    source_reference: z.string().nullable().optional(),
    source_notes: z.string().nullable().optional(),
    is_legacy: z.boolean().optional(),
    explicit_continuation: z.boolean().optional(),
    retry_token: z.string().optional(),
    category: z.null().optional(),
    acquisition_id: z.string().nullable().optional(),
    ...initialAssignmentFields,
  })
  .strict();

const BulkRegisterItemSchema = z
  .object({
    item_key: z.string().uuid(),
    name: z.string().nullable().optional(),
    asset_number: z.string().nullable().optional(),
    serial_number: z.string().nullable().optional(),
    source_reference: z.string().nullable().optional(),
    source_notes: z.string().nullable().optional(),
    is_legacy: z.boolean().optional(),
    category: z.null().optional(),
  })
  .strict();

const BulkRegisterAssetSchema = z
  .object({
    acquisition_id: z.string().nullable().optional(),
    explicit_continuation: z.boolean().optional(),
    items: z.array(BulkRegisterItemSchema).min(1).max(100),
    retry_token: z.string().optional(),
    ...initialAssignmentFields,
  })
  .strict();

const CorrectAssetSchema = z
  .object({
    name: z.string().nullable().optional(),
    asset_number: z.string().nullable().optional(),
    serial_number: z.string().nullable().optional(),
    expected_name: z.string().nullable(),
    expected_asset_number: z.string().nullable(),
    expected_serial_number: z.string().nullable(),
    reason: z.string().nullable().optional(),
    explicit_continuation: z.boolean().optional(),
    retry_token: z.string().optional(),
    ...referenceContextFields,
    ...expectedReferenceContextFields,
  })
  .strict();

const DuplicateCandidatesQuerySchema = z.object({
  asset_number: z.string().optional(),
  serial_number: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const EXACT_UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidExactUuid(val: unknown): val is string {
  return typeof val === 'string' && val.length === 36 && EXACT_UUID_REGEX.test(val);
}

export const assetRoutes: FastifyPluginAsync<AssetRoutesOptions> = async (
  fastify,
  options
) => {
  const capabilityService =
    options.capabilityService ??
    fastify.capabilityService ??
    (options.db ? new CapabilityService({ db: options.db }) : undefined);

  const assetService =
    options.assetService ??
    new AssetService({ db: options.db });

  // F003 Q3: dimension values at registration record an Initial Assignment, which needs
  // 'assignment:reassign' besides the registration capability. Fails closed without a service.
  const sendUnlessMayAssign = async (
    userId: string,
    body: RegisterAssetInput | BulkRegisterAssetInput,
    reply: FastifyReply
  ): Promise<FastifyReply | null> => {
    if (!namesAssignmentValues(body)) {
      return null;
    }
    const canAssign = capabilityService ? await capabilityService.hasCapability(userId, 'assignment:reassign') : false;
    if (canAssign) {
      return null;
    }
    return reply.status(403).send({
      statusCode: 403,
      code: 'FORBIDDEN',
      error: 'FORBIDDEN',
      message: "Forbidden: requires 'assignment:reassign' capability to record an Initial Assignment",
    });
  };

  const getPublicAppOrigin = (): string | undefined => {
    return (fastify as any).publicAppOrigin ?? options.publicAppOrigin;
  };

  const isSearchRequest = (request: FastifyRequest): boolean => {
    if ((request as any).isSearchRoute) {
      return true;
    }
    const routerPath = request.routeOptions?.url || (request as any).routerPath;
    if (routerPath === '/assets/search' || routerPath === '/search') {
      return true;
    }
    const rawUrl = (request as any).originalRawUrl || request.raw?.url || request.url || '';
    const cleanPath = rawUrl.split('?')[0];
    return cleanPath === '/assets/search' || cleanPath === '/search';
  };

  const isQrLabelRequest = (request: FastifyRequest): boolean => {
    if ((request as any).isQrLabelRoute) {
      return true;
    }
    const routerPath = request.routeOptions?.url || (request as any).routerPath;
    if (routerPath?.replace(/\/$/, '').endsWith('/qr-label')) {
      return true;
    }
    const rawUrl = (request as any).originalRawUrl || request.raw?.url || request.url || '';
    const cleanPath = rawUrl.split('?')[0].replace(/\/$/, '');
    return cleanPath.endsWith('/qr-label');
  };

  // Search-specific and QR-specific response policy (IR-F3, T8):
  // Establish no-store Cache-Control covering 200, 400, 401, 403, 404, 5xx, early denials and pre-handler failures.
  // Also redact query-bearing URLs from raw.url to prevent disclosure in operational logs for search.
  fastify.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const rawUrl = request.raw?.url || '';
    (request as any).rawUrlLength = rawUrl.length;
    (request as any).originalRawUrl = rawUrl;
    const cleanPath = rawUrl.split('?')[0];
    if (cleanPath === '/assets/search' || cleanPath === '/search') {
      (request as any).isSearchRoute = true;
      reply.header('Cache-Control', 'no-store');
      if (request.raw) {
        request.raw.url = cleanPath;
      }
    }
    const normalizedPath = cleanPath.replace(/\/$/, '');
    if (normalizedPath.endsWith('/qr-label')) {
      (request as any).isQrLabelRoute = true;
      reply.header('Cache-Control', 'no-store');
    }
    if (normalizedPath === '/assets/bulk-register' || normalizedPath === '/bulk-register') {
      (request as any).isBulkRegisterRoute = true;
      reply.header('Cache-Control', 'no-store');
    }
  });

  fastify.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    if (
      isSearchRequest(request) ||
      isQrLabelRequest(request) ||
      (request as any).isBulkRegisterRoute ||
      request.routeOptions?.url === '/bulk-register' ||
      request.routeOptions?.url === '/assets/bulk-register'
    ) {
      reply.header('Cache-Control', 'no-store');
    }
    return payload;
  });

  /**
   * GET /duplicate-candidates
   * Lookup candidate duplicate assets by exact nonempty asset_number or serial_number (D2, AR-11)
   * Protected: requires 'asset:duplicate-check' capability (Asset Custodian only)
   */
  fastify.get(
    '/duplicate-candidates',
    {
      preHandler: [requireCapability('asset:duplicate-check')],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsedQuery = DuplicateCandidatesQuerySchema.safeParse(
        request.query || {}
      );
      if (!parsedQuery.success) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'VALIDATION_FAILED',
          error: 'VALIDATION_FAILED',
          message:
            'Invalid query parameters: ' +
            parsedQuery.error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join(', '),
        });
      }

      const { asset_number, serial_number, limit, offset } = parsedQuery.data;
      const result = await assetService.getDuplicateCandidates(
        asset_number,
        serial_number,
        undefined,
        limit,
        offset
      );
      return reply.status(200).send(result);
    }
  );

  /**
   * POST /
   * Register a single truthful or incomplete-legacy Asset with durable starting history (AR-01, AR-07, R1-R4)
   * Supports retry token idempotency contract (D4) and duplicate warning/continuation (D2)
   * Protected: requires 'asset:register' capability (Asset Custodian only)
   */
  fastify.post(
    '/',
    {
      preHandler: [requireCapability('asset:register')],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = (request as any).user;
      if (!user || !user.id) {
        return reply.status(401).send({
          statusCode: 401,
          code: 'UNAUTHORIZED',
          message: 'Authenticated session required',
        });
      }

      // Server boundary validation (Standards Finding 1)
      const parsed = RegisterAssetSchema.safeParse(request.body || {});
      if (!parsed.success) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'VALIDATION_FAILED',
          error: 'VALIDATION_FAILED',
          message:
            'Invalid request payload: ' +
            parsed.error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join(', '),
        });
      }

      const body = parsed.data as RegisterAssetInput & { retry_token?: string };
      const retryToken =
        (request.headers['x-retry-token'] as string) || body.retry_token;

      if (body.acquisition_id !== undefined && body.acquisition_id !== null) {
        const canViewAcq = capabilityService
          ? await capabilityService.hasCapability(user.id, 'acquisition:view')
          : false;
        if (!canViewAcq) {
          return reply.status(403).send({
            statusCode: 403,
            code: 'FORBIDDEN',
            error: 'FORBIDDEN',
            message: "Forbidden: requires 'acquisition:view' capability to link an acquisition",
          });
        }
      }

      const assignDenied = await sendUnlessMayAssign(user.id, body, reply);
      if (assignDenied) {
        return assignDenied;
      }

      try {
        const result = await assetService.registerAsset(user.id, body, {
          retryToken,
        });
        return reply.status(201).send(result);
      } catch (err: any) {
        if (err instanceof DuplicateCandidateWarningError) {
          return reply.status(409).send({
            statusCode: 409,
            code: 'DUPLICATE_CANDIDATES_FOUND',
            error: 'DUPLICATE_CANDIDATES_FOUND',
            message: err.message,
            candidates: err.candidates,
            total_count: err.total_count,
            has_more: err.has_more,
            limit: err.limit,
            offset: err.offset,
          });
        }

        if (err instanceof RetryTokenConflictError) {
          return reply.status(409).send({
            statusCode: 409,
            code: 'RETRY_TOKEN_PAYLOAD_MISMATCH',
            error: 'RETRY_TOKEN_PAYLOAD_MISMATCH',
            message: err.message,
          });
        }

        if (err instanceof ValidationError) {
          return reply.status(400).send({
            statusCode: 400,
            code: 'VALIDATION_FAILED',
            error: 'VALIDATION_FAILED',
            message: err.message,
          });
        }

        throw err;
      }
    }
  );

  /**
   * POST /bulk-register
   * Atomic, retry-safe bulk registration of 1 to 100 assets from an optional shared acquisition reference.
   * Protected: requires BOTH 'asset:bulk-register' AND 'asset:register' capabilities.
   * If acquisition_id is provided, also requires 'acquisition:view' capability.
   * Protected duplicate disclosure requires 'asset:view' AND 'asset:duplicate-check'.
   * Enforces 1 MiB body limit, Cache-Control: no-store, and required x-retry-token header.
   */
  fastify.post(
    '/bulk-register',
    {
      bodyLimit: 1048576,
      onRequest: async (_request: FastifyRequest, reply: FastifyReply) => {
        reply.header('Cache-Control', 'no-store');
      },
      preHandler: [
        requireCapability('asset:bulk-register'),
        requireCapability('asset:register'),
      ],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header('Cache-Control', 'no-store');
      const user = (request as any).user;
      if (!user || !user.id) {
        return reply.status(401).send({
          statusCode: 401,
          code: 'UNAUTHORIZED',
          error: 'UNAUTHORIZED',
          message: 'Authenticated session required',
        });
      }

      // 1. Validate x-retry-token header
      const headerToken = request.headers['x-retry-token'];
      if (
        typeof headerToken !== 'string' ||
        headerToken.trim() === '' ||
        headerToken.length > 128
      ) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'VALIDATION_FAILED',
          error: 'VALIDATION_FAILED',
          message:
            'Non-empty x-retry-token header is required for bulk registration (max 128 characters)',
        });
      }
      const retryToken = headerToken.trim();

      // 2. Validate payload schema
      const parsed = BulkRegisterAssetSchema.safeParse(request.body || {});
      if (!parsed.success) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'VALIDATION_FAILED',
          error: 'VALIDATION_FAILED',
          message:
            'Invalid request payload: ' +
            parsed.error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join(', '),
        });
      }

      const body = parsed.data as BulkRegisterAssetInput & { retry_token?: string };

      // Contradictory token check (checked by presence, including empty string)
      if (body.retry_token !== undefined && body.retry_token !== retryToken) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'VALIDATION_FAILED',
          error: 'VALIDATION_FAILED',
          message: 'x-retry-token header and body retry_token must match',
        });
      }

      // 3. Acquisition link capability check
      if (body.acquisition_id !== undefined && body.acquisition_id !== null) {
        const canViewAcq = capabilityService
          ? await capabilityService.hasCapability(user.id, 'acquisition:view')
          : false;
        if (!canViewAcq) {
          return reply.status(403).send({
            statusCode: 403,
            code: 'FORBIDDEN',
            error: 'FORBIDDEN',
            message:
              "Forbidden: requires 'acquisition:view' capability to link an acquisition",
          });
        }
      }

      const assignDenied = await sendUnlessMayAssign(user.id, body, reply);
      if (assignDenied) {
        return assignDenied;
      }

      try {
        const result = await assetService.bulkRegisterAssets(user.id, body, {
          retryToken,
        });
        return reply.status(201).send(result);
      } catch (err: any) {
        if (err instanceof BulkDuplicateCandidateWarningError) {
          // Protected duplicate candidate disclosure check (D3)
          const canView = capabilityService
            ? await capabilityService.hasCapability(user.id, 'asset:view')
            : true;
          const canCheck = capabilityService
            ? await capabilityService.hasCapability(user.id, 'asset:duplicate-check')
            : true;

          const sanitizedWarnings = (canView && canCheck)
            ? err.warnings
            : err.warnings.map(({ candidates, ...w }) => ({
                ...w,
                candidates: [],
              }));

          return reply.status(409).send({
            statusCode: 409,
            code: 'DUPLICATE_CANDIDATES_FOUND',
            error: 'DUPLICATE_CANDIDATES_FOUND',
            message: err.message,
            warnings: sanitizedWarnings,
          });
        }

        if (err instanceof RetryTokenConflictError) {
          return reply.status(409).send({
            statusCode: 409,
            code: 'RETRY_TOKEN_PAYLOAD_MISMATCH',
            error: 'RETRY_TOKEN_PAYLOAD_MISMATCH',
            message: err.message,
          });
        }

        if (err instanceof ValidationError) {
          return reply.status(400).send({
            statusCode: 400,
            code: 'VALIDATION_FAILED',
            error: 'VALIDATION_FAILED',
            message: err.message,
          });
        }

        throw err;
      }
    }
  );

  /**
   * GET /search
   * Bounded identifier/description search (T3).
   * Supports field-based exact matching for stable_id, asset_number, serial_number,
   * case-insensitive literal substring for name, or empty browse when no criteria given.
   * T4 (#25): each legacy reference text is a field searched like name, and
   * location_id / organization_unit_id / responsible_person_id filter by exact entry, with AND.
   * Requires BOTH 'asset:search' and 'asset:view' capabilities.
   * Prevents query disclosure in operational logs via sanitized URLs and logLevel 'silent'.
   */
  fastify.get(
    '/search',
    {
      logLevel: 'silent',
      preHandler: [
        requireCapability('asset:search'),
        requireCapability('asset:view'),
      ],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      // Set Cache-Control header strictly
      reply.header('Cache-Control', 'no-store');

      const requestId =
        (request.headers['x-request-id'] as string) ||
        request.id ||
        (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : 'req-default-id');

      const sendValidationError = (details: Record<string, string>) => {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'The provided request data is invalid.',
            request_id: requestId,
            details,
          },
        });
      };

      // Raw target bound: 16384 bytes
      const rawUrlLength = (request as any).rawUrlLength || request.raw.url?.length || 0;
      if (rawUrlLength > 16384) {
        return sendValidationError({ target: 'Request target URL exceeds maximum length' });
      }

      const query = (request.query || {}) as Record<string, unknown>;

      // Check for unknown parameters
      const allowedParams = new Set<string>(['field', 'value', 'limit', 'offset', ...REFERENCE_ID_FIELDS]);
      for (const key of Object.keys(query)) {
        if (!allowedParams.has(key)) {
          return sendValidationError({ query: 'Unknown query parameter' });
        }
      }

      // Check for duplicate parameters (arrays in Fastify parsed query)
      for (const key of Object.keys(query)) {
        if (Array.isArray(query[key])) {
          return sendValidationError({ query: 'Duplicate parameter not allowed' });
        }
      }

      const { field, value, limit, offset } = query;

      // Type checks: field and value must be strings if present
      if (field !== undefined && typeof field !== 'string') {
        return sendValidationError({ field: 'Field must be a string' });
      }
      if (value !== undefined && typeof value !== 'string') {
        return sendValidationError({ value: 'Value must be a string' });
      }

      // Valid selector check
      const validFields = new Set<string>(['stable_id', 'asset_number', 'serial_number', 'name', ...LEGACY_TEXT_FIELDS]);
      if (field !== undefined && !validFields.has(field)) {
        return sendValidationError({ field: 'Invalid search field selector' });
      }

      // Complete selector check: if field is given, value must be given; if value is given, field must be given
      if (field !== undefined && value === undefined) {
        return sendValidationError({ value: 'Value is required when field is specified' });
      }
      if (value !== undefined && field === undefined) {
        return sendValidationError({ field: 'Field is required when value is specified' });
      }

      // Field specific validations
      if (field !== undefined && value !== undefined) {
        // NUL byte check
        if (value.includes('\0')) {
          return sendValidationError({ value: 'Value must not contain NUL bytes' });
        }
        // Max UTF-8 byte length 4096
        if (Buffer.byteLength(value, 'utf8') > 4096) {
          return sendValidationError({ value: 'Value exceeds maximum length of 4096 bytes' });
        }

        if (field === 'stable_id' && value !== '') {
          if (!isValidExactUuid(value)) {
            return sendValidationError({ value: 'Invalid UUID format for stable_id' });
          }
        } else if ((field === 'name' || (LEGACY_TEXT_FIELDS as readonly string[]).includes(field)) && value !== '') {
          if (value.trim() === '') {
            return sendValidationError({ value: `Search value for ${field} must not be whitespace-only` });
          }
        }
      }

      for (const filter of REFERENCE_ID_FIELDS) {
        if (query[filter] !== undefined && !isValidExactUuid(query[filter])) {
          return sendValidationError({ [filter]: `${filter} must be a valid UUID` });
        }
      }

      // Limit validation
      if (limit !== undefined) {
        if (typeof limit !== 'string' && typeof limit !== 'number') {
          return sendValidationError({ limit: 'Invalid limit format' });
        }
        const limitStr = String(limit);
        if (!/^[1-9]\d*$/.test(limitStr)) {
          return sendValidationError({ limit: 'Limit must be a canonical positive integer' });
        }
        const parsedLimit = Number(limitStr);
        if (parsedLimit < 1 || parsedLimit > 100) {
          return sendValidationError({ limit: 'Limit must be between 1 and 100' });
        }
      }

      // Offset validation
      if (offset !== undefined) {
        if (typeof offset !== 'string' && typeof offset !== 'number') {
          return sendValidationError({ offset: 'Invalid offset format' });
        }
        const offsetStr = String(offset);
        if (!/^(0|[1-9]\d*)$/.test(offsetStr)) {
          return sendValidationError({ offset: 'Offset must be a canonical non-negative integer' });
        }
        const parsedOffset = Number(offsetStr);
        if (parsedOffset < 0 || parsedOffset > 2147483647) {
          return sendValidationError({ offset: 'Offset must be between 0 and 2147483647' });
        }
      }

      try {
        const result = await assetService.searchAssets({
          field: field as any,
          value: value as string | undefined,
          location_id: query.location_id as string | undefined,
          organization_unit_id: query.organization_unit_id as string | undefined,
          responsible_person_id: query.responsible_person_id as string | undefined,
          limit: limit as any,
          offset: offset as any,
        });

        return reply.status(200).send(result);
      } catch (err: any) {
        if (err instanceof ValidationError) {
          return sendValidationError({ query: err.message });
        }
        throw err;
      }
    }
  );

  /**
   * GET /:id
   * Retrieve Asset identity, details and starting history fact by Stable ID UUID (AR-02, AR-07, AC-25)
   * Office-wide visibility (R4): accessible to all authorized registry roles without organization segregation
   * Protected: requires 'asset:view' capability (Asset Custodian, Administrator, Read-only User)
   */
  fastify.get(
    '/:id',
    {
      preHandler: [requireCapability('asset:view')],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = (request.params || {}) as { id: string };

      if (!isValidUuid(id)) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'INVALID_ID',
          error: 'INVALID_ID',
          message: 'Asset ID must be a valid UUID string',
        });
      }

      const result = await assetService.getAssetById(id);
      if (!result) {
        return reply.status(404).send({
          statusCode: 404,
          code: 'NOT_FOUND',
          error: 'NOT_FOUND',
          message: 'Asset not found',
        });
      }

      let canCorrect = false;
      let canViewAcquisition = false;
      if (request.user && capabilityService) {
        canCorrect = await capabilityService.hasCapability(request.user.id, 'asset:correct');
        canViewAcquisition = await capabilityService.hasCapability(request.user.id, 'acquisition:view');
      }

      // Disclose acquisition linkage only if user has 'acquisition:view'
      if (!canViewAcquisition && result.asset) {
        result.asset.acquisition_id = null;
        if (result.history) {
          result.history = result.history.map((h: any) => {
            if (h.payload && typeof h.payload === 'object' && 'acquisition_id' in h.payload) {
              const { acquisition_id, ...restPayload } = h.payload;
              return { ...h, payload: restPayload };
            }
            return h;
          });
        }
      }

      return reply.status(200).send({
        ...result,
        can_correct: canCorrect,
      });
    }
  );

  /**
   * GET /:id/assignments
   * The Asset's assignment timeline (F003-T1, AS-06, MR-04): every assignment fact in the order of
   * facts, each with its kind, Effective Date or unknown, Recorded At, recorder, provenance, changes,
   * document reference and remark.
   * Protected: requires 'asset:view' capability, like the Asset itself
   */
  fastify.get(
    '/:id/assignments',
    {
      preHandler: [requireCapability('asset:view')],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = (request.params || {}) as { id: string };

      if (!isValidUuid(id)) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'INVALID_ID',
          error: 'INVALID_ID',
          message: 'Asset ID must be a valid UUID string',
        });
      }

      const items = await assetService.getAssignmentTimeline(id);
      if (!items) {
        return reply.status(404).send({
          statusCode: 404,
          code: 'NOT_FOUND',
          error: 'NOT_FOUND',
          message: 'Asset not found',
        });
      }

      return reply.status(200).send({ items });
    }
  );

  /**
   * GET /:id/qr-label
   * Retrieve single-asset QR label payload and locator URL (T8, AR-02, AR-07)
   * Office-wide visibility: accessible to all authorized registry roles with 'asset:view'
   * Protected: requires 'asset:view' capability (Asset Custodian, Administrator, Read-only User)
   * Enforces Cache-Control: no-store on 200, 400, 401, 403, 404, 500, 503
   */
  fastify.get(
    '/:id/qr-label',
    {
      preHandler: [requireCapability('asset:view')],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header('Cache-Control', 'no-store');

      const { id } = (request.params || {}) as { id: string };

      if (!isValidExactUuid(id)) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'INVALID_ID',
          error: 'INVALID_ID',
          message: 'Asset ID must be a valid UUID string',
        });
      }

      const canonicalId = id.toLowerCase();

      const currentPublicAppOrigin = getPublicAppOrigin();

      if (!currentPublicAppOrigin) {
        return reply.status(503).send({
          statusCode: 503,
          code: 'SERVICE_UNAVAILABLE',
          error: 'SERVICE_UNAVAILABLE',
          message: 'Public application origin is not configured',
        });
      }

      const result = await assetService.getAssetById(canonicalId);
      if (!result) {
        return reply.status(404).send({
          statusCode: 404,
          code: 'NOT_FOUND',
          error: 'NOT_FOUND',
          message: 'Asset not found',
        });
      }

      const responseId = result.asset.id.toLowerCase();

      return reply.status(200).send({
        id: responseId,
        locator: `${currentPublicAppOrigin}/assets/${responseId}`,
        name: result.asset.name,
        asset_number: result.asset.asset_number,
        serial_number: result.asset.serial_number,
      });
    }
  );

  /**
   * GET /:id/duplicate-candidates
   * Correction-scoped preview for candidate duplicate assets excluding the current asset itself (P1)
   * Protected: requires 'asset:correct' capability (Administrator, Asset Custodian)
   */
  fastify.get(
    '/:id/duplicate-candidates',
    {
      preHandler: [requireCapability('asset:correct')],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = (request.params || {}) as { id: string };
      if (!isValidUuid(id)) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'INVALID_ID',
          error: 'INVALID_ID',
          message: 'Asset ID must be a valid UUID string',
        });
      }

      const parsedQuery = DuplicateCandidatesQuerySchema.safeParse(
        request.query || {}
      );
      if (!parsedQuery.success) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'VALIDATION_FAILED',
          error: 'VALIDATION_FAILED',
          message:
            'Invalid query parameters: ' +
            parsedQuery.error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join(', '),
        });
      }

      const { asset_number, serial_number, limit, offset } = parsedQuery.data;
      const result = await assetService.getDuplicateCandidates(
        asset_number,
        serial_number,
        undefined,
        limit,
        offset,
        id
      );
      return reply.status(200).send(result);
    }
  );

  const correctAssetHandler = async (
    request: FastifyRequest,
    reply: FastifyReply
  ) => {
    const user = (request as any).user;
    if (!user || !user.id) {
      return reply.status(401).send({
        statusCode: 401,
        code: 'UNAUTHORIZED',
        message: 'Authenticated session required',
      });
    }

    const { id } = (request.params || {}) as { id: string };
    if (!isValidUuid(id)) {
      return reply.status(400).send({
        statusCode: 400,
        code: 'INVALID_ID',
        error: 'INVALID_ID',
        message: 'Asset ID must be a valid UUID string',
      });
    }

    // Boundary check: conflicting retry token header and body rejected
    const headerToken = (
      (request.headers['idempotency-key'] ||
        request.headers['x-retry-token']) as string | undefined
    )?.trim();
    const bodyObj = (request.body || {}) as Record<string, unknown>;
    const bodyToken =
      typeof bodyObj.retry_token === 'string'
        ? bodyObj.retry_token.trim()
        : undefined;

    if (headerToken && bodyToken && headerToken !== bodyToken) {
      return reply.status(400).send({
        statusCode: 400,
        code: 'VALIDATION_FAILED',
        error: 'VALIDATION_FAILED',
        message: 'Conflicting retry token values between header and body',
      });
    }

    const retryToken = headerToken || bodyToken;
    if (!retryToken || retryToken.length === 0) {
      return reply.status(400).send({
        statusCode: 400,
        code: 'VALIDATION_FAILED',
        error: 'VALIDATION_FAILED',
        message: 'Correction retry token is required and must be a nonblank string',
      });
    }

    // Server boundary validation
    const parsed = CorrectAssetSchema.safeParse(request.body || {});
    if (!parsed.success) {
      return reply.status(400).send({
        statusCode: 400,
        code: 'VALIDATION_FAILED',
        error: 'VALIDATION_FAILED',
        message:
          'Invalid request payload: ' +
          parsed.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join(', '),
      });
    }

    const body = parsed.data as CorrectAssetInput;

    try {
      const result = await assetService.correctAsset(user.id, id, body, {
        retryToken,
      });
      return reply.status(200).send(result);
    } catch (err: any) {
      if (err instanceof DuplicateCandidateWarningError) {
        return reply.status(409).send({
          statusCode: 409,
          code: 'DUPLICATE_CANDIDATES_FOUND',
          error: 'DUPLICATE_CANDIDATES_FOUND',
          message: err.message,
          candidates: err.candidates,
          total_count: err.total_count,
          has_more: err.has_more,
          limit: err.limit,
          offset: err.offset,
        });
      }

      if (err instanceof RetryTokenConflictError) {
        return reply.status(409).send({
          statusCode: 409,
          code: 'RETRY_TOKEN_PAYLOAD_MISMATCH',
          error: 'RETRY_TOKEN_PAYLOAD_MISMATCH',
          message: err.message,
        });
      }

      if (err instanceof StaleBeforeConflictError) {
        return reply.status(409).send({
          statusCode: 409,
          code: 'STALE_BEFORE_CONFLICT',
          error: 'STALE_BEFORE_CONFLICT',
          message: err.message,
          current_values: err.current_values,
          expected_values: err.expected_values,
        });
      }

      if (err instanceof NotFoundError) {
        return reply.status(404).send({
          statusCode: 404,
          code: 'NOT_FOUND',
          error: 'NOT_FOUND',
          message: err.message,
        });
      }

      if (err instanceof ValidationError) {
        return reply.status(400).send({
          statusCode: 400,
          code: 'VALIDATION_FAILED',
          error: 'VALIDATION_FAILED',
          message: err.message,
        });
      }

      throw err;
    }
  };

  /**
   * POST /:id/correct
   * Correct metadata on an existing Asset (P1–P3)
   * Protected: requires 'asset:correct' capability (Administrator, Asset Custodian)
   */
  fastify.post(
    '/:id/correct',
    {
      preHandler: [requireCapability('asset:correct')],
    },
    correctAssetHandler
  );

  /**
   * PATCH /:id
   * RESTful partial update / correction on an existing Asset (P1–P3)
   * Protected: requires 'asset:correct' capability (Administrator, Asset Custodian)
   */
  fastify.patch(
    '/:id',
    {
      preHandler: [requireCapability('asset:correct')],
    },
    correctAssetHandler
  );
};

export default assetRoutes;
