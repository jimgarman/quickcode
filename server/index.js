// server/index.js
import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { google } from 'googleapis'
import admin from 'firebase-admin'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

console.log('GAC =', process.env.GOOGLE_APPLICATION_CREDENTIALS)

const app = express()
app.use(cors({ origin: true }))
app.use(express.json())

console.log('Starting QuickCode backend...')

// ---- Paths (for ESM)
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// ---- Firebase Admin
function loadServiceAccount() {
  const p =
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH ||
    path.resolve(__dirname, 'credentials', 'service-account.json')
  const raw = fs.readFileSync(p, 'utf8')
  return JSON.parse(raw)
}

if (!admin.apps.length) {
  const svc = loadServiceAccount()
  admin.initializeApp({ credential: admin.credential.cert(svc) })
}

async function requireAuth(req, res, next) {
  try {
    const hdr = req.headers.authorization || ''
    const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null
    if (!token) return res.status(401).json({ error: 'Missing Authorization: Bearer <token>' })
    const decoded = await admin.auth().verifyIdToken(token)
    const email = (decoded.email || '').toLowerCase()
    const allowed = (process.env.ALLOWED_DOMAIN || '').toLowerCase()
    if (!email || (allowed && !email.endsWith(`@${allowed}`))) {
      return res.status(403).json({ error: 'Forbidden: wrong domain' })
    }
    req.user = { uid: decoded.uid, email }
    next()
  } catch (e) {
    console.error('Auth error:', e)
    res.status(401).json({ error: 'Invalid or expired token' })
  }
}

// ---- Google Sheets helpers
function colLetter(i) {
  let s = '', n = i + 1
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26) }
  return s
}
function indexHeaders(headers) {
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
  const map = Object.fromEntries(headers.map((h, i) => [norm(h), i]))
  return { norm, map }
}

async function getSheetClient() {
  // Prefer env override, else fall back to server/credentials/service-account.json
  const keyPath =
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    path.resolve(__dirname, 'credentials', 'service-account.json')

  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    keyFile: keyPath,
  })
  const client = await auth.getClient()
  return google.sheets({ version: 'v4', auth: client })
}

