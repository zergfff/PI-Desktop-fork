import { useMemo } from "react";
import type { TFunction } from "i18next";

/**
 * Table view for `.csv` / `.tsv` files.
 *
 * The panel used to show these as syntax-highlighted text, which is readable
 * only until the first wide column. Parsing happens here rather than in the
 * host because the file is already in the renderer: no second read, and the
 * viewer switches instantly.
 *
 * Deliberately not a spreadsheet: no formulas, no typing, no edits. Rows and
 * columns are capped so a hundred-megabyte export cannot lock the renderer —
 * the tail of a huge file is what "打开方式" and the file manager are for.
 */
const MAX_ROWS = 4000;
const MAX_COLUMNS = 120;
const CELL_LIMIT = 400;

function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field === "") {
      quoted = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      if (rows.length >= MAX_ROWS) return rows;
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function clip(value: string): string {
  return value.length > CELL_LIMIT ? `${value.slice(0, CELL_LIMIT)}…` : value;
}

export function CsvPreview({
  content,
  delimiter,
  t,
}: {
  content: string;
  delimiter: "," | "\t";
  t: TFunction;
}) {
  const { rows, columns, truncatedRows, truncatedColumns } = useMemo(() => {
    const parsed = parseDelimited(content.replace(/^\uFEFF/, ""), delimiter);
    const width = parsed.reduce((max, row) => Math.max(max, row.length), 0);
    const visibleWidth = Math.min(width, MAX_COLUMNS);
    return {
      rows: parsed.map((row) => row.slice(0, visibleWidth)),
      columns: visibleWidth,
      truncatedRows: parsed.length >= MAX_ROWS,
      truncatedColumns: width > visibleWidth,
    };
  }, [content, delimiter]);

  if (!rows.length) return null;
  const [header, ...body] = rows;

  return (
    <div className="file-viewer-table-wrap">
      <table className="file-viewer-table">
        <thead>
          <tr>
            <th className="file-viewer-table-gutter" aria-hidden />
            {header.map((cell, index) => (
              <th key={index} title={cell}>
                {clip(cell)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex}>
              <td className="file-viewer-table-gutter">{rowIndex + 1}</td>
              {Array.from({ length: columns }, (_, cellIndex) => {
                const cell = row[cellIndex] ?? "";
                return (
                  <td key={cellIndex} title={cell}>
                    {clip(cell)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {(truncatedRows || truncatedColumns) && (
        <p className="file-viewer-table-note" role="status">
          {truncatedRows && truncatedColumns
            ? t("panel.files.tableTruncatedBoth", { rows: MAX_ROWS, columns: MAX_COLUMNS })
            : truncatedRows
              ? t("panel.files.tableTruncatedRows", { count: MAX_ROWS })
              : t("panel.files.tableTruncatedColumns", { count: MAX_COLUMNS })}
        </p>
      )}
    </div>
  );
}
