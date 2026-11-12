/**
 * @file Capability Service (T024 - User Story 2)
 *
 * Implements code-defined, immutable capability mapping and dynamic, server-side
 * authorization evaluation against authoritative PostgreSQL state.
 *
 * Capabilities (e.g. 'system:maintain') are intentionally defined in application code,
 * NOT persisted in the database, avoiding unnecessary enterprise RBAC complexity.
 * Evaluates active roles per evaluation without caching in session, globals, or instances.
 */

export const KNOWN_ROLES = [
  'SYSTEM_MAINTAINER',
  'ADMINISTRATOR',
  'READ_ONLY',
  'ASSET_CUSTODIAN',
] as const;

export type Role = (typeof KNOWN_ROLES)[number];

export const KNOWN_CAPABILITIES = [
  'system:maintain',
  'asset:view',
  'asset:duplicate-check',
  'asset:register',
  'asset:bulk-register',
  'asset:correct',
  'asset:search',
  'acquisition:create',
  'acquisition:view',
  'evidence:view',
  'evidence:create',
  'evidence:correct',
  'reference:maintain',
  'assignment:reassign',
  'assignment:correct',
  'loan:record',
  'loan:correct',
  'repair:record',
  'repair:correct',
] as const;

export type Capability = (typeof KNOWN_CAPABILITIES)[number];

/**
 * Immutable role-to-capability mapping (Feature 002 T1–T7, Features 003 to 005 approved matrix).
 *
 * - SYSTEM_MAINTAINER: grants 'system:maintain' (preserves foundation maintenance grant)
 * - ADMINISTRATOR: grants 'system:maintain', 'asset:view', 'asset:correct', 'asset:search', 'acquisition:view', 'evidence:view', 'evidence:correct', 'reference:maintain', 'assignment:correct' (#50 Q3: Assignment Correction), 'loan:correct' (#74 Q12: Loan Correction), 'repair:correct' (#98 Q2: Repair Correction)
 * - READ_ONLY: grants 'asset:view', 'asset:search', 'acquisition:view', 'evidence:view' (view and search for registry, acquisitions & evidence)
 * - ASSET_CUSTODIAN: grants 'asset:view', 'asset:duplicate-check', 'asset:register', 'asset:bulk-register', 'asset:correct', 'asset:search', 'acquisition:create', 'acquisition:view', 'evidence:view', 'evidence:create', 'evidence:correct', 'assignment:reassign', 'assignment:correct' (#50 Q3: Initial Assignment, Reassignment and Assignment Correction), 'loan:record' (#74 Q12: starting a Loan), 'loan:correct' (#74 Q12: Loan Correction), 'repair:record' (#98 Q2: a Repair Start and its Repair Outcome), 'repair:correct' (#98 Q2: Repair Correction)
 * - Unknown roles: empty / unmapped
 */
export const ROLE_CAPABILITY_MAP: Readonly<Record<string, readonly string[]>> = Object.freeze({
  SYSTEM_MAINTAINER: Object.freeze(['system:maintain'] as const),
  ADMINISTRATOR: Object.freeze([
    'system:maintain',
    'asset:view',
    'asset:correct',
    'asset:search',
    'acquisition:view',
    'evidence:view',
    'evidence:correct',
    'reference:maintain',
    'assignment:correct',
    'loan:correct',
    'repair:correct',
  ] as const),
  READ_ONLY: Object.freeze([
    'asset:view',
    'asset:search',
    'acquisition:view',
    'evidence:view',
  ] as const),
  ASSET_CUSTODIAN: Object.freeze([
    'asset:view',
    'asset:duplicate-check',
    'asset:register',
    'asset:bulk-register',
    'asset:correct',
    'asset:search',
    'acquisition:create',
    'acquisition:view',
    'evidence:view',
    'evidence:create',
    'evidence:correct',
    'assignment:reassign',
    'assignment:correct',
    'loan:record',
    'loan:correct',
    'repair:record',
    'repair:correct',
  ] as const),
});

/**
 * Standard UUID regex for validating user identifier format before query execution.
 */
export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates whether the given value is a well-formed UUID string.
 */
export function isValidUuid(id: unknown): id is string {
  if (typeof id !== 'string' || id.trim().length === 0) {
    return false;
  }
  return UUID_REGEX.test(id.trim());
}

/**
 * Validates whether the given capability identifier is recognized in application code.
 */
export function isKnownCapability(capability: unknown): capability is Capability {
  return (
    typeof capability === 'string' &&
    (KNOWN_CAPABILITIES as readonly string[]).includes(capability)
  );
}

export interface DatabaseClient {
  query<R = any>(text: string, params?: unknown[]): Promise<{ rows: R[]; rowCount?: number | null }>;
}

export interface CapabilityServiceOptions {
  db?: DatabaseClient | any;
}

type DatabaseKind = 'pg' | 'kysely';

interface ResolvedDatabaseClient {
  client: any;
  kind: DatabaseKind;
}

/**
 * Service managing dynamic, authoritative capability authorization.
 *
 * Queries PostgreSQL on EVERY evaluation to resolve user active status and current roles.
 * Does NOT cache user roles or capabilities in session, instance state, or globals.
 * Fails closed on any input invalidity, missing user, disabled user, or DB failure.
 */
export class CapabilityService {
  private db?: any;

