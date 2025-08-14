// ===== START: Imports and Constants =====
import "./qc.css";
import React, { useEffect, useMemo, useState } from "react";
import { onAuth, signIn, logout, auth } from "./auth/firebase";

const allowedDomain = (import.meta.env.VITE_ALLOWED_DOMAIN || "").toLowerCase();
const HIDE_COLUMNS = new Set(["ID", "User Name", "Status", "Approver"]);
const CONTAINER_MAX = 1375;
// ===== END: Imports and Constants =====



// ===== START: ActionsMenu Component =====
/** Actions menu (UI-only) */
function ActionsMenu({ disabled, onSplit, onBackcharge }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative", display: "inline-block" }}>
      <button
        className="qc-menu-btn"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        Actions ▾
      </button>
      {open && (
        <div className="qc-menu" role="menu" aria-label="Actions">
          <ul>
            <li>
              <button role="menuitem" onClick={() => { setOpen(false); onSplit?.(); }}>
                Split
              </button>
            </li>
            {/* Backcharge temporarily removed per request */}
          </ul>
        </div>
      )}
    </div>
  );
}
// ===== END: ActionsMenu Component =====



// ===== START: Split/Currency Helpers =====
/* ---------- Helpers for Split dialog ---------- */
function toCents(input) {
  if (input == null) return 0;
  const s = String(input).replace(/[^0-9.-]/g, "");
  if (!s) return 0;
  const n = Number.parseFloat(s);
  if (Number.isNaN(n)) return 0;
  return Math.round(n * 100);
}
function centsToUSD(cents) {
  const v = (cents || 0) / 100;
  return v.toLocaleString(undefined, { style: "currency", currency: "USD" });
}
// ===== END: Split/Currency Helpers =====



