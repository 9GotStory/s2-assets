import pg from 'pg';

// F007-T1 (#155): how an Asset left use (#154 Q2). The code names avoid every term GLOSSARY.md avoids.
export const RETIREMENT_METHODS = ['SALE', 'EXCHANGE', 'HANDOVER_TO_OTHER_AGENCY', 'CONVERSION_OR_DESTRUCTION', 'DECLARED_LOSS'] as const;
export type RetirementMethod = (typeof RETIREMENT_METHODS)[number];

// A Retirement as the Asset page shows it, its Retirement Date apart from its Recorded At (DR-05).
export interface Retirement {
  id: string;
  retirement_date: string;
  retirement_method: RetirementMethod;
  retirement_reference: string | null;
  note: string | null;
  recorded_by: string;
  recorded_by_username: string | null;
  recorded_at: string;
  is_voided: boolean;
  version: number;
}

// What the Asset page reads of an Asset's Retirements: whether it is Retired, by which one, and every one,
// voided ones included (#154 P3).
export interface AssetRetirements {
  retired: boolean;
  retirement: Retirement | null;
  retirements: Retirement[];
}

// Retired, for a Retirement row aliased `t`: it is not voided (DR-07, #154 Q1). Every read and write of
// Retired uses this one condition.
const IS_CURRENT = 'NOT t.is_voided';

const RETIREMENT_COLUMNS = `t.id, t.asset_id, to_char(t.retirement_date, 'YYYY-MM-DD') AS retirement_date, t.retirement_method,
       t.retirement_reference, t.note, t.recorded_by, u.username AS recorded_by_username, t.recorded_at, t.is_voided, t.version`;

const retirementOf = (row: any): Retirement => ({
  id: row.id,
  retirement_date: row.retirement_date,
  retirement_method: row.retirement_method,
  retirement_reference: row.retirement_reference,
  note: row.note,
  recorded_by: row.recorded_by,
  recorded_by_username: row.recorded_by_username,
  recorded_at: new Date(row.recorded_at).toISOString(),
  is_voided: row.is_voided,
  version: row.version,
});

/** The Retirement not voided of each of `assetIds` that is Retired. A write reads it under the Asset's lock. */
export async function currentRetirementsOf(db: pg.Pool | pg.PoolClient | any, assetIds: string[]): Promise<Map<string, Retirement>> {
  const res = await db.query(
    `SELECT ${RETIREMENT_COLUMNS}
     FROM retirements t
     LEFT JOIN users u ON u.id = t.recorded_by
     WHERE t.asset_id = ANY($1::uuid[]) AND ${IS_CURRENT}`,
    [assetIds]
  );
  return new Map(res.rows.map((row: any): [string, Retirement] => [row.asset_id, retirementOf(row)]));
}

// What a row of the Asset search says of Retirements (F007-T1, #154 Q10): whether the Asset is Retired.
export interface AssetSearchRetirementFacts {
  retired: boolean;
}

/**
 * The Asset search's view of Retirements, as `repairSearch` is its view of Repair Records: the filters for a
 * row aliased `a`, and what each result row says.
 */
export const retirementSearch = {
  retiredFilter: `EXISTS (SELECT 1 FROM retirements t WHERE t.asset_id = a.id AND ${IS_CURRENT})`,
  notRetiredFilter: `NOT EXISTS (SELECT 1 FROM retirements t WHERE t.asset_id = a.id AND ${IS_CURRENT})`,
  factsOf: async (db: pg.Pool | any, assetIds: string[]): Promise<(assetId: string) => AssetSearchRetirementFacts> => {
    const current = await currentRetirementsOf(db, assetIds);
    return (assetId) => ({ retired: current.has(assetId) });
  },
};

/** F007-T1 (#155): the reads of Retirements. The writes are in retirement.service.ts. */
export class RetirementReadService {
  private readonly db: pg.Pool | any;

  constructor(options: { db: pg.Pool | any }) {
    this.db = options.db;
  }

  /** Whether the Asset is Retired, its current Retirement, and every Retirement of it, oldest first. */
  async ofAsset(assetId: string): Promise<AssetRetirements> {
    const res = await this.db.query(
      `SELECT ${RETIREMENT_COLUMNS}, ${IS_CURRENT} AS is_current
       FROM retirements t
       LEFT JOIN users u ON u.id = t.recorded_by
       WHERE t.asset_id = $1
       ORDER BY t.recorded_at, t.id`,
      [assetId]
    );
    const retirements = res.rows.map(retirementOf);
    const current = res.rows.find((row: any) => row.is_current);
    const retirement = current ? retirementOf(current) : null;
    return { retired: retirement !== null, retirement, retirements };
  }
}
