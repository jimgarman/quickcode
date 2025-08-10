import { useEffect, useState } from "react";

// CSV parser (same as before)
function parseCSV(text) {
  const rows = [];
  let row = [], cell = "", i = 0, inQuotes = false;

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      cell += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ",") { row.push(cell); cell = ""; i++; continue; }
    if (ch === "\n" || ch === "\r") {
      if (cell.length || row.length) { row.push(cell); rows.push(row); }
      cell = ""; row = [];
      if (ch === "\r" && text[i + 1] === "\n") i++;
      i++; continue;
    }
    cell += ch; i++;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

export default function App() {
  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    const url =
      "https://docs.google.com/spreadsheets/d/e/2PACX-1vTR6ksj1XHWNXGrH5dHv9yH3LHqAtr9kUVPN3ZnXszVPBZeodMDwrjxKDqFWByCP324axfWbITGYRFP/pub?gid=440159421&single=true&output=csv";

    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((csv) => {
        const table = parseCSV(csv);

        // Find the header row (the one that contains "Lender")
        const headerRowIndex = table.findIndex((r) =>
          r.some((cell) => String(cell).trim().toLowerCase() === "lender")
        );
        if (headerRowIndex === -1) throw new Error("Couldn't find header row with 'Lender'.");

        const hdrs = table[headerRowIndex].map((h) => String(h).trim());

        // Data is everything after the header row; drop empty lines
        const dataRows = table
          .slice(headerRowIndex + 1)
          .filter((r) => r.some((c) => String(c).trim() !== ""));

        // Build objects keyed by header, then filter
        const lenderIdx = hdrs.findIndex((h) => h.toLowerCase() === "lender");
        const filteredObjs = dataRows
          .map((r) => Object.fromEntries(hdrs.map((h, i) => [h, r[i] ?? ""])))
          .filter((obj) => String(obj[hdrs[lenderIdx]]).trim() === "77 Lending");

        setHeaders(hdrs);
        setRows(filteredObjs.map((obj) => hdrs.map((h) => obj[h])));
      })
      .catch((e) => setError(String(e)));
  }, []);

  if (error) return <pre style={{ color: "crimson", padding: 20 }}>Error: {error}</pre>;
  if (!headers.length) return <p style={{ padding: 20 }}>Loading…</p>;

  return (
    <div style={{ padding: 20, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial" }}>
      <h1>77 Lending — Filtered from Google Sheets</h1>
      <p style={{ color: "#666", marginTop: -10 }}>
        Showing only rows where <b>Lender</b> = <code>77 Lending</code>.
      </p>

      <div style={{ overflowX: "auto", marginTop: 16 }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              {headers.map((h, i) => (
                <th key={i} style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "8px" }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <td key={c} style={{ borderBottom: "1px solid #f0f0f0", padding: "8px" }}>
                    {String(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}