async function readAllRows(title) {
  const sheets = await getSheetClient()
  const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${title}!A1:Z10000`,
    majorDimension: 'ROWS',
  })
  return { sheets, spreadsheetId, rows: data.values || [] }
}

async function updateWholeRow({ sheets, spreadsheetId, title, rowNum1, values }) {
  const lastCol = values.length > 0 ? colLetter(values.length - 1) : 'Z'
  const range = `${title}!A${rowNum1}:${lastCol}${rowNum1}`
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'RAW',
    requestBody: { values: [values] },
  })
}

/**
 * Find a single row by its ID in the given tab.
 * Returns { sheets, spreadsheetId, headers, map, norm, row, rowNum1 } or null if not found.
 */
async function getRowById(title, id) {
  const wanted = String(id).trim()
  const { sheets, spreadsheetId, rows } = await readAllRows(title)
  if (!rows || rows.length < 2) return null
  const headers = rows[0]
  const { norm, map } = indexHeaders(headers)
  const ID = map[norm('ID')] ?? map['id']
  if (ID == null) return null

  for (let i = 1; i < rows.length; i++) {
    const val = (rows[i][ID] || '').toString().trim()
    if (val === wanted) {
      return {
        sheets,
        spreadsheetId,
        headers,
        map,
        norm,
        row: rows[i],
        rowNum1: i + 1, // 1-based
      }
    }
  }
  return null
}

/**
 * Scan the sheet to find the ID column and return the next numeric ID.
 * Returns { idIdx, nextId }. If no ID column exists, returns { idIdx: null, nextId: null }.
 */
async function getNextIdInfo(title) {
  const { rows } = await readAllRows(title)
  if (!rows || rows.length < 2) return { idIdx: null, nextId: null }
  const headers = rows[0]
  const { norm, map } = indexHeaders(headers)
  const idIdx = map[norm('ID')] ?? map['id']
  if (idIdx == null) return { idIdx: null, nextId: null }

  let maxId = 0
  for (let i = 1; i < rows.length; i++) {
    const raw = (rows[i]?.[idIdx] ?? '').toString().trim()
    if (!raw) continue
    const n = Number(raw.replace(/[^0-9.-]/g, ''))
    if (!Number.isNaN(n)) {
      maxId = Math.max(maxId, Math.floor(n))
    }
  }
  return { idIdx, nextId: maxId + 1 }
}

/**
 * Create child rows (objects keyed by headers) by inheriting from the parent row,
 * then overlaying split-specific fields.
 */
function buildChildrenFromParent(headers, parentRow, splits, map, norm) {
  const h = (name, ...alts) => map[norm(name)] ?? alts.map(a => map[norm(a)]).find(i => i != null)

  const IDX = {
    AMOUNT:   h('Amount', 'Total'),
    NOTES:    h('Notes', 'Memo'),
    JOBID:    h('Job ID', 'Job'),
    COSTCODE: h('Cost Code', 'CostCode'),
    DIVISION: h('Division', 'Dept'),
    GL:       h('GL Account', 'GL', 'Account'),
    STATUS:   h('Status'),
    USERNAME: h('User Name', 'Username', 'User', 'UserID'),
    ID:       h('ID'),
  }

  const children = []

  for (const s of splits) {
    const rowVals = [...parentRow]
    const setIfIdx = (idx, val) => { if (idx != null) rowVals[idx] = val }

    // ✅ parse currency/number input to numeric
    setIfIdx(IDX.AMOUNT, parseMoneyToNumber(s.amount))
    if (s.notes !== undefined) setIfIdx(IDX.NOTES, s.notes ?? '')
    if (s.jobId !== undefined) setIfIdx(IDX.JOBID, s.jobId ?? '')
    if (s.costCode !== undefined) setIfIdx(IDX.COSTCODE, s.costCode ?? '')
    if (s.division !== undefined) setIfIdx(IDX.DIVISION, s.division ?? '')

    if (s.jobId && String(s.jobId).trim()) {
      setIfIdx(IDX.GL, '1300')
    } else if (s.glAccount !== undefined) {
      setIfIdx(IDX.GL, s.glAccount ?? '')
    }

    const obj = headers.reduce((o, h, i) => (o[h] = rowVals[i] ?? '', o), {})
    children.push(obj)
  }

  return children
}

/**
 * Convert an object keyed by headers into a row array aligned to those headers.
 * Any missing keys become '' so the array length matches headers.length.
 */
function toRowValues(headers, obj) {
  const row = new Array(headers.length).fill('')
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]
    row[i] = obj[h] ?? ''
  }
  return row
}

// Parse things like "$131.34", "131.34", "1,234.56" -> 131.34 (number) or NaN if invalid
function parseMoneyToNumber(input) {
  if (input == null) return NaN
  const s = String(input).trim()
  if (!s) return NaN
  const cleaned = s.replace(/[^0-9.,-]/g, '')
  if (cleaned.includes(',') && cleaned.includes('.')) {
    return Number(cleaned.replace(/,/g, ''))
  }
  if (cleaned.includes(',') && !cleaned.includes('.')) {
    const parts = cleaned.split(',')
    if (parts[parts.length - 1].length !== 3) {
      return Number(cleaned.replace(',', '.'))
    }
    return Number(cleaned.replace(/,/g, ''))
  }
  return Number(cleaned)
}

/**
 * Append one or more whole rows to the given sheet tab.
 * Note: this uses RAW input so callers should provide already-formatted values.
 */
async function appendRows({ sheets, spreadsheetId, title, values }) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('appendRows: values[] is required')
  }
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${title}!A1`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  })
}

