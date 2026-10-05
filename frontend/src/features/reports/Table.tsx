import type { ReactNode } from 'react';
export function ReportTable({
  label,
  headers,
  rows,
}: {
  label: string;
  headers: string[];
  rows: { key: string; cells: ReactNode[] }[];
}) {
  return rows.length ? (
    <div className="reports-table-wrap" role="region" aria-label={label} tabIndex={0}>
      <table className="reports-table">
        <thead>
          <tr>
            {headers.map((x) => (
              <th key={x} scope="col">
                {x}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              {row.cells.map((cell, i) => (
                <td key={headers[i]} data-label={headers[i]}>
                  <div className="reports-cell">{cell}</div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : (
    <p className="reports-empty">За цими умовами рядків немає.</p>
  );
}