  constructor(options?: CapabilityServiceOptions | DatabaseClient | any) {
    if (options && typeof options === 'object') {
      if ('query' in options || 'selectFrom' in options) {
        this.db = options;
      } else if ('db' in options && options.db) {
        this.db = options.db;
      }
    }
  }

  static ROLE_CAPABILITY_MAP = ROLE_CAPABILITY_MAP;
  static KNOWN_CAPABILITIES = KNOWN_CAPABILITIES;
  static KNOWN_ROLES = KNOWN_ROLES;
  static isValidUuid = isValidUuid;
  static isKnownCapability = isKnownCapability;

  /**
   * Resolves the underlying database client and determines its interface.
   * Does NOT open a new connection pool or alter externally owned connections.
   */
  private getDatabaseClient(): ResolvedDatabaseClient | null {
    const client = this.db;
    if (!client) {
      return null;
    }

    if (typeof client.query === 'function') {
      return { client, kind: 'pg' };
    }

    if (
      typeof client.selectFrom === 'function' ||
      typeof client.insertInto === 'function' ||
      typeof client.updateTable === 'function' ||
      typeof client.deleteFrom === 'function'
    ) {
      return { client, kind: 'kysely' };
    }

    return null;
  }

  /**
   * Dynamically resolves current active roles assigned to the user directly from PostgreSQL.
   *
   * Queries users, user_roles, and roles on every call:
   * - Missing or malformed userId -> returns []
   * - Nonexistent user -> returns []
   * - Disabled user (is_active !== true) -> returns []
   * - Database outage or query failure -> fails closed, returns []
   *
   * @param userId Valid UUID string of the user
   * @returns Promise<string[]> Array of assigned role IDs (e.g. ['SYSTEM_MAINTAINER'])
   */
  async getUserRoles(userId: string): Promise<string[]> {
    if (!isValidUuid(userId)) {
      return [];
    }

    const resolved = this.getDatabaseClient();
    if (!resolved) {
      return [];
    }

    try {
      let rows: Array<{ user_id?: unknown; is_active?: unknown; role_id?: unknown }> = [];

      if (resolved.kind === 'kysely') {
        rows = await resolved.client
          .selectFrom('users')
          .leftJoin('user_roles', 'users.id', 'user_roles.user_id')
          .leftJoin('roles', 'user_roles.role_id', 'roles.id')
          .select([
            'users.id as user_id',
            'users.is_active as is_active',
            'roles.id as role_id',
          ])
          .where('users.id', '=', userId.trim())
          .execute();
      } else {
        const result = await resolved.client.query(
          `SELECT users.id AS user_id, users.is_active AS is_active, roles.id AS role_id
           FROM users
           LEFT JOIN user_roles ON users.id = user_roles.user_id
           LEFT JOIN roles ON user_roles.role_id = roles.id
           WHERE users.id = $1`,
          [userId.trim()]
        );
        rows = result?.rows || [];
      }

      if (!rows || rows.length === 0) {
        // User does not exist in authoritative users table
        return [];
      }

      // If user is deactivated or disabled, deny all roles and capabilities
      const isActive = rows[0]?.is_active;
      if (isActive !== true) {
        return [];
      }

      const roles: string[] = [];
      for (const row of rows) {
        const roleId = row?.role_id;
        if (typeof roleId === 'string' && roleId.length > 0) {
          if (!roles.includes(roleId)) {
            roles.push(roleId);
          }
        }
      }

      return roles;
    } catch {
      // Database failure must never result in an authorization grant
      return [];
    }
  }

  /**
   * Resolves the active code-defined capabilities for the user based on their current roles.
   * Evaluated dynamically without session or memory caching.
   *
   * @param userId Valid UUID string of the user
   * @returns Promise<string[]> Unique list of granted capabilities
   */
  async getCapabilities(userId: string): Promise<string[]> {
    if (!isValidUuid(userId)) {
      return [];
    }

    const roles = await this.getUserRoles(userId);
    if (!roles || roles.length === 0) {
      return [];
    }

    const capabilities = new Set<string>();
    for (const role of roles) {
      const mappedCaps = ROLE_CAPABILITY_MAP[role];
      if (mappedCaps && Array.isArray(mappedCaps)) {
        for (const cap of mappedCaps) {
          capabilities.add(cap);
        }
      }
    }

    return Array.from(capabilities);
  }

  /**
   * Primary authorization method: evaluates whether a user possesses the requested capability.
   *
   * Evaluates authoritative PostgreSQL state on every invocation.
   * Strictly fails closed: denies (returns false) if:
   * - userId is missing or malformed (non-UUID)
   * - capability is unknown or not supported
   * - user does not exist
   * - user is disabled (is_active !== true)
   * - user does not have a role mapping to this capability
   * - database is disconnected or query fails
   *
   * @param userId Valid UUID string of the user
   * @param capability Capability identifier to check (e.g. 'system:maintain')
   * @returns Promise<boolean> True if explicitly permitted; false otherwise
   */
  async hasCapability(userId: string, capability: string): Promise<boolean> {
    if (!isValidUuid(userId) || !isKnownCapability(capability)) {
      return false;
    }

    try {
      const capabilities = await this.getCapabilities(userId);
      return capabilities.includes(capability);
    } catch {
      return false;
    }
  }
}
