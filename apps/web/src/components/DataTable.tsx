import type { ReactNode } from "react";

export type Column<T> = {
  key: string;
  header: string;
  className?: string;
  render: (row: T) => ReactNode;
};

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  onRowClick,
  empty,
  rowClassName,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  empty: ReactNode;
  rowClassName?: (row: T) => string;
}) {
  if (rows.length === 0) return <>{empty}</>;
  return (
    <div className="overflow-auto rounded-[var(--lyx-radius)] border border-lyx-border bg-lyx-bg">
      <table className="w-full border-collapse text-left">
        <thead className="sticky top-0 bg-lyx-bg">
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                className={`border-b border-lyx-border px-4 py-2.5 text-[10.5px] font-bold uppercase tracking-wider text-lyx-fg-subtle ${col.className ?? ""}`}
              >
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className={`border-b border-lyx-border last:border-b-0 ${onRowClick ? "cursor-pointer hover:bg-lyx-muted" : ""} ${rowClassName?.(row) ?? ""}`}
              onClick={() => onRowClick?.(row)}
            >
              {columns.map((col) => (
                <td key={col.key} className={`px-4 py-3 text-[12.5px] ${col.className ?? ""}`}>
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