// ===== START: Formatting Helpers =====
/* Google-sheet style date → MM/DD (UI only; backend unchanged) */
function fmtCell(header, value) {
  if (header === "Date") {
    const v = (value ?? "").toString().trim();
    if (!v) return "";
    const n = Number(v);
    let d;
    if (!Number.isNaN(n)) {
      const epoch = new Date(Date.UTC(1899, 11, 30));
      d = new Date(epoch.getTime() + n * 86400000);
    } else {
      d = new Date(v.replace(/-/g, "/"));
    }
    if (Number.isNaN(d.getTime())) return v;
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${mm}/${dd}`;
  }
  return value ?? "";
}
// ===== END: Formatting Helpers =====



/* ===== START: Currency Display Formatter (NEW) =====
   Purpose: Ensure all "Amount" cells display as localized USD currency,
   regardless of whether the raw value is a number ("30", 30, 30.0) or
   a string ("$30.00"). Uses toCents for normalization. */
function fmtCurrencyDisplay(value) {
  const cents = toCents(value);
  return (cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD" });
}
/* ===== END: Currency Display Formatter (NEW) ===== */



// ===== START: Currency Input Sanitizers =====
/** UI-only Split dialog */
function sanitizeCurrencyInput(raw) {
  const s = String(raw ?? "").replace(/[^0-9.]/g, "");
  const parts = s.split(".");
  if (parts.length > 2) return parts[0] + "." + parts.slice(1).join("");
  return s;
}
function prettyCurrency(raw) {
  const cents = toCents(raw);
  return (cents / 100).toLocaleString(undefined, { style: "currency", currency: "USD" });
}
// ===== END: Currency Input Sanitizers =====



// ===== START: SplitDialog Component =====
function SplitDialog({ row, onCancel, onConfirm, /* ===== NEW PROP ===== */ busy = false /* used to show "Processing…" and disable Confirm */ }) {
  if (!row) return null;

  const originalDesc =
    row["Transaction Description"] ?? row["Transcation Description"] ?? "";
  const originalAmountCents = toCents(row["Amount"]);

  const [lines, setLines] = useState([
    { notes: "", amount: "" },
    { notes: "", amount: "" },
  ]);

  const addLine = () => setLines((prev) => [...prev, { notes: "", amount: "" }]);
  const removeLine = (idx) => setLines((prev) => prev.filter((_, i) => i !== idx));

  const onAmountChange = (i, raw) => {
    const sanitized = sanitizeCurrencyInput(raw);
    setLines((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], amount: sanitized };
      return next;
    });
  };
  const onAmountBlur = (i) => {
    setLines((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], amount: prettyCurrency(next[i].amount) };
      return next;
    });
  };
  const onAmountFocus = (i) => {
    setLines((prev) => {
      const next = [...prev];
      next[i] = { ...next[i], amount: sanitizeCurrencyInput(next[i].amount) };
      return next;
    });
  };

  const splitTotalCents = lines.reduce((sum, l) => sum + toCents(l.amount), 0);
  const allFilled = lines.every((l) => toCents(l.amount) > 0);
  const canConfirm = allFilled && splitTotalCents === originalAmountCents;

  return (
    <div className="qc-modal" role="dialog" aria-modal="true">
      <div className="qc-dialog">
        <div className="qc-dialog-hd">Split Transaction</div>

        <div className="qc-dialog-body">
          <table className="qc-split-grid">
            {/* These columns map to CSS vars in qc.css so widths are easy to adjust */}
            <colgroup>
              <col className="col-desc" />
              <col className="col-notes" />
              <col className="col-amt" />
              <col className="col-del" />
            </colgroup>

            <thead>
              <tr>
                <th className="qc-split-row-desc">Transaction Description - New</th>
                <th className="qc-split-row-notes">Notes</th>
                <th className="qc-split-row-amt">Amount</th>
                <th className="qc-split-row-del"></th>
              </tr>
            </thead>

            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td className="qc-split-row-desc">
                    {`${originalDesc} #${i + 1}`}
                  </td>

                  <td className="qc-split-row-notes">
                    <input
                      className="qc-input"
                      value={l.notes}
                      onChange={(e) =>
                        setLines((prev) => {
                          const next = [...prev];
                          next[i] = { ...next[i], notes: e.target.value };
                          return next;
                        })
                      }
                      disabled={busy}
                    />
                  </td>

                  <td className="qc-split-row-amt">
                    <input
                      className="qc-input qc-amount-input"
                      inputMode="decimal"
                      placeholder="$0.00"
                      value={l.amount}
                      onChange={(e) => onAmountChange(i, e.target.value)}
                      onBlur={() => onAmountBlur(i)}
                      onFocus={() => onAmountFocus(i)}
                      disabled={busy}
                    />
                  </td>

                  <td className="qc-split-row-del">
                    {i >= 2 && (
                      <button
                        type="button"
                        className="qc-row-remove"
                        title="Remove line"
                        aria-label={`Remove Split #${i + 1}`}
                        onClick={() => removeLine(i)}
                        disabled={busy}
                      >
                        {/* Trash can icon */}
                        <svg viewBox="0 0 24 24" aria-hidden="true">
                          <path
                            d="M9 3h6a1 1 0 0 1 1 1v1h4v2h-1.1l-1.1 12.1A2 2 0 0 1 15.8 22H8.2a2 2 0 0 1-1.99-1.89L5.1 7H4V5h4V4a1 1 0 0 1 1-1Zm1 2h4V4h-4v1Zm-1.9 2 1 11h7.8l1-11H8.1ZM10 9h2v8h-2V9Zm4 0h2v8h-2V9Z"
                            fill="currentColor"
                          />
                        </svg>
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="qc-add-row" onClick={addLine} role="button" tabIndex={0}>
            + Add
          </div>

          {/* Summary aligned far right under Amount column */}
          <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
            <table>
              <tbody>
                <tr>
                  <td style={{ paddingRight: 32, fontWeight: "bold", textAlign: "right" }}>Split Total:</td>
                  <td style={{ textAlign: "right", fontWeight: "bold" }}>
                    {(splitTotalCents / 100).toLocaleString(undefined, { style: "currency", currency: "USD" })}
                  </td>
                </tr>
                <tr>
  <td colSpan="2" style={{ height: "8px" }}></td>
</tr>
                <tr>
                  <td style={{ paddingRight: 32, textAlign: "right" }}>Original:</td>
                  <td style={{ textAlign: "right" }}>
                    {(originalAmountCents / 100).toLocaleString(undefined, { style: "currency", currency: "USD" })}
                  </td>
                </tr>
                <tr>
                  <td style={{ paddingRight: 32, textAlign: "right" }}>Difference:</td>
                  <td style={{ textAlign: "right" }}>
                    {((splitTotalCents - originalAmountCents) / 100).toLocaleString(undefined, { style: "currency", currency: "USD" })}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* Footer: buttons on the RIGHT */}
        <div className="qc-dialog-ft">
<button
  className="qc-btn"
  style={{ marginRight: "16px" }} // adjust px as needed
  onClick={onCancel}
  disabled={busy}
>
  Cancel
</button>
          <button
            className="qc-btn qc-btn-primary"
            onClick={() => {
              const payload = lines.map((l, i) => ({
                description: `${originalDesc} - Split #${i + 1}`,
                notes: (l.notes || "").trim(),
                amountCents: toCents(l.amount),
              }));
              onConfirm?.(payload);
            }}
            disabled={!canConfirm || busy}
            title={!canConfirm ? "Split amounts must total the original amount" : "Confirm split"}
          >
            {busy ? "Processing…" : "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
// ===== END: SplitDialog Component =====



// ===== START: Name/Sorting/Validation/Division Helpers =====
// Fallback first-name from username
function firstNameFromUsername(u) {
  if (!u) return "User";
  const clean = String(u).split("@")[0];
  const parts = clean.split(/[._-]+/);
  const first = parts[0] || clean;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

// Sort helper by Transaction Description
const TXN_HEADER = "Transaction Description";
const TXN_HEADER_OLD = "Transcation Description"; // tolerate legacy header from sheet
function txnKey(r) {
  return (r?.[TXN_HEADER] ?? r?.[TXN_HEADER_OLD] ?? "").toString();
}
function sortByTxn(rows) {
  return [...(rows || [])].sort((a, b) =>
    txnKey(a).localeCompare(txnKey(b), undefined, { sensitivity: "base" })
  );
}

// ---------- VALIDATION ----------
function isRowValid(e) {
  const notesOK = !!(e.notes && e.notes.trim().length > 0);
  const hasJob = !!(e.jobId && e.jobId.trim().length);
  const hasCost = !!(e.costCodeCode && e.costCodeCode.trim().length);
  const hasGL = !!(e.glAccountCode && e.glAccountCode.trim().length);

  // Accept either:
  //  A) Job path: job + cost (GL may exist; backend sets 1300 automatically)
  //  B) GL path:  GL only (no job, no cost)
  const pathJob = hasJob && hasCost;
  const pathGL = hasGL && !hasJob && !hasCost;
  return notesOK && (pathJob || pathGL);
}

// Division helpers
const DIVISION_LABEL_TO_CODE = {
  Raleigh: "10-01",
  Corporate: "10-99",
};
const DIVISION_CODE_TO_LABEL = {
  "10-01": "Raleigh",
  "10-99": "Corporate",
};
// ===== END: Name/Sorting/Validation/Division Helpers =====



// ===== START: Main App Component =====
export default function App() {
  // ===== START: State =====
  const [user, setUser] = useState(null);
  const [deny, setDeny] = useState("");
  const [err, setErr] = useState("");

  const [jobIds, setJobIds] = useState([]);
  const [costCodes, setCostCodes] = useState([]);
  const [glAccounts, setGlAccounts] = useState([]);
  const [usersByEmail, setUsersByEmail] = useState({});
  const [usersByUsername, setUsersByUsername] = useState({});

  const [loading, setLoading] = useState(false);
  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]);

  const [approvals, setApprovals] = useState([]);
  const [approvalsLoading, setApprovalsLoading] = useState(false);
  const [approvalsErr, setApprovalsErr] = useState("");
  const [approvalsEdits, setApprovalsEdits] = useState({});

  const [edits, setEdits] = useState({});
  const [triedSubmit, setTriedSubmit] = useState(false);
  const [triedApprove, setTriedApprove] = useState(false);

  // loading indicators
  const [submitting, setSubmitting] = useState(false);
  const [approving, setApproving] = useState(false);

  // selection state
  const [selectedMine, setSelectedMine] = useState(() => new Set());
  const [selectedByGroup, setSelectedByGroup] = useState({}); // { purchaser: Set(ids) }

  // split dialog state
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitCtx, setSplitCtx] = useState(null); // { scope: 'mine'|'appr', purchaser?, row }

  /* ===== START: Split processing state (NEW) =====
     Drives the "Processing…" UI and disables Confirm while the split request runs. */
  const [splitting, setSplitting] = useState(false);
  /* ===== END: Split processing state (NEW) ===== */
  // ===== END: State =====



  // ===== START: Auth Effect =====
  useEffect(() => {
    return onAuth(async (u) => {
      if (!u) {
        setUser(null);
        setDeny("");
        return;
      }
      const email = (u.email || "").toLowerCase();
      if (allowedDomain && !email.endsWith(`@${allowedDomain}`)) {
        await logout();
        setUser(null);
        setDeny(`Only @${allowedDomain} accounts are allowed.`);
        return;
      }
      setDeny("");
      setUser({ displayName: u.displayName ?? email, email });
    });
  }, []);
  // ===== END: Auth Effect =====



  // ===== START: Lookup Data Effect =====
  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        const t = await auth.currentUser?.getIdToken();
        const res = await fetch(`${import.meta.env.VITE_API_BASE}/api/lookups`, {
          headers: { Authorization: `Bearer ${t}` },
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        setJobIds(json.jobIds || []);
        setCostCodes(json.costCodes || []);
        setGlAccounts(json.glAccounts || []);
        setUsersByEmail(json.usersByEmail || {});
        setUsersByUsername(json.usersByUsername || {});
      } catch (e) {
        console.error("lookups:", e);
      }
    })();
  }, [user]);
  // ===== END: Lookup Data Effect =====



  // ===== START: Fetch "Your Transactions" Effect =====
  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        setLoading(true);
        setErr("");
        const token = await auth.currentUser?.getIdToken();
        const res = await fetch(`${import.meta.env.VITE_API_BASE}/api/log/new`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        setHeaders(Array.isArray(json.headers) ? json.headers : []);
        const r = Array.isArray(json.rows) ? json.rows : [];
        const sorted = sortByTxn(r);
        setRows(sorted);

        const next = {};
        for (const row of sorted) {
          const id = row["ID"];
          next[id] = {
            notes: row["Notes"] || "",
            jobId: row["Job ID"] || "",
            costCodeCode: row["Cost Code"] || "",
            glAccountCode: row["GL Account"] || "",
            divisionCode: (row["Division"] || "").toString().trim(), // store as '10-01' / '10-99'
          };
        }
        setEdits(next);
      } catch (e) {
        console.error(e);
        setErr(String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [user]);
  // ===== END: Fetch "Your Transactions" Effect =====



  // ===== START: Fetch Approvals Effect =====
  useEffect(() => {
    if (!user) return;
    (async () => {
      try {
        setApprovalsLoading(true);
        setApprovalsErr("");
        const token = await auth.currentUser?.getIdToken();
        const res = await fetch(
          `${import.meta.env.VITE_API_BASE}/api/approvals/submitted`,
          {
            headers: { Authorization: `Bearer ${token}` },
          }
        );
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
        const groups = Array.isArray(json.groups) ? json.groups : [];
        const sortedGroups = groups.map((g) => ({
          ...g,
          rows: sortByTxn(g.rows),
        }));
        setApprovals(sortedGroups);

        const seed = {};
        for (const g of sortedGroups) {
          for (const row of g.rows || []) {
            const id = row["ID"];
            const hasJob = !!(row["Job ID"] && String(row["Job ID"]).trim());

            seed[id] = {
              notes: row["Notes"] || "",
              jobId: row["Job ID"] || "",
              costCodeCode: row["Cost Code"] || "",
              // If Job path, show GL blank in UI; backend will set 1300 on save
              glAccountCode: hasJob ? "" : row["GL Account"] || "",
              // If Job path, clear Division in UI; otherwise use sheet value
              divisionCode: hasJob
                ? ""
                : (row["Division"] || "").toString().trim(),
            };
          }
        }
        setApprovalsEdits(seed);
      } catch (e) {
        console.error(e);
        setApprovalsErr(String(e));
      } finally {
        setApprovalsLoading(false);
      }
    })();
  }, [user]);
  // ===== END: Fetch Approvals Effect =====



  // ===== START: Utilities, Memo, and Actions =====
  const refresh = () => window.location.reload();

  const visibleHeadersBase = useMemo(
    () => (headers || []).filter((h) => !HIDE_COLUMNS.has(h)),
    [headers]
  );

  // insert ~OR~ after Cost Code
  const injectedHeaders = useMemo(() => {
    const arr = [];
    for (const h of visibleHeadersBase) {
      arr.push(h);
      if (h === "Cost Code") arr.push("~OR~");
    }
    return arr;
  }, [visibleHeadersBase]);

  // header accent classes (CSS may style nth-child; class kept for future use)
  const headerHighlight = {
    "Job ID": "job",
    "Cost Code": "cost",
    Division: "div",
    "GL Account": "gl",
  };

  const submitAll = async () => {
    setTriedSubmit(true);
    const allValid = (rows || []).every((r) =>
      isRowValid(edits[r["ID"]] || {})
    );
    if (!allValid) return;

    setSubmitting(true);
    try {
      const items = (rows || []).map((r) => {
        const id = r["ID"];
        const e = edits[id] || {};
        return {
          id,
          notes: e.notes ?? "",
          jobId: e.jobId ?? "",
          costCodeCode: e.costCodeCode ?? "",
          division: e.divisionCode ? e.divisionCode : "10-01", // default to Raleigh if missing
          glAccountCode: e.glAccountCode ?? "",
        };
      });
      const t = await auth.currentUser?.getIdToken();
      const res = await fetch(
        `${import.meta.env.VITE_API_BASE}/api/log/submit-batch`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${t}`,
          },
          body: JSON.stringify({ items }),
        }
      );
      const json = await res.json();
      if (!res.ok) {
        alert(json.error || "Submit failed");
        return;
      }
      refresh();
    } finally {
      setSubmitting(false);
    }
  };

  const approveAll = async () => {
    setTriedApprove(true);
    const everyRow = (approvals || []).flatMap((g) => g.rows || []);
    const allValid = everyRow.every((r) =>
      isRowValid(approvalsEdits[r["ID"]] || {})
    );
    if (!allValid) return;

    setApproving(true);
    try {
      const items = (approvals || []).flatMap((group) =>
        (group.rows || []).map((r) => {
          const id = r["ID"];
          const e = approvalsEdits[id] || {};
          return {
            id,
            notes: e.notes ?? "",
            jobId: e.jobId ?? "",
            costCodeCode: e.costCodeCode ?? "",
            division: e.divisionCode ? e.divisionCode : "10-01",
            glAccountCode: e.glAccountCode ?? "",
          };
        })
      );
      if (items.length === 0) return;
      const t = await auth.currentUser?.getIdToken();
      const res = await fetch(
        `${import.meta.env.VITE_API_BASE}/api/log/approve-batch`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${t}`,
          },
          body: JSON.stringify({ items }),
        }
      );
      const json = await res.json();
      if (!res.ok) {
        alert(json.error || "Approve failed");
        return;
      }
      refresh();
    } finally {
      setApproving(false);
    }
  };

  const resolvedFullName = (() => {
    const email = (user?.email || "").toLowerCase();
    const uname = email.split("@")[0];
    const u = usersByEmail[email] || usersByUsername[uname];
    if (u) {
      if (u.full && u.full.trim()) return u.full.trim();
      const full = [u.first, u.last].filter(Boolean).join(" ").trim();
      if (full) return full;
    }
    return user?.displayName || email;
  })();

  const thStyle = "qc-th";
  const tdStyle = "qc-td";

  const Select = ({ value, onChange, disabled, children }) => (
    <select
      className={`qc-select ${!value ? "placeholder" : ""}`}
      value={value ?? ""}
      onChange={onChange}
      disabled={disabled}
      style={{
        color: disabled
          ? "var(--qc-placeholder)"
          : value
          ? "inherit"
          : "var(--qc-placeholder)",
      }}
    >
      <option value="">{ "— select —" }</option>
      {children}
    </select>
  );

  function computeDisables(e) {
    const hasJobOrCost = !!(e.jobId || e.costCodeCode);
    const hasGLorDiv = !!(e.glAccountCode || e.divisionCode);
    return {
      disableGL: hasJobOrCost,
      disableDiv: hasJobOrCost,
      disableJob: hasGLorDiv,
      disableCost: hasGLorDiv,
    };
  }

  function withEdit(setEditState, id, patch) {
    setEditState((prev) => {
      const cur = { ...(prev[id] || {}) };
      const next = { ...cur, ...patch };
      const d = computeDisables(next);
      if (d.disableJob) next.jobId = "";
      if (d.disableCost) next.costCodeCode = "";
      if (d.disableGL) next.glAccountCode = "";
      if (d.disableDiv) next.divisionCode = "";
      return { ...prev, [id]: next };
    });
  }

  const renderEditableCell = (scope, id, h, e, setEditState) => {
    const tried = scope === "mine" ? triedSubmit : triedApprove;
    const notesInvalid = tried && !(e.notes && e.notes.trim().length > 0);
    const disables = computeDisables(e);

    if (h === "Notes") {
      return (
        <td key={`${id}-notes`} className={tdStyle}>
          <input
            className={`qc-input ${notesInvalid ? "qc-invalid" : ""}`}
            placeholder="add notes…"
            value={e.notes ?? ""}
            onChange={(ev) =>
              setEditState((prev) => ({
                ...prev,
                [id]: { ...(prev[id] || {}), notes: ev.target.value },
              }))
            }
          />
        </td>
      );
    }

    if (h === "Division") {
      return (
        <td key={`${id}-div`} className={tdStyle}>
          <Select
            value={e.divisionCode ?? ""}
            disabled={disables.disableDiv}
            onChange={(ev) =>
              withEdit(setEditState, id, { divisionCode: ev.target.value })
            }
          >
            {/* alphabetic */}
            <option value={DIVISION_LABEL_TO_CODE.Raleigh}>Raleigh</option>
            <option value={DIVISION_LABEL_TO_CODE.Corporate}>Corporate</option>
          </Select>
        </td>
      );
    }

    if (h === "Job ID") {
      return (
        <td key={`${id}-job`} className={tdStyle}>
          <Select
            value={e.jobId ?? ""}
            disabled={disables.disableJob}
            onChange={(ev) => withEdit(setEditState, id, { jobId: ev.target.value })}
          >
            {(jobIds || []).map((j) => (
              <option key={j} value={j}>
                {j}
              </option>
            ))}
          </Select>
        </td>
      );
    }

    if (h === "Cost Code") {
      return (
        <td key={`${id}-cost`} className={tdStyle}>
          <Select
            value={e.costCodeCode ?? ""}
            disabled={disables.disableCost}
            onChange={(ev) =>
              withEdit(setEditState, id, { costCodeCode: ev.target.value })
            }
          >
            {(costCodes || []).map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </Select>
        </td>
      );
    }

    if (h === "GL Account") {
      return (
        <td key={`${id}-gl`} className={tdStyle}>
          <Select
            value={e.glAccountCode ?? ""}
            disabled={disables.disableGL}
            onChange={(ev) =>
              withEdit(setEditState, id, { glAccountCode: ev.target.value })
            }
          >
            {(glAccounts || []).map((g) => (
              <option key={g.code} value={g.code}>
                {g.label}
              </option>
            ))}
          </Select>
        </td>
      );
    }

    // Format "Date" and "Amount" specially; other cells pass-through
    let display =
      h === "Date" ? fmtCell("Date", e.row[h]) :
      h === "Amount" ? fmtCurrencyDisplay(e.row[h]) :
      (e.row[h] ?? "");

    const align = h === "Amount" ? "right" : "left";
    return (
      <td
        key={`${id}-${h}`}
        className={`${tdStyle} ${h === "Amount" ? "qc-amount" : ""}`}
        style={{ textAlign: align }}
      >
        {display}
      </td>
    );
  };

  const allYourRowsValid = useMemo(
    () => (rows || []).every((r) => isRowValid(edits[r["ID"]] || {})),
    [rows, edits]
  );

  const allApprovalRowsValid = useMemo(() => {
    const everyRow = (approvals || []).flatMap((g) => g.rows || []);
    if (everyRow.length === 0) return true;
    return everyRow.every((r) =>
      isRowValid(approvalsEdits[r["ID"]] || {})
    );
  }, [approvals, approvalsEdits]);

  // selection helpers
  const yourAllIds = (rows || []).map((r) => String(r["ID"]));
  function yourToggleOne(id) {
    setSelectedMine((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  function groupGetSet(purchaser) {
    const s = selectedByGroup[purchaser];
    return s instanceof Set ? s : new Set();
  }
  function groupAllIds(group) {
    return (group.rows || []).map((r) => String(r["ID"]));
  }
  function groupAnySelected(group) {
    return groupGetSet(group.purchaser).size > 0;
  }
  function groupToggleOne(group, id) {
    setSelectedByGroup((prev) => {
      const copy = { ...prev };
      const cur = groupGetSet(group.purchaser);
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      copy[group.purchaser] = next;
      return copy;
    });
  }
  // ===== END: Utilities, Memo, and Actions =====



  // ===== START: Split Dialog Element Wrapper =====
  // --- Split dialog element (avoid JSX nesting issues) ---
  const splitDialogEl = (splitOpen && splitCtx?.row) ? (
    <SplitDialog
      row={splitCtx.row}
      onCancel={() => setSplitOpen(false)}
      /* pass busy state into dialog */
      busy={splitting}
      onConfirm={async (children) => {
        try {
          setSplitting(true);
          const t = await auth.currentUser?.getIdToken();
          if (!t) {
            alert("Could not get auth token. Please sign in again.");
            return;
          }

          // Transform UI children -> backend "splits"
          const splits = (children || []).map((c) => ({
            amount: typeof c.amountCents === "number" ? c.amountCents / 100 : 0,
            notes: c.notes || "",
            // jobId/costCode/division/glAccount optional
          }));

          const parentId = String(splitCtx.row["ID"]);

          const res = await fetch(
            `${import.meta.env.VITE_API_BASE}/api/log/split?dryRun=false&assignIds=true`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${t}`,
              },
              body: JSON.stringify({ parentId, splits }),
            }
          );

          const json = await res.json().catch(() => ({}));
          console.log("SPLIT RESP", res.status, json);

          if (!res.ok) {
            alert(json?.errors?.[0] || json?.error || "Split failed");
            return;
          }

          // Success — reload to show new split rows
          refresh();
        } catch (e) {
          console.error(e);
          alert("Network error while splitting");
        } finally {
          setSplitting(false);
          setSplitOpen(false);
        }
      }}
    />
  ) : null;
  // ===== END: Split Dialog Element Wrapper =====



  // ===== START: Render =====
  return (
    <>
      {/* ===== START: Header Band ===== */}
      <div className="qc-header">
        <div
          className="qc-container"
          style={{
            maxWidth: CONTAINER_MAX,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <h3 style={{ margin: 0, color: "#495057", fontSize: "200%" }}>
            {user
              ? `Welcome, ${resolvedFullName}`
              : "Welcome! Sign in with your Google Account"}
          </h3>

          <div>
            {user ? (
              <button
                className="qc-cta"
                onClick={async () => {
                  try {
                    await logout();
                  } catch (e) {
                    console.error(e);
                  } finally {
                    window.location.reload();
                  }
                }}
                title={user?.email || "Signed in"}
                style={{ height: 40, minWidth: 110, fontSize: 16 }}
              >
                Sign out
              </button>
            ) : (
              <button
                className="qc-cta"
                onClick={async () => {
                  try {
                    await signIn();
                  } catch (e) {
                    console.error(e);
                  } finally {
                    window.location.reload();
                  }
                }}
                style={{ height: 40, minWidth: 110, fontSize: 16 }}
              >
                Sign in
              </button>
            )}
          </div>
        </div>
      </div>
      {/* ===== END: Header Band ===== */}

      {/* ===== START: Main Container ===== */}
      <div className="qc-container" style={{ maxWidth: CONTAINER_MAX }}>
        {user ? (
          <>
            {/* ===== START: Your Transactions Section ===== */}
            <div className="qc-actionsbar" style={{ marginTop: 8 }}>
              <h3 style={{ margin: 0 }}>Your Transactions</h3>
              <ActionsMenu
                disabled={selectedMine.size === 0}
                onSplit={() => {
                  const ids = Array.from(selectedMine);
                  if (ids.length !== 1) {
                    alert("Select exactly one transaction to split.");
                    return;
                  }
                  const row = (rows || []).find((r) => String(r["ID"]) === ids[0]);
                  if (!row) {
                    alert("Could not find the selected transaction.");
                    return;
                  }
                  setSplitCtx({ scope: "mine", row });
                  setSplitOpen(true);
                }}
                onBackcharge={() =>
                  console.log("Backcharge (Your Tx):", Array.from(selectedMine))
                }
              />
            </div>

            {loading && <div>Loading…</div>}
            {!loading && (rows || []).length === 0 && (
              <div>
                Good job! All of your transactions are coded and submitted.
              </div>
            )}
            {!loading && (rows || []).length > 0 && (
              <>
                <div
                  style={{
                    overflowX: "auto",
                    border: "1px solid #eee",
                    borderRadius: 8,
                  }}
                >
                  <table className="qc-table qc-has-select">
                    <thead>
                      <tr>
                        {/* No Select-All in header per request */}
                        <th className={thStyle}></th>
                        {(injectedHeaders || []).map((h, i) =>
                          h === "~OR~" ? (
                            <th key={`sep-${i}`} className={thStyle}></th>
                          ) : (
                            <th
                              key={`${h}-${i}`}
                              className={`${thStyle} ${headerHighlight[h] ? "qc-th-accent-" + headerHighlight[h] : ""}`}
                            >
                              {h === "Division" ? "Overhead" : h}
                            </th>
                          )
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {(rows || []).map((r) => {
                        const id = String(r["ID"]);
                        const checked = selectedMine.has(id);
                        const e = { ...(edits[id] || {}), row: r };
                        return (
                          <tr key={id}>
                            <td className={tdStyle} style={{ textAlign: "center" }}>
                              <input
                                type="checkbox"
                                aria-label={`Select row ${id}`}
                                checked={checked}
                                onChange={() => yourToggleOne(id)}
                              />
                            </td>
                            {(injectedHeaders || []).map((h, idx) => {
                              if (h === "~OR~") {
                                return (
                                  <td
                                    key={`or-${id}-${idx}`}
                                    className={tdStyle}
                                    style={{ textAlign: "center", fontWeight: 600 }}
                                  >
                                    OR
                                  </td>
                                );
                              }
                              return renderEditableCell("mine", id, h, e, setEdits);
                            })}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="qc-actions">
                  <button
                    className="qc-cta"
                    onClick={submitAll}
                    disabled={!allYourRowsValid || submitting}
                  >
                    {submitting ? "Submitting…" : "Submit"}
                  </button>
                </div>
              </>
            )}
            {/* ===== END: Your Transactions Section ===== */}

            {/* ===== START: Approvals Section ===== */}
            {/* Approvals */}
            <hr
              style={{
                margin: "32px 0",
                border: 0,
                borderTop: "1px solid #eee",
              }}
            />
            {!approvalsLoading && (approvals || []).length > 0 && (
              <>
                {(approvals || []).map((group) => {
                  // Resolve purchaser label
                  const purchaser = (group.purchaser || "").toLowerCase();
                  const domainFromMe = (user?.email || "").split("@")[1] || "";
                  const emailGuess = domainFromMe
                    ? `${purchaser}@${domainFromMe}`
                    : "";
                  const u =
                    usersByUsername[purchaser] ||
                    usersByEmail[emailGuess] ||
                    null;
                  const first =
                    (u?.first && u.first.trim()) ||
                    firstNameFromUsername(purchaser);
                  const label = `${first}'s Transactions`;

                  const gSelSet = groupGetSet(group.purchaser);
                  const gAnySel = groupAnySelected(group);

                  return (
                    <div key={group.purchaser} style={{ marginTop: 24 }}>
                      <div className="qc-actionsbar" style={{ margin: "8px 0 12px" }}>
                        <h3 style={{ margin: 0 }}>{label}</h3>
                        <ActionsMenu
                          disabled={!gAnySel}
                          onSplit={() => {
                            const ids = Array.from(gSelSet);
                            if (ids.length !== 1) {
                              alert("Select exactly one transaction to split.");
                              return;
                            }
                            const row = (group.rows || []).find(
                              (r) => String(r["ID"]) === ids[0]
                            );
                            if (!row) {
                              alert("Could not find the selected transaction.");
                              return;
                            }
                            setSplitCtx({ scope: "appr", purchaser: group.purchaser, row });
                            setSplitOpen(true);
                          }}
                          onBackcharge={() =>
                            console.log("Backcharge (Approvals):", group.purchaser, Array.from(gSelSet))
                          }
                        />
                      </div>

                      <div
                        style={{
                          overflowX: "auto",
                          border: "1px solid #eee",
                          borderRadius: 8,
                        }}
                      >
                        <table className="qc-table qc-has-select">
                          <thead>
                            <tr>
                              {/* No Select-All in header per request */}
                              <th className={thStyle}></th>
                              {(injectedHeaders || []).map((h, i) =>
                                h === "~OR~" ? (
                                  <th
                                    key={`${group.purchaser}-sep-${i}`}
                                    className={thStyle}
                                  ></th>
                                ) : (
                                  <th
                                    key={`${group.purchaser}-${h}-${i}`}
                                    className={`${thStyle} ${headerHighlight[h] ? "qc-th-accent-" + headerHighlight[h] : ""}`}
                                  >
                                    {h === "Division" ? "Overhead" : h}
                                  </th>
                                )
                              )}
                            </tr>
                          </thead>
                          <tbody>
                            {(group.rows || []).map((r) => {
                              const id = String(r["ID"]);
                              const checked = groupGetSet(group.purchaser).has(id);
                              const e = {
                                ...(approvalsEdits[id] || {}),
                                row: r,
                              };
                              return (
                                <tr key={id}>
                                  <td className={tdStyle} style={{ textAlign: "center" }}>
                                    <input
                                      type="checkbox"
                                      aria-label={`Select row ${id} for ${group.purchaser}`}
                                      checked={checked}
                                      onChange={() => groupToggleOne(group, id)}
                                    />
                                  </td>
                                  {(injectedHeaders || []).map((h, i) => {
                                    if (h === "~OR~") {
                                      return (
                                        <td
                                          key={`or-appr-${id}-${i}`}
                                          className={tdStyle}
                                          style={{ textAlign: "center", fontWeight: 600 }}
                                        >
                                          OR
                                        </td>
                                      );
                                    }
                                    return renderEditableCell(
                                      "appr",
                                      id,
                                      h,
                                      e,
                                      setApprovalsEdits
                                    );
                                  })}
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                })}
                <div className="qc-actions">
                  <button
                    className="qc-cta"
                    onClick={approveAll}
                    disabled={!allApprovalRowsValid || approving}
                  >
                    {approving ? "Approving…" : "Approve"}
                  </button>
                </div>
              </>
            )}
            {/* ===== END: Approvals Section ===== */}
          </>
        ) : (
          <>
            {/* ===== START: Signed-out Landing ===== */}
            {/* Signed-out landing message */}
            <div style={{ padding: "32px 0", color: "#495057", fontSize: 18 }}>
              Welcome! Sign in with your Google Account using the button above.
            </div>
            {/* ===== END: Signed-out Landing ===== */}
          </>
        )}
      </div>
      {/* ===== END: Main Container ===== */}

      {/* ===== START: Bottom Split Dialog Mount (UI only) ===== */}
      {/* Split dialog (UI only) */}
      {splitOpen && splitCtx?.row && (
        <SplitDialog
          row={splitCtx.row}
          onCancel={() => setSplitOpen(false)}
          /* pass busy state into dialog */
          busy={splitting}
          onConfirm={async (children) => {
            try {
              setSplitting(true);
              const t = await auth.currentUser?.getIdToken();
              if (!t) {
                alert("Could not get auth token. Please sign in again.");
                return;
              }

              // Transform UI children -> backend "splits"
              const splits = (children || []).map((c) => ({
                amount:
                  typeof c.amountCents === "number" ? c.amountCents / 100 : 0,
                notes: c.notes || "",
                // jobId/costCode/division/glAccount optional
              }));

              const parentId = String(splitCtx.row["ID"]);

              const res = await fetch(
                `${import.meta.env.VITE_API_BASE}/api/log/split?dryRun=false&assignIds=true`,
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${t}`,
                  },
                  body: JSON.stringify({ parentId, splits }),
                }
              );

              const json = await res.json().catch(() => ({}));
              console.log("SPLIT RESP", res.status, json);

              if (!res.ok) {
                alert(json?.errors?.[0] || json?.error || "Split failed");
                return;
              }

              // Success — reload to show new split rows
              refresh();
            } catch (e) {
              console.error(e);
              alert("Network error while splitting");
            } finally {
              setSplitting(false);
              setSplitOpen(false);
            }
          }}
        />
      )}
      {/* ===== END: Bottom Split Dialog Mount (UI only) ===== */}
    </>
  );
  // ===== END: Render =====
}
// ===== END: Main App Component =====