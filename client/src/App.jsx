import "./qc.css";
import React, { useEffect, useMemo, useState } from "react";
import { onAuth, signIn, logout, auth } from "./auth/firebase";

const allowedDomain = (import.meta.env.VITE_ALLOWED_DOMAIN || "").toLowerCase();
const HIDE_COLUMNS = new Set(["ID", "User Name", "Status", "Approver"]);
const CONTAINER_MAX = 1375;

// Google-sheet style date → MM/DD/YYYY
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
    const yyyy = d.getFullYear();
    return `${mm}/${dd}/${yyyy}`;
  }
  return value ?? "";
}

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

export default function App() {
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

  // header accent classes
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

    const display =
      h === "Date" ? fmtCell("Date", e.row[h]) : e.row[h] ?? "";
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

  return (
    <>
      {/* Header band */}
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

      {/* Main container */}
      <div className="qc-container" style={{ maxWidth: CONTAINER_MAX }}>
        {user ? (
          <>
            {/* Your Transactions */}
            <h3 style={{ marginTop: 8 }}>Your Transactions</h3>
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
                  <table className="qc-table">
<thead>
  <tr>
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
                        const id = r["ID"];
                        const e = { ...(edits[id] || {}), row: r };
                        return (
                          <tr key={id}>
                            {(injectedHeaders || []).map((h, idx) => {
                              if (h === "~OR~") {
                                return (
                                  <td
                                    key={`or-${id}-${idx}`}
                                    className={tdStyle}
                                    style={{
                                      textAlign: "center",
                                      fontWeight: 600,
                                    }}
                                  >
                                    OR
                                  </td>
                                );
                              }
                              return renderEditableCell(
                                "mine",
                                id,
                                h,
                                e,
                                setEdits
                              );
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
                  const label = `Approve ${first}'s Transactions`;

                  return (
                    <div key={group.purchaser} style={{ marginTop: 24 }}>
                      <h3 style={{ margin: "8px 0 12px" }}>{label}</h3>
                      <div
                        style={{
                          overflowX: "auto",
                          border: "1px solid #eee",
                          borderRadius: 8,
                        }}
                      >
                        <table className="qc-table">
<thead>
  <tr>
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
                              const id = r["ID"];
                              const e = {
                                ...(approvalsEdits[id] || {}),
                                row: r,
                              };
                              return (
                                <tr key={id}>
                                  {(injectedHeaders || []).map((h, i) => {
                                    if (h === "~OR~") {
                                      return (
                                        <td
                                          key={`or-appr-${id}-${i}`}
                                          className={tdStyle}
                                          style={{
                                            textAlign: "center",
                                            fontWeight: 600,
                                          }}
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
          </>
        ) : (
          // Signed-out landing message
          <div style={{ padding: "32px 0", color: "#495057", fontSize: 18 }}>
            Welcome! Sign in with your Google Account using the button above.
          </div>
        )}
      </div>
    </>
  );
}