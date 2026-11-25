import React from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { thaiDate } from './assignmentFacts';
import { FiscalYearSelect } from './FiscalYearSelect';
import { BASE_UNIT_LABEL, NO_STOCK_MOVEMENT_LABEL } from './materialFacts';
import { STOCK_MOVEMENT_LABEL } from './openingBalanceFacts';
import { EFFECTIVE_DATE_LABEL, RECORDED_AT_LABEL, RUNNING_BALANCE_LABEL, STOCK_MOVEMENT_KIND_LABELS, STOCK_MOVEMENT_SOURCES, type StockLedger } from './stockMovementFacts';
import { FISCAL_YEAR_LABEL } from './verificationFacts';

const PAGE_SIZE = 25;
const THAI_DATE_TIME = new Intl.DateTimeFormat('th-TH', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Bangkok' });

const sectionHeadingStyle: React.CSSProperties = { fontSize: '1.125rem', fontWeight: 600, color: '#374151', margin: '1.5rem 0 0.75rem 0' };
const cellStyle: React.CSSProperties = { padding: '0.5rem 0.75rem', color: '#111827', verticalAlign: 'top' };
const headStyle: React.CSSProperties = { padding: '0.5rem 0.75rem', fontWeight: 600, color: '#374151', whiteSpace: 'nowrap' };
const pageButtonStyle: React.CSSProperties = { padding: '0.375rem 0.875rem', backgroundColor: '#f3f4f6', color: '#374151', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '0.875rem' };

/**
 * F010-T4 (#235): a Stock Material's รายการเคลื่อนไหว, oldest first, each with the record that made it, the quantity as
 * entered with its Conversion Snapshot, the signed quantity and the balance after it in the Base Unit, and who
 * recorded it when; by ปีงบประมาณ, a page at a time (#231 stories 50–52, Q23; #235 start decisions 2–4). The Fiscal
 * Year and the page live in the URL, so a reload or a link keeps them.
 */
export const StockMovementTable: React.FC<{ stockMaterialId: string }> = ({ stockMaterialId }) => {
  const [params, setParams] = useSearchParams();
  const fiscalYear = params.get('fiscal_year') ?? '';
  const offset = Math.max(0, Number(params.get('offset')) || 0);

  const movements = useQuery<StockLedger, Error & { status?: number }>({
    queryKey: ['stock-movements', stockMaterialId, fiscalYear, offset],
    queryFn: async ({ signal }) => {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
      if (fiscalYear !== '') {
        query.set('fiscal_year', fiscalYear);
      }
      const res = await fetch(`/stock-materials/${encodeURIComponent(stockMaterialId)}/stock-movements?${query}`, { credentials: 'include', signal });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`) as Error & { status?: number };
        err.status = res.status;
        throw err;
      }
      return res.json();
    },
  });

  // A failed read hides what an earlier one showed: a lost grant fails closed.
  const ledger = movements.isError ? undefined : movements.data;

  const goTo = (next: { fiscalYear?: string; offset: number }) => {
    const query = new URLSearchParams();
    const nextYear = next.fiscalYear ?? fiscalYear;
    if (nextYear !== '') {
      query.set('fiscal_year', nextYear);
    }
    if (next.offset) {
      query.set('offset', String(next.offset));
    }
    setParams(query);
  };

  return (
    <section aria-labelledby="stock-movement-heading" id="stock-movement-section">
      <h2 id="stock-movement-heading" style={sectionHeadingStyle}>
        {STOCK_MOVEMENT_LABEL}
      </h2>

      {movements.isError && (
        <div role="alert" id="stock-movement-error" style={{ padding: '0.75rem 1rem', margin: '0 0 1rem 0', borderRadius: '6px', backgroundColor: '#fee2e2', color: '#991b1b', fontSize: '0.875rem' }}>
          เกิดข้อผิดพลาดในการโหลด{STOCK_MOVEMENT_LABEL} ({movements.error.message})
        </div>
      )}

      {movements.isPending && (
        <div role="status" aria-busy="true" style={{ padding: '1rem', textAlign: 'center', color: '#6b7280', fontSize: '0.875rem' }}>
          กำลังโหลด{STOCK_MOVEMENT_LABEL}...
        </div>
      )}

      {ledger && (
        <>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', marginBottom: '0.75rem' }}>
            <FiscalYearSelect id="stock-movement-fiscal-year" value={fiscalYear} offered={ledger.fiscal_years} onChange={(year) => goTo({ fiscalYear: year, offset: 0 })} />
          </div>

          {ledger.items.length === 0 ? (
            <div id="stock-movement-empty" style={{ padding: '1.5rem 1rem', textAlign: 'center', backgroundColor: '#f9fafb', borderRadius: '6px', border: '1px dashed #d1d5db', color: '#6b7280', fontSize: '0.875rem' }}>
              {fiscalYear === '' ? NO_STOCK_MOVEMENT_LABEL : `ไม่พบ${STOCK_MOVEMENT_LABEL}ใน${FISCAL_YEAR_LABEL} ${fiscalYear}`}
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table id="stock-movement-table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.875rem' }}>
                <thead>
                  <tr style={{ backgroundColor: '#f9fafb', borderBottom: '2px solid #e5e7eb' }}>
                    <th style={headStyle}>{EFFECTIVE_DATE_LABEL}</th>
                    <th style={headStyle}>รายการ</th>
                    <th style={headStyle}>เอกสาร</th>
                    <th style={headStyle}>จำนวนที่บันทึก</th>
                    <th style={headStyle}>จำนวน ({BASE_UNIT_LABEL})</th>
                    <th style={headStyle}>{RUNNING_BALANCE_LABEL}</th>
                    <th style={headStyle}>{RECORDED_AT_LABEL}</th>
                  </tr>
                </thead>
                <tbody>
                  {ledger.items.map((row) => {
                    const source = STOCK_MOVEMENT_SOURCES[row.source.kind];
                    return (
                      <tr key={row.id} data-testid={`stock-movement-row-${row.id}`} style={{ borderBottom: '1px solid #e5e7eb' }}>
                        <td style={cellStyle}>{thaiDate(row.effective_date)}</td>
                        <td style={cellStyle}>{STOCK_MOVEMENT_KIND_LABELS[row.kind]}</td>
                        <td style={cellStyle}>
                          <Link to={`${source.path}/${row.source.id}`} style={{ color: '#2563eb', textDecoration: 'underline' }}>
                            {source.numberLabel} {row.source.number}
                          </Link>
                        </td>
                        <td style={cellStyle}>
                          {row.original_quantity} {row.original_unit.name} × {row.conversion_factor}
                        </td>
                        <td style={cellStyle}>
                          {row.base_quantity} {row.base_unit.name}
                        </td>
                        <td style={{ ...cellStyle, fontWeight: 600 }}>
                          {row.balance} {row.base_unit.name}
                        </td>
                        <td style={cellStyle}>
                          <time dateTime={row.recorded_at}>{THAI_DATE_TIME.format(new Date(row.recorded_at))}</time> โดย {row.recorded_by_username}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {ledger.total_count > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginTop: '0.75rem', fontSize: '0.875rem', color: '#4b5563' }}>
              <span id="stock-movement-count">
                รายการที่ {ledger.offset + 1}–{ledger.offset + ledger.items.length} จาก {ledger.total_count}
              </span>
              <button type="button" id="stock-movement-previous" disabled={offset === 0} onClick={() => goTo({ offset: Math.max(0, offset - PAGE_SIZE) })} style={pageButtonStyle}>
                ก่อนหน้า
              </button>
              <button type="button" id="stock-movement-next" disabled={!ledger.has_more} onClick={() => goTo({ offset: offset + PAGE_SIZE })} style={pageButtonStyle}>
                ถัดไป
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
};