// ---- sanity routes
app.get('/ping', (req, res) => res.json({ ok: true }))
app.get('/sheets/test', async (req, res) => {
  try {
    const sheets = await getSheetClient()
    const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID
    const title = process.env.SHEETS_LOG_TITLE || 'Credit Card - Log'
    const { data } = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${title}!A1:Z1`,
    })
    res.json({ title, headers: data.values?.[0] || [] })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: String(e) })
  }
})

// ---------- TESTABLE (NO-AUTH) ROUTE TO FIND SAMPLE PARENT IDS ----------
app.get('/api/log/sample-parents', async (req, res) => {
  try {
    const title = process.env.SHEETS_LOG_TITLE || 'Credit Card - Log'
    const { rows } = await readAllRows(title)
    if (!rows || rows.length < 2) return res.json({ items: [] })

    const headers = rows[0]
    const { norm, map } = indexHeaders(headers)

    const ID       = map[norm('ID')] ?? map['id']
    if (ID == null) return res.status(500).json({ error: 'Missing ID column in sheet' })

    const STATUS   = map[norm('Status')] ?? map['status']
    const AMOUNT   = map[norm('Amount')] ?? map['amount'] ?? map[norm('Total')] ?? map['total']
    const DESC     = map[norm('Transaction Description')] ?? map[norm('Description')] ?? map['description'] ?? map[norm('Vendor')] ?? map['vendor'] ?? map[norm('Merchant')] ?? map['merchant']
    const USERNAME = map[norm('User Name')] ?? map[norm('Username')] ?? map['username'] ?? map['user'] ?? map['userid']

    const items = []
    for (let i = 1; i < rows.length && items.length < 15; i++) {
      const r = rows[i] || []
      const idVal = (r[ID] || '').toString().trim()
      if (!idVal) continue
      items.push({
        id: idVal,
        status: STATUS != null ? (r[STATUS] ?? '') : '',
        amount: AMOUNT != null ? (r[AMOUNT] ?? '') : '',
        description: DESC != null ? (r[DESC] ?? '') : '',
        user: USERNAME != null ? (r[USERNAME] ?? '') : '',
      })
    }

    res.json({ items })
  } catch (e) {
    console.error(e)
    res.status(500).json({ error: String(e) })
  }
})
// -----------------------------------------------------------------------

// ---- auth wall
app.use('/api', requireAuth)

// ---------- PROTECTED ROUTE: SPLIT PREVIEW / APPEND ----------
app.post('/api/log/split', async (req, res) => {
  try {
    // 1) Validate payload
    const check = validateSplitPayload(req.body)
    if (!check.ok) {
      return res.status(422).json({ ok: false, errors: check.errors })
    }

    // 2) Flags
    // dryRun: true by default
    const dryRunParam = req.query.dryRun
    const dryRunBody = req.body?.dryRun
    const dryRun = (dryRunParam !== undefined)
      ? !/^(0|false|no)$/i.test(String(dryRunParam))
      : (dryRunBody === undefined ? true : Boolean(dryRunBody))

    // optional: assign sequential IDs to children (default: false)
    const assignIdsParam = req.query.assignIds
    const assignIdsBody = req.body?.assignIds
    const assignIds = (assignIdsParam !== undefined)
      ? /^(1|true|yes)$/i.test(String(assignIdsParam))
      : Boolean(assignIdsBody)

    // 3) Fetch parent
    const title = process.env.SHEETS_LOG_TITLE || 'Credit Card - Log'
    const { parentId, splits } = req.body
    const parent = await getRowById(title, parentId)
    if (!parent) {
      return res.status(404).json({ ok: false, error: `Parent ID ${parentId} not found` })
    }

    const { headers, row, map, sheets, spreadsheetId } = parent
    const parentSummary = headers.reduce((o, h, i) => (o[h] = row[i] ?? '', o), {})

    // 4) Backend safety: ensure split total does not exceed parent Amount
    const parentAmountNum = parseMoneyToNumber(parentSummary['Amount'])
    const sumSplits = splits.reduce((acc, s) => acc + (parseMoneyToNumber(s.amount) || 0), 0)
    const EPS = 0.0001
    if (!isNaN(parentAmountNum) && sumSplits > parentAmountNum + EPS) {
      return res.status(422).json({
        ok: false,
        errors: [
          `Split total (${sumSplits.toFixed(2)}) exceeds parent Amount (${parentAmountNum.toFixed(2)}).`
        ]
      })
    }

    // 5) Keep your flat preview echo (amount parsed to number)
    const preview = splits.map((s) => ({
      parentId: String(parentId),
      amount: parseMoneyToNumber(s.amount),
      notes: s.notes ?? '',
      jobId: s.jobId ?? '',
      costCode: s.costCode ?? '',
      division: s.division ?? '',
      glAccount: s.glAccount ?? '',
    }))

    // 6) Build children previews (header-keyed objects)
    const childrenPreview = buildChildrenFromParent(
      headers, row, splits, map,
      parent.norm ?? ((x)=>x.toLowerCase().replace(/[^a-z0-9]/g,''))
    )

    // 7) If not dry run: write to sheet (optionally assign IDs), then mark parent = Split
    let appended = 0
    if (!dryRun) {
      const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
      const idIdxInParent = map[norm('ID')] ?? map['id']

      const childrenToWrite = childrenPreview.map(obj => ({ ...obj }))

      if (assignIds) {
        const { idIdx, nextId } = await getNextIdInfo(title)
        if (idIdx != null && nextId != null) {
          let cur = nextId
          for (const obj of childrenToWrite) {
            obj[headers[idIdx]] = String(cur++)
          }
        }
      } else if (idIdxInParent != null) {
        for (const obj of childrenToWrite) {
          obj[headers[idIdxInParent]] = ''
        }
      }

      const values = childrenToWrite.map(obj => toRowValues(headers, obj))

      await appendRows({ sheets, spreadsheetId, title, values })
      appended = values.length

      // Mark parent as Split
      const { headers: hdrs, map: colMap, row: parentRow, rowNum1 } = parent
      const normHdr = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
      const STATUS = colMap[normHdr('Status')] ?? colMap['status']
      if (STATUS != null) {
        const updated = [...parentRow]
        updated[STATUS] = 'Split'
        while (updated.length < hdrs.length) updated.push('')
        await updateWholeRow({
          sheets,
          spreadsheetId,
          title,
          rowNum1,
          values: updated,
        })
      }
    }

    return res.json({ ok: true, dryRun, assignIds, parentSummary, preview, childrenPreview, appended })
  } catch (err) {
    console.error('POST /api/log/split error:', err)
    return res.status(500).json({ error: 'Internal server error' })
  }
})
// ---------------------------------------------------------------

// ---- Split validation (small, dependency-free)
function validateSplitPayload(body) {
  const errors = [];

  if (!body || typeof body !== 'object') {
    return { ok: false, errors: ['Request body must be a JSON object.'] };
  }

  const { parentId, splits } = body;

  if (!parentId || (typeof parentId !== 'string' && typeof parentId !== 'number')) {
    errors.push('parentId is required (string or number).');
  }

  if (!Array.isArray(splits) || splits.length === 0) {
    errors.push('splits must be a non-empty array.');
  } else {
    splits.forEach((s, i) => {
      if (!s || typeof s !== 'object') {
        errors.push(`splits[${i}] must be an object.`);
        return;
      }
      const { amount } = s;

      // ✅ amount: required and numeric (accepts "$30.00", "30.00", 30)
      const n = parseMoneyToNumber(amount)
      if (isNaN(n)) {
        errors.push(`splits[${i}].amount is required and must be a number or money string.`)
      }

      // Optional fields: type guard only
      ;['notes','jobId','costCode','division','glAccount'].forEach((k) => {
        if (s[k] !== undefined && s[k] !== null && typeof s[k] !== 'string' && typeof s[k] !== 'number') {
          errors.push(`splits[${i}].${k} must be string/number if provided.`);
        }
      });
    });
  }

  return { ok: errors.length === 0, errors };
}

// GET /api/log/new — purchaser’s “New”
app.get('/api/log/new', async (req, res) => {
  try {
    const title = process.env.SHEETS_LOG_TITLE
    const { rows } = await readAllRows(title)
    if (rows.length < 2) return res.json({ headers: rows[0] || [], rows: [] })
    const headers = rows[0]
    const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
    const lower = (s) => (s || '').trim().toLowerCase()
    const col = Object.fromEntries(headers.map((h, i) => [norm(h), i]))
    const STATUS = col['status']
    const USERNAME = col['username'] ?? col['user'] ?? col['userid']
    if (STATUS == null || USERNAME == null) {
      return res.status(500).json({ error: 'Missing Status/User Name columns' })
    }
    const me = lower(req.user.email).split('@')[0]
    const filtered = rows.slice(1).filter(r => lower(r[STATUS]) === 'new' && lower(r[USERNAME]) === me)
    const out = filtered.map(r => headers.reduce((o, h, i) => ((o[h] = r[i] ?? ''), o), {}))
    res.json({ headers, rows: out })
  } catch (e) {
    console.error(e); res.status(500).json({ error: String(e) })
  }
})

// GET /api/approvals/submitted — approver queues grouped by purchaser username
app.get('/api/approvals/submitted', async (req, res) => {
  try {
    const title = process.env.SHEETS_LOG_TITLE
    const { rows } = await readAllRows(title)
    if (rows.length < 2) return res.json({ headers: rows[0] || [], groups: [], totalRows: 0 })
    const headers = rows[0]
    const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '')
    const lower = (s) => (s || '').trim().toLowerCase()
    const col = Object.fromEntries(headers.map((h, i) => [norm(h), i]))
    const STATUS = col['status']
    const APPROVER = col['approver'] ?? col['approvedby'] ?? col['manager']
    const USERNAME = col['username'] ?? col['user'] ?? col['userid']
    if (STATUS == null || APPROVER == null || USERNAME == null) {
      return res.status(500).json({ error: 'Missing Status/Approver/User Name columns' })
    }
    const me = lower(req.user.email).split('@')[0]
    const filtered = rows.slice(1).filter(r => lower(r[STATUS]) === 'submitted' && lower(r[APPROVER]) === me)
    const groupsMap = new Map()
    for (const r of filtered) {
      const purchaser = (lower(r[USERNAME]) || '(unknown)')
      if (!groupsMap.has(purchaser)) groupsMap.set(purchaser, [])
      groupsMap.get(purchaser).push(headers.reduce((o, h, i) => ((o[h] = r[i] ?? ''), o), {}))
    }
    const groups = Array.from(groupsMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([purchaser, rows]) => ({ purchaser, rows }))
    res.json({ headers, groups, totalRows: filtered.length })
  } catch (e) {
    console.error(e); res.status(500).json({ error: String(e) })
  }
})

// POST /api/log/submit-batch — set Status=Submitted + write edited fields
app.post('/api/log/submit-batch', async (req, res) => {
  try {
    const title = process.env.SHEETS_LOG_TITLE
    const { items } = req.body || {}
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array required' })
    }
    const { sheets, spreadsheetId, rows } = await readAllRows(title)
    if (rows.length < 2) return res.status(404).json({ error: 'No data' })
    const headers = rows[0]
    const { norm, map } = indexHeaders(headers)
    const ID = map[norm('ID')] ?? map['id']
    const STATUS = map[norm('Status')] ?? map['status']
    if (ID == null || STATUS == null) return res.status(500).json({ error: 'Missing ID/Status' })

    const byId = new Map()
    for (let i = 1; i < rows.length; i++) {
      const idVal = (rows[i][ID] || '').toString().trim()
      if (idVal) byId.set(idVal, i)
    }
    for (const it of items) {
      const idx = byId.get((it.id || '').toString().trim())
      if (idx == null) continue
      const row = [...(rows[idx] || [])]
      const setIf = (name, val) => {
        const c = map[norm(name)]; if (c != null && val !== undefined) row[c] = val
      }
      setIf('Notes', it.notes)
      setIf('Job ID', it.jobId)
      setIf('Cost Code', it.costCodeCode)
      setIf('Division', it.division)
      // Rule: if Job ID chosen, write GL Account = 1300
      if (it.jobId && String(it.jobId).trim()) {
        setIf('GL Account', '1300')
      } else {
        setIf('GL Account', it.glAccountCode)
      }
      row[STATUS] = 'Submitted'
      while (row.length < headers.length) row.push('')
      await updateWholeRow({ sheets, spreadsheetId, title, rowNum1: idx + 1, values: row })
    }
    res.json({ ok: true, updated: items.length })
  } catch (e) { console.error(e); res.status(500).json({ error: String(e) }) }
})

// POST /api/log/approve-batch — set Status=Approved; also persist any edits
app.post('/api/log/approve-batch', async (req, res) => {
  try {
    const title = process.env.SHEETS_LOG_TITLE
    const idsOnly = Array.isArray(req.body?.ids) ? req.body.ids : null
    const items = Array.isArray(req.body?.items) ? req.body.items : null
    if (!idsOnly && !items) return res.status(400).json({ error: 'ids or items required' })

    const { sheets, spreadsheetId, rows } = await readAllRows(title)
    if (rows.length < 2) return res.status(404).json({ error: 'No data' })
    const headers = rows[0]
    const { norm, map } = indexHeaders(headers)
    const ID = map[norm('ID')] ?? map['id']
    const STATUS = map[norm('Status')] ?? map['status']
    if (ID == null || STATUS == null) return res.status(500).json({ error: 'Missing ID/Status' })

    const byId = new Map()
    for (let i = 1; i < rows.length; i++) {
      const idVal = (rows[i][ID] || '').toString().trim()
      if (idVal) byId.set(idVal, i)
    }

    const toProcess = items
      ? items.map(it => ({ id: String(it.id), edits: it }))
      : idsOnly.map(id => ({ id: String(id), edits: null }))

    for (const { id, edits } of toProcess) {
      const idx = byId.get(id)
      if (idx == null) continue
      const row = [...(rows[idx] || [])]
      if (edits) {
        const setIf = (name, val) => {
          const c = map[norm(name)]; if (c != null && val !== undefined) row[c] = val
        }
        setIf('Notes', edits.notes)
        setIf('Job ID', edits.jobId)
        setIf('Cost Code', edits.costCodeCode)
        setIf('Division', edits.division)
        // Rule: if Job ID chosen, force GL = 1300
        if (edits.jobId && String(edits.jobId).trim()) {
          setIf('GL Account', '1300')
        } else {
          setIf('GL Account', edits.glAccountCode)
        }
      }
      row[STATUS] = 'Approved'
      while (row.length < headers.length) row.push('')
      await updateWholeRow({ sheets, spreadsheetId, title, rowNum1: idx + 1, values: row })
    }
    res.json({ ok: true, updated: toProcess.length })
  } catch (e) { console.error(e); res.status(500).json({ error: String(e) }) }
})

// Lookups (Jobs, Cost Codes, GL Accounts, Users)
app.get('/api/lookups', async (req, res) => {
  try {
    const sheets = await getSheetClient()
    const spreadsheetId = process.env.SHEETS_SPREADSHEET_ID

    async function readTab(title, endCol = 'Z', endRow = 10000) {
      const { data } = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: `${title}!A1:${endCol}${endRow}`,
        majorDimension: 'ROWS',
      })
      const rows = data.values || []
      return { headers: rows[0] || [], body: rows.slice(1) }
    }

    const TWO_YEARS_AGO = new Date()
    TWO_YEARS_AGO.setFullYear(TWO_YEARS_AGO.getFullYear() - 2)

    function parseSheetDate(s) {
      if (!s) return null
      const t = String(s).trim()
      const d1 = new Date(t.replace(/-/g, '/'))
      if (!isNaN(d1)) return d1
      const n = Number(t)
      if (!isNaN(n)) {
        const epoch = new Date(Date.UTC(1899, 11, 30))
        return new Date(epoch.getTime() + n * 86400000)
      }
      return null
    }

    // Jobs
    const jobs = await readTab('Feed - Job Master', 'M')
    const jobIds = jobs.body
      .filter(r => { const d = parseSheetDate(r[12]); return d && d >= TWO_YEARS_AGO })
      .map(r => (r[0] || '').toString().trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b))

    // Cost Codes
    const cost = await readTab('Lookup - Cost Codes', 'B')
    const costCodes = cost.body.map(r => {
      const code = (r[0] || '').toString().trim()
      const desc = (r[1] || '').toString().trim()
      return code ? { code, desc, label: desc || code } : null
    }).filter(Boolean).sort((a, b) => a.code.localeCompare(b.code))

    // GL Accounts
    const gl = await readTab('Lookup - GL Accounts', 'B')
    const glAccounts = gl.body.map(r => {
      const code = (r[0] || '').toString().trim()
      const desc = (r[1] || '').toString().trim()
      return code ? { code, desc, label: desc || code } : null
    }).filter(Boolean).sort((a, b) => a.code.localeCompare(b.code))

    // --- Users (A: Username, B: First, C: Last, D: Email) ---
    const users = await readTab('Lookup - Users', 'D')

    // Normalize headers and match flexibly
    const norm = s => (s || '').toString().trim().toLowerCase().replace(/[^a-z0-9]/g, '')
    const heads = (users.headers || []).map(norm)
    const findIdx = (...candidates) => {
      const want = candidates.map(norm)
      for (let i = 0; i < heads.length; i++) {
        if (want.includes(heads[i])) return i
      }
      return -1
    }

    const iUsername  = findIdx('username', 'user', 'userid')
    const iFirstName = findIdx('firstname', 'first')
    const iLastName  = findIdx('lastname', 'last')
    const iFullName  = findIdx('fullname', 'name', 'employee')
    const iEmail     = findIdx('email', 'mail')

    const usersByEmail = {}
    const usersByUsername = {}

    for (const r of users.body) {
      const username = (iUsername !== -1 ? (r[iUsername] ?? '') : '').toString().trim().toLowerCase()
      const email    = (iEmail    !== -1 ? (r[iEmail]    ?? '') : '').toString().trim().toLowerCase()

      let first = '', last = '', full = ''
      if (iFirstName !== -1 || iLastName !== -1) {
        first = (r[iFirstName] ?? '').toString().trim()
        last  = (r[iLastName]  ?? '').toString().trim()
        full  = [first, last].filter(Boolean).join(' ').trim()
      } else if (iFullName !== -1) {
        full = (r[iFullName] ?? '').toString().trim()
        const parts = full.split(/\s+/)
        first = parts[0] || ''
        last  = parts.slice(1).join(' ')
      }

      if (!username && !email) continue
      const u = { username, first, last, full, email }
      if (username) usersByUsername[username] = u
      if (email)    usersByEmail[email] = u
    }

    res.json({ jobIds, costCodes, glAccounts, usersByEmail, usersByUsername })
  } catch (e) { console.error(e); res.status(500).json({ error: String(e) }) }
})

const port = process.env.PORT || 8787
app.listen(port, () => console.log(`✅ API running on http://localhost:${port}`))