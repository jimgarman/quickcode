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

// ---- auth wall
app.use('/api', requireAuth)

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
        first = (iFirstName !== -1 ? (r[iFirstName] ?? '') : '').toString().trim()
        last  = (iLastName  !== -1 ? (r[iLastName]  ?? '') : '').toString().trim()
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