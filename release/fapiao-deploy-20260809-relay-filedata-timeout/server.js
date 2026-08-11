const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');

const reviewMaxFiles = 5;
const reviewMaxBytes = 25 * 1024 * 1024;
// The deployed project uses the configured OpenAI-compatible relay by default.
// Both values remain overrideable through environment variables.
const openAiBaseUrl = (String(process.env.OPENAI_BASE_URL || 'https://ergouzi.life/v1').trim() || 'https://ergouzi.life/v1').replace(/\/$/, '');
const openAiReviewModel = String(process.env.OPENAI_REVIEW_MODEL || '').trim() || 'gpt-5.4';

const app = express();
const port = Number(process.env.PORT || 3000);
const root = __dirname;
const dataDir = path.join(root, 'data');
const uploadDir = path.join(root, 'uploads');
const secretPath = path.join(dataDir, 'session-secret.key');

fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });
if (!fs.existsSync(secretPath)) fs.writeFileSync(secretPath, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
const jwtSecret = fs.readFileSync(secretPath, 'utf8').trim();
const db = new Database(path.join(dataDir, 'invoice.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL COLLATE NOCASE,
    phone TEXT,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin', 'staff')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(name, role)
  );
  CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_name TEXT NOT NULL,
    stored_name TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    attachment_id INTEGER NOT NULL REFERENCES attachments(id),
    amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
    purpose TEXT NOT NULL,
    receipt_type TEXT NOT NULL CHECK(receipt_type IN ('invoice', 'image')),
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'reimbursed', 'rejected')),
    submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reimbursed_at TEXT,
    reimbursed_by INTEGER REFERENCES users(id),
    rejected_at TEXT,
    rejected_by INTEGER REFERENCES users(id)
  );
  CREATE TABLE IF NOT EXISTS work_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    report_type TEXT NOT NULL CHECK(report_type IN ('daily', 'weekly')),
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    content TEXT NOT NULL,
    details_json TEXT,
    attachment_id INTEGER,
    submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

const userColumns = db.prepare("PRAGMA table_info('users')").all().map(column => column.name);
if (!userColumns.includes('phone')) db.exec('ALTER TABLE users ADD COLUMN phone TEXT');

const knownPhones = {
  '何嘉欣': '13036102593',
  '王博康': '15387047769',
  '徐静怡': '18892474582',
  '吕伟伟': '15671587026',
  '宋紫曦': '15927355711',
  '张丽昕': '1832718918'
};
const seedPhone = db.prepare('UPDATE users SET phone = ? WHERE name = ? COLLATE NOCASE AND (phone IS NULL OR phone = \'\')');
for (const [name, phone] of Object.entries(knownPhones)) seedPhone.run(phone, name);

const workReportColumns = db.prepare("PRAGMA table_info('work_reports')").all().map(column => column.name);
if (!workReportColumns.includes('details_json')) db.exec('ALTER TABLE work_reports ADD COLUMN details_json TEXT');
if (!workReportColumns.includes('attachment_id')) db.exec('ALTER TABLE work_reports ADD COLUMN attachment_id INTEGER');

const reportUniqueIndex = db.prepare("PRAGMA index_list('work_reports')").all().find(index => {
  if (!index.unique) return false;
  const columns = db.prepare(`PRAGMA index_info('${index.name.replace(/'/g, "''")}')`).all().map(column => column.name);
  return columns.includes('user_id') && columns.includes('report_type') && columns.includes('period_start');
});
if (reportUniqueIndex) {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE work_reports_next (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        report_type TEXT NOT NULL CHECK(report_type IN ('daily', 'weekly')),
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        content TEXT NOT NULL,
        details_json TEXT,
        attachment_id INTEGER,
        submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO work_reports_next (id, user_id, report_type, period_start, period_end, content, details_json, attachment_id, submitted_at)
      SELECT id, user_id, report_type, period_start, period_end, content, details_json, attachment_id, submitted_at FROM work_reports;
      DROP TABLE work_reports;
      ALTER TABLE work_reports_next RENAME TO work_reports;
    `);
  })();
  db.pragma('foreign_keys = ON');
}

// Preserve all existing expenses while allowing an administrator to reject an application.
const expenseTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'expenses'").get()?.sql || '';
if (!expenseTableSql.includes("'rejected'")) {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE expenses_next (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        attachment_id INTEGER NOT NULL REFERENCES attachments(id),
        amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
        purpose TEXT NOT NULL,
        receipt_type TEXT NOT NULL CHECK(receipt_type IN ('invoice', 'image')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'reimbursed', 'rejected')),
        submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        reimbursed_at TEXT,
        reimbursed_by INTEGER REFERENCES users(id),
        rejected_at TEXT,
        rejected_by INTEGER REFERENCES users(id)
      );
      INSERT INTO expenses_next (id, user_id, attachment_id, amount_cents, purpose, receipt_type, status, submitted_at, reimbursed_at, reimbursed_by)
      SELECT id, user_id, attachment_id, amount_cents, purpose, receipt_type, status, submitted_at, reimbursed_at, reimbursed_by FROM expenses;
      DROP TABLE expenses;
      ALTER TABLE expenses_next RENAME TO expenses;
    `);
  })();
  db.pragma('foreign_keys = ON');
}

db.exec(`
  CREATE TABLE IF NOT EXISTS expense_attachments (
    expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    attachment_id INTEGER NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (expense_id, attachment_id)
  );
  CREATE INDEX IF NOT EXISTS idx_expense_attachments_attachment ON expense_attachments(attachment_id);
`);
db.prepare('INSERT OR IGNORE INTO expense_attachments (expense_id, attachment_id) SELECT id, attachment_id FROM expenses').run();

// Reports created before multi-file support keep their original attachment through this migration.
db.exec(`
  CREATE TABLE IF NOT EXISTS work_report_attachments (
    report_id INTEGER NOT NULL REFERENCES work_reports(id) ON DELETE CASCADE,
    attachment_id INTEGER NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (report_id, attachment_id)
  );
  CREATE INDEX IF NOT EXISTS idx_work_report_attachments_attachment ON work_report_attachments(attachment_id);
`);
db.prepare('INSERT OR IGNORE INTO work_report_attachments (report_id, attachment_id) SELECT id, attachment_id FROM work_reports WHERE attachment_id IS NOT NULL').run();

// A review is written only when the employee confirms submission after the preview.
db.exec(`
  CREATE TABLE IF NOT EXISTS work_report_reviews (
    report_id INTEGER PRIMARY KEY REFERENCES work_reports(id) ON DELETE CASCADE,
    score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100),
    summary TEXT NOT NULL,
    strengths_json TEXT NOT NULL DEFAULT '[]',
    issues_json TEXT NOT NULL DEFAULT '[]',
    suggestions_json TEXT NOT NULL DEFAULT '[]',
    model TEXT,
    reviewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);

// Upgrade databases created before role-based duplicate names and remove legacy bank fields.
const uniqueNameIndex = db.prepare("PRAGMA index_list('users')").all().find(index => {
  if (!index.unique) return false;
  const columns = db.prepare(`PRAGMA index_info('${index.name.replace(/'/g, "''")}')`).all().map(column => column.name);
  return columns.length === 1 && columns[0] === 'name';
});
const legacyBankFields = db.prepare("PRAGMA table_info('users')").all().some(column => ['bank_name', 'bank_account'].includes(column.name));
if (uniqueNameIndex || legacyBankFields) {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`
      CREATE TABLE users_next (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL COLLATE NOCASE,
        phone TEXT,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin', 'staff')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(name, role)
      );
      INSERT INTO users_next (id, name, phone, password_hash, role, created_at)
      SELECT id, name, phone, password_hash, role, created_at FROM users;
      DROP TABLE users;
      ALTER TABLE users_next RENAME TO users;
    `);
  })();
  db.pragma('foreign_keys = ON');
}

app.use(express.json({ limit: '100kb' }));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 20 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    const isDocx = file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || path.extname(file.originalname || '').toLowerCase() === '.docx';
    const accepted = allowed.includes(file.mimetype) || isDocx;
    cb(accepted ? null : new Error('仅支持 JPG、PNG、WEBP、PDF 或 DOCX 文件。'), accepted);
  }
});
const expenseUpload = upload.fields([{ name: 'attachments', maxCount: 20 }, { name: 'attachment', maxCount: 1 }]);
const reportUpload = upload.fields([{ name: 'attachments', maxCount: 5 }, { name: 'attachment', maxCount: 1 }]);
const reviewUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: reviewMaxFiles },
  fileFilter: (_req, file, cb) => {
    const extension = path.extname(file.originalname || '').toLowerCase();
    const accepted = file.mimetype === 'application/pdf'
      || file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      || extension === '.pdf' || extension === '.docx';
    cb(accepted ? null : new Error('智能审核仅支持 PDF 或 DOCX 周报文档。'), accepted);
  }
}).array('attachments', reviewMaxFiles);

function normalizedAttachmentName(originalName) {
  const name = path.basename(String(originalName || '附件'));
  // Multer receives non-ASCII multipart filenames as Latin-1 in some browsers.
  if (![...name].every(char => char.codePointAt(0) <= 0xff)) return name;
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('\ufffd') ? name : decoded;
}

function saveAttachment(file) {
  return db.prepare('INSERT INTO attachments (original_name, stored_name, mime_type, file_size) VALUES (?, ?, ?, ?)')
    .run(normalizedAttachmentName(file.originalname), file.filename, file.mimetype, file.size).lastInsertRowid;
}

const getWorkReportAttachments = db.prepare(`
  SELECT a.id, a.original_name, a.mime_type, a.file_size
  FROM work_report_attachments wra
  JOIN attachments a ON a.id = wra.attachment_id
  WHERE wra.report_id = ?
  ORDER BY wra.created_at, a.id
`);

function workReportAttachments(reportId) {
  return getWorkReportAttachments.all(reportId).map(attachment => ({
    id: attachment.id,
    name: attachment.original_name,
    mimeType: attachment.mime_type,
    size: attachment.file_size
  }));
}

function removeUnusedAttachments(attachmentIds) {
  const hasReferences = db.prepare(`
    SELECT 1
    FROM attachments a
    WHERE a.id = ? AND (
      EXISTS (SELECT 1 FROM expenses e WHERE e.attachment_id = a.id)
      OR EXISTS (SELECT 1 FROM expense_attachments ea WHERE ea.attachment_id = a.id)
      OR EXISTS (SELECT 1 FROM work_reports r WHERE r.attachment_id = a.id)
      OR EXISTS (SELECT 1 FROM work_report_attachments wra WHERE wra.attachment_id = a.id)
    )
  `);
  const getAttachment = db.prepare('SELECT stored_name FROM attachments WHERE id = ?');
  const deleteAttachment = db.prepare('DELETE FROM attachments WHERE id = ?');
  [...new Set(attachmentIds)].forEach(attachmentId => {
    if (hasReferences.get(attachmentId)) return;
    const attachment = getAttachment.get(attachmentId);
    if (!attachment) return;
    deleteAttachment.run(attachmentId);
    fs.rm(path.join(uploadDir, attachment.stored_name), { force: true }, () => {});
  });
}

const updateAttachmentName = db.prepare('UPDATE attachments SET original_name = ? WHERE id = ?');
db.prepare('SELECT id, original_name FROM attachments').all().forEach(attachment => {
  const name = normalizedAttachmentName(attachment.original_name);
  if (name !== attachment.original_name) updateAttachmentName.run(name, attachment.id);
});

function removeUploadedFiles(files) {
  files.filter(Boolean).forEach(file => fs.rm(file.path, { force: true }, () => {}));
}

function expenseFiles(req) {
  return [...(req.files?.attachments || []), ...(req.files?.attachment || [])];
}

function reportFiles(req) {
  return [...(req.files?.attachments || []), ...(req.files?.attachment || [])];
}

function isWeeklyDocument(file) {
  const extension = path.extname(file.originalname || '').toLowerCase();
  return file.mimetype === 'application/pdf'
    || file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    || extension === '.pdf' || extension === '.docx';
}

function attachmentFile(attachment) {
  const stored = db.prepare('SELECT id, original_name, stored_name, mime_type, file_size FROM attachments WHERE id = ?').get(attachment.id);
  if (!stored) throw new Error('周报已有附件不存在，请刷新页面后重试。');
  const filePath = path.join(uploadDir, stored.stored_name);
  if (!fs.existsSync(filePath)) throw new Error(`找不到附件“${stored.original_name}”，无法进行审核。`);
  return {
    originalname: stored.original_name,
    mimetype: stored.mime_type,
    size: stored.file_size,
    buffer: fs.readFileSync(filePath),
    fingerprint: `saved:${stored.id}:${crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')}`
  };
}

function uploadedReviewFile(file) {
  return {
    originalname: normalizedAttachmentName(file.originalname),
    mimetype: file.mimetype,
    size: file.size,
    buffer: file.buffer,
    fingerprint: `new:${crypto.createHash('sha256').update(file.buffer).digest('hex')}`
  };
}

function storedUploadReviewFile(file) {
  const buffer = fs.readFileSync(file.path);
  return {
    originalname: normalizedAttachmentName(file.originalname),
    mimetype: file.mimetype,
    size: file.size,
    buffer,
    fingerprint: `new:${crypto.createHash('sha256').update(buffer).digest('hex')}`
  };
}

function reviewInputHash({ periodStart, periodEnd, reportId, files }) {
  return crypto.createHash('sha256').update(JSON.stringify({
    periodStart,
    periodEnd,
    reportId: Number(reportId || 0),
    files: files.map(file => file.fingerprint).sort()
  })).digest('hex');
}

function parseReviewResult(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object') throw new Error('智能审核返回格式无效，请重试。');
  const compactList = input => Array.isArray(input)
    ? input.map(item => String(item || '').trim()).filter(Boolean).slice(0, 6)
    : [];
  const score = Number(parsed.score);
  const summary = String(parsed.summary || '').trim();
  const decision = parsed.decision === 'needs_revision' ? 'needs_revision' : 'recommend_submit';
  if (!Number.isInteger(score) || score < 0 || score > 100 || !summary) throw new Error('智能审核返回内容不完整，请重试。');
  return {
    score,
    summary: summary.slice(0, 1600),
    strengths: compactList(parsed.strengths),
    issues: compactList(parsed.issues),
    suggestions: compactList(parsed.suggestions),
    decision
  };
}

function verifiedWeeklyReview({ reviewToken, userId, periodStart, periodEnd, reportId, existingAttachmentIds, uploadedFiles }) {
  if (!reviewToken) {
    const error = new Error('请先完成智能审核，再提交周报。');
    error.status = 400;
    throw error;
  }
  let payload;
  try { payload = jwt.verify(reviewToken, jwtSecret); } catch {
    const error = new Error('审核结果已过期，请重新审核后提交。');
    error.status = 400;
    throw error;
  }
  if (payload.purpose !== 'weekly-review' || payload.userId !== userId) {
    const error = new Error('审核结果与当前账号不匹配，请重新审核。');
    error.status = 400;
    throw error;
  }
  const files = [
    ...existingAttachmentIds.map(id => attachmentFile({ id })),
    ...uploadedFiles.map(storedUploadReviewFile)
  ];
  const inputHash = reviewInputHash({ periodStart, periodEnd, reportId, files });
  if (payload.inputHash !== inputHash) {
    const error = new Error('周报文件或日期已变更，请重新审核后提交。');
    error.status = 400;
    throw error;
  }
  return { review: parseReviewResult(payload.review), model: String(payload.model || openAiReviewModel) };
}

function saveWorkReportReview(reportId, review, model) {
  db.prepare(`
    INSERT INTO work_report_reviews (report_id, score, summary, strengths_json, issues_json, suggestions_json, model, reviewed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(report_id) DO UPDATE SET
      score = excluded.score,
      summary = excluded.summary,
      strengths_json = excluded.strengths_json,
      issues_json = excluded.issues_json,
      suggestions_json = excluded.suggestions_json,
      model = excluded.model,
      reviewed_at = CURRENT_TIMESTAMP
  `).run(reportId, review.score, review.summary, JSON.stringify(review.strengths), JSON.stringify(review.issues), JSON.stringify(review.suggestions), model);
}

async function requestWeeklyReview(files) {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) {
    const error = new Error('尚未配置 OPENAI_API_KEY，暂时无法进行智能审核。');
    error.status = 503;
    throw error;
  }
  if (files.length < 1) {
    const error = new Error('请至少上传 1 个周报文档后再审核。');
    error.status = 400;
    throw error;
  }
  if (files.length > reviewMaxFiles || files.reduce((sum, file) => sum + file.size, 0) > reviewMaxBytes) {
    const error = new Error('一次审核最多 5 个文档，合计不超过 25MB。');
    error.status = 400;
    throw error;
  }

  const controller = new AbortController();
  // Document review through a relay can take longer than a normal API call.
  const timeout = setTimeout(() => controller.abort(), 180_000);
  try {
    // Some OpenAI-compatible relays do not implement /files. Send documents
    // inline with Responses file_data so both official and relay endpoints work.
    const inputFiles = files.map(file => ({
      type: 'input_file',
      filename: file.originalname,
      file_data: `data:${file.mimetype};base64,${file.buffer.toString('base64')}`
    }));
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        score: { type: 'integer', minimum: 0, maximum: 100 },
        summary: { type: 'string' },
        strengths: { type: 'array', items: { type: 'string' } },
        issues: { type: 'array', items: { type: 'string' } },
        suggestions: { type: 'array', items: { type: 'string' } },
        decision: { type: 'string', enum: ['recommend_submit', 'needs_revision'] }
      },
      required: ['score', 'summary', 'strengths', 'issues', 'suggestions', 'decision']
    };
    const reviewResponse = await fetch(`${openAiBaseUrl}/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: openAiReviewModel,
        input: [{
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: '你是企业周报审核助手。仅依据所附周报文件给出客观、可执行的反馈。评分范围 0-100，重点评估：工作成果是否具体、过程是否清晰、问题与后续计划是否可追踪、文档表达是否完整。不要编造文件中没有的事实；信息不足时应明确指出。使用简体中文。decision 为 recommend_submit 或 needs_revision。'
            },
            ...inputFiles
          ]
        }],
        text: { format: { type: 'json_schema', name: 'weekly_report_review', strict: true, schema } }
      }),
      signal: controller.signal
    });
    const reviewData = await reviewResponse.json().catch(() => ({}));
    if (!reviewResponse.ok) {
      const apiMessage = reviewData?.error?.message || reviewData?.message || `HTTP ${reviewResponse.status}`;
      const error = new Error(`智能审核服务调用失败：${apiMessage}`);
      error.status = reviewResponse.status === 401 || reviewResponse.status === 403 ? 503 : 502;
      throw error;
    }
    const outputText = reviewData.output_text
      || reviewData.output?.flatMap(item => item.content || []).find(item => item.type === 'output_text')?.text
      || reviewData.output?.flatMap(item => item.content || []).find(item => typeof item.text === 'string')?.text;
    return parseReviewResult(outputText);
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('智能审核超时，请稍后重试。');
      timeoutError.status = 504;
      throw timeoutError;
    }
    if (!error.status) {
      error.status = 502;
      error.message = `智能审核失败：${error.message || '请检查服务器环境变量'}`;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function getCookies(req) {
  return Object.fromEntries((req.headers.cookie || '').split(';').filter(Boolean).map(part => {
    const index = part.indexOf('=');
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }));
}

function requireAuth(req, res, next) {
  try {
    req.user = jwt.verify(getCookies(req).invoice_session, jwtSecret);
    next();
  } catch {
    res.status(401).json({ error: '登录已失效，请重新登录。' });
  }
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可执行此操作。' });
  next();
}

function sessionUser(user) {
  return { id: user.id, name: user.name, phone: user.phone || '', role: user.role };
}

function setSession(res, user) {
  const token = jwt.sign({ id: user.id, name: user.name, phone: user.phone || '', role: user.role }, jwtSecret, { expiresIn: '30d' });
  res.cookie('invoice_session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/'
  });
}

function validateRegistration({ name, password, role }) {
  if (!name || name.trim().length < 2 || name.trim().length > 30) return '姓名需为 2 至 30 个字符。';
  if (!password || password.length < 6 || password.length > 72) return '密码需为 6 至 72 个字符。';
  if (!['admin', 'staff'].includes(role)) return '请选择账号身份。';
  return null;
}

app.get('/api/auth/setup-status', (_req, res) => {
  const count = db.prepare('SELECT COUNT(*) AS count FROM users').get().count;
  res.json({ hasUsers: count > 0 });
});

function validatePhone(phone) {
  return /^1\d{9,10}$/.test(String(phone || '').trim()) ? null : '请输入有效的手机号。';
}

app.post('/api/auth/register', (req, res, next) => {
  try {
    const { name, phone, role } = req.body || {};
    if (!name || name.trim().length < 2 || name.trim().length > 30) return res.status(400).json({ error: '姓名需为 2 至 30 个字符。' });
    const phoneError = validatePhone(phone);
    if (phoneError) return res.status(400).json({ error: phoneError });
    if (!['admin', 'staff'].includes(role)) return res.status(400).json({ error: '请选择账号身份。' });
    const firstUser = db.prepare('SELECT COUNT(*) AS count FROM users').get().count === 0;
    if (firstUser && role !== 'admin') return res.status(400).json({ error: '首个账号必须选择管理员。' });
    if (!firstUser && role === 'admin') return res.status(403).json({ error: '管理员账号只能在系统首次初始化时创建。' });
    const result = db.prepare('INSERT INTO users (name, phone, password_hash, role) VALUES (?, ?, ?, ?)').run(name.trim(), phone.trim(), '', role);
    const saved = { id: result.lastInsertRowid, name: name.trim(), phone: phone.trim(), role };
    setSession(res, saved);
    res.status(201).json({ user: sessionUser(saved), firstAdmin: firstUser });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return res.status(409).json({ error: '该姓名和身份已注册，请直接登录。' });
    next(error);
  }
});

app.post('/api/auth/login', (req, res, next) => {
  try {
    const { name, phone, role } = req.body || {};
    const user = db.prepare('SELECT * FROM users WHERE name = ? COLLATE NOCASE AND role = ?').get((name || '').trim(), role);
    if (!user || !user.phone || user.phone !== String(phone || '').trim()) return res.status(401).json({ error: '姓名、手机号或身份错误。' });
    setSession(res, user);
    res.json({ user: sessionUser(user) });
  } catch (error) { next(error); }
});

app.post('/api/auth/register-legacy', async (req, res, next) => {
  try {
    const { name, password, role } = req.body || {};
    const error = validateRegistration({ name, password, role });
    if (error) return res.status(400).json({ error });
    const firstUser = db.prepare('SELECT COUNT(*) AS count FROM users').get().count === 0;
    if (firstUser && role !== 'admin') return res.status(400).json({ error: '首个账号必须选择管理员，用于审核后续报销。' });
    if (!firstUser && role === 'admin') return res.status(403).json({ error: '管理员账号仅能在系统首次初始化时创建。' });
    const user = { name: name.trim(), passwordHash: await bcrypt.hash(password, 12), role };
    const insert = db.prepare('INSERT INTO users (name, password_hash, role) VALUES (?, ?, ?)');
    const result = insert.run(user.name, user.passwordHash, user.role);
    const saved = { id: result.lastInsertRowid, name: user.name, password_hash: user.passwordHash, role: user.role };
    setSession(res, saved);
    res.status(201).json({ user: sessionUser(saved), firstAdmin: firstUser });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return res.status(409).json({ error: '该姓名已注册，请直接登录。' });
    next(error);
  }
});

app.post('/api/auth/login-legacy', async (req, res, next) => {
  try {
    const { name, password, role } = req.body || {};
    const user = db.prepare('SELECT * FROM users WHERE name = ? COLLATE NOCASE AND role = ?').get((name || '').trim(), role);
    if (!user || !(await bcrypt.compare(password || '', user.password_hash))) return res.status(401).json({ error: '姓名或密码错误。' });
    setSession(res, user);
    res.json({ user: sessionUser(user) });
  } catch (error) { next(error); }
});

app.post('/api/auth/logout', (_req, res) => {
  res.clearCookie('invoice_session', { path: '/' });
  res.status(204).end();
});

app.get('/api/auth/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(401).json({ error: '账号不存在。' });
  res.json({ user: sessionUser(user) });
});

app.patch('/api/profile', requireAuth, (req, res, next) => {
  try {
    if (req.user.role !== 'staff') return res.status(403).json({ error: '仅普通人员可修改个人资料。' });
    const { name, phone } = req.body || {};
    if (!name || name.trim().length < 2 || name.trim().length > 30) return res.status(400).json({ error: '姓名需为 2 至 30 个字符。' });
    const phoneError = validatePhone(phone);
    if (phoneError) return res.status(400).json({ error: phoneError });
    db.prepare('UPDATE users SET name = ?, phone = ? WHERE id = ?').run(name.trim(), phone.trim(), req.user.id);
    const saved = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    setSession(res, saved);
    res.json({ user: sessionUser(saved) });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return res.status(409).json({ error: '该姓名的普通人员账号已存在。' });
    next(error);
  }
});

app.patch('/api/profile-legacy', requireAuth, async (req, res, next) => {
  try {
    if (req.user.role !== 'staff') return res.status(403).json({ error: '仅普通人员可修改个人资料。' });
    const { name, password } = req.body || {};
    if (!name || name.trim().length < 2 || name.trim().length > 30) return res.status(400).json({ error: '姓名需为 2 至 30 个字符。' });
    if (password && (password.length < 6 || password.length > 72)) return res.status(400).json({ error: '新密码需为 6 至 72 个字符。' });
    const current = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const passwordHash = password ? await bcrypt.hash(password, 12) : current.password_hash;
    db.prepare('UPDATE users SET name = ?, password_hash = ? WHERE id = ?')
      .run(name.trim(), passwordHash, req.user.id);
    const saved = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    setSession(res, saved);
    res.json({ user: sessionUser(saved) });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return res.status(409).json({ error: '该姓名的普通人员账号已存在。' });
    next(error);
  }
});

function isDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

function formatReport(row) {
  return {
    id: row.id,
    type: row.report_type,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    content: row.content,
    submittedAt: row.submitted_at,
    user: { id: row.user_id, name: row.user_name }
  };
}

function formatDetailedReport(row) {
  let sections;
  try { sections = row.details_json ? JSON.parse(row.details_json) : null; } catch { sections = null; }
  sections = sections && typeof sections === 'object' ? sections : { completion: row.content || '', learning: '', blockers: '', solutions: '' };
  const attachments = workReportAttachments(row.id);
  return {
    id: row.id, type: row.report_type, periodStart: row.period_start, periodEnd: row.period_end,
    content: row.content, sections, submittedAt: row.submitted_at,
    user: { id: row.user_id, name: row.user_name },
    attachment: attachments[0] || null,
    attachments,
    review: row.review_score === null || row.review_score === undefined ? null : {
      score: row.review_score,
      summary: row.review_summary,
      strengths: safeJsonList(row.review_strengths_json),
      issues: safeJsonList(row.review_issues_json),
      suggestions: safeJsonList(row.review_suggestions_json),
      model: row.review_model,
      reviewedAt: row.reviewed_at
    }
  };
}

function safeJsonList(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map(item => String(item || '')).filter(Boolean) : [];
  } catch { return []; }
}

const detailedReportQuery = `
  SELECT r.*, u.id AS user_id, u.name AS user_name,
    a.id AS report_attachment_id, a.original_name AS report_attachment_name,
    a.mime_type AS report_attachment_mime, a.file_size AS report_attachment_size,
    rr.score AS review_score, rr.summary AS review_summary,
    rr.strengths_json AS review_strengths_json, rr.issues_json AS review_issues_json,
    rr.suggestions_json AS review_suggestions_json, rr.model AS review_model, rr.reviewed_at
  FROM work_reports r JOIN users u ON u.id = r.user_id
  LEFT JOIN attachments a ON a.id = r.attachment_id
  LEFT JOIN work_report_reviews rr ON rr.report_id = r.id
`;

app.get('/api/work-reports', requireAuth, (req, res) => {
  const rows = req.user.role === 'admin'
    ? db.prepare(`${detailedReportQuery} ORDER BY u.name COLLATE NOCASE, r.period_start DESC, r.submitted_at DESC`).all()
    : db.prepare(`${detailedReportQuery} WHERE r.user_id = ? ORDER BY r.period_start DESC, r.submitted_at DESC`).all(req.user.id);
  res.json({ reports: rows.map(formatDetailedReport) });
});

app.get('/api/report-square', requireAuth, (_req, res) => {
  const rows = db.prepare(`${detailedReportQuery} ORDER BY r.period_start DESC, r.submitted_at DESC, u.name COLLATE NOCASE`).all();
  res.json({ reports: rows.map(formatDetailedReport) });
});

function excelText(value) {
  const text = String(value || '');
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}

function exportReportSections(row) {
  try {
    const sections = row.details_json ? JSON.parse(row.details_json) : null;
    if (sections && typeof sections === 'object') return sections;
  } catch {}
  return { completion: row.content || '', learning: '', blockers: '', solutions: '' };
}

app.get('/api/work-reports/export', requireAuth, async (req, res, next) => {
  try {
    const periodStart = String(req.query.start || '');
    const periodEnd = String(req.query.end || '');
    if (!isDate(periodStart) || !isDate(periodEnd) || periodEnd < periodStart) {
      return res.status(400).json({ error: '请选择正确的导出开始和结束日期。' });
    }

    let owner = { id: req.user.id, name: req.user.name };
    if (req.user.role === 'admin') {
      const userId = Number(req.query.userId);
      if (!Number.isInteger(userId) || userId < 1) return res.status(400).json({ error: '请先选择需要导出的员工。' });
      owner = db.prepare("SELECT id, name FROM users WHERE id = ? AND role = 'staff'").get(userId);
      if (!owner) return res.status(404).json({ error: '该员工不存在，或不是普通人员。' });
    }

    const rows = db.prepare(`${detailedReportQuery}
      WHERE r.user_id = ? AND r.period_start <= ? AND r.period_end >= ?
      ORDER BY r.period_start ASC, r.submitted_at ASC
    `).all(owner.id, periodEnd, periodStart);
    if (!rows.length) return res.status(404).json({ error: '所选时间区间内没有日报或周报。' });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = '票据台账';
    workbook.created = new Date();
    const forwardedProto = String(req.get('x-forwarded-proto') || req.protocol).split(',')[0].trim();
    const attachmentBaseUrl = `${forwardedProto}://${req.get('host')}`;
    const sheet = workbook.addWorksheet('日报周报', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = [
      { header: '类型', key: 'type', width: 11 },
      { header: '汇报周期', key: 'period', width: 25 },
      { header: '完成内容', key: 'completion', width: 36 },
      { header: '学习收获', key: 'learning', width: 30 },
      { header: '卡点 / 不懂问题', key: 'blockers', width: 30 },
      { header: '解决办法（笔记）', key: 'solutions', width: 34 },
      { header: '附件名称', key: 'attachment', width: 28 },
      { header: '审核评分', key: 'reviewScore', width: 12 },
      { header: '审核结论', key: 'reviewDecision', width: 16 },
      { header: '审核分析', key: 'reviewSummary', width: 42 },
      { header: '修改建议', key: 'reviewSuggestions', width: 42 },
      { header: '审核时间', key: 'reviewedAt', width: 22 },
      { header: '提交时间', key: 'submittedAt', width: 22 }
    ];

    const attachmentRows = [];
    rows.forEach(row => {
      const sections = exportReportSections(row);
      const attachments = workReportAttachments(row.id);
      const attachmentLinks = attachments.map(attachment => {
        const exportToken = jwt.sign({ attachmentId: attachment.id, purpose: 'attachment-export' }, jwtSecret, { expiresIn: '7d' });
        const url = `${attachmentBaseUrl}/api/attachments/${attachment.id}?exportToken=${encodeURIComponent(exportToken)}`;
        attachmentRows.push({ row, attachment, url });
        return { attachment, url };
      });
      const attachmentLabel = attachments.map(attachment => attachment.name).join('、') || row.report_attachment_name;
      const review = row.review_score === null || row.review_score === undefined ? null : {
        score: row.review_score,
        summary: row.review_summary,
        suggestions: safeJsonList(row.review_suggestions_json),
        issues: safeJsonList(row.review_issues_json)
      };
      const addedSheetRow = sheet.addRow({
        type: row.report_type === 'daily' ? '日报' : '周报',
        period: row.report_type === 'daily' ? row.period_start : `${row.period_start} 至 ${row.period_end}`,
        completion: excelText(sections.completion),
        learning: excelText(sections.learning),
        blockers: excelText(sections.blockers),
        solutions: excelText(sections.solutions),
        attachment: attachmentLinks[0] ? { text: attachmentLabel, hyperlink: attachmentLinks[0].url } : excelText(attachmentLabel),
        reviewScore: review ? review.score : '',
        reviewDecision: review ? (review.issues.length ? '建议修改' : '可提交') : '',
        reviewSummary: excelText(review?.summary || ''),
        reviewSuggestions: excelText(review?.suggestions.join('；') || ''),
        reviewedAt: row.reviewed_at ? String(row.reviewed_at).replace('T', ' ').replace('Z', '') : '',
        submittedAt: row.submitted_at ? String(row.submitted_at).replace('T', ' ').replace('Z', '') : ''
      });
      if (attachmentLinks[0]) addedSheetRow.getCell('attachment').font = { color: { argb: 'FF1677FF' }, underline: true };
    });

    sheet.getRow(1).height = 24;
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2D7D6B' } };
    sheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
    sheet.eachRow((row, rowNumber) => {
      row.alignment = { vertical: 'top', wrapText: true };
      if (rowNumber > 1) row.height = 48;
      row.eachCell(cell => {
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFD7E7E2' } },
          left: { style: 'thin', color: { argb: 'FFD7E7E2' } },
          bottom: { style: 'thin', color: { argb: 'FFD7E7E2' } },
          right: { style: 'thin', color: { argb: 'FFD7E7E2' } }
        };
      });
    });

    const attachmentSheet = workbook.addWorksheet('附件');
    attachmentSheet.columns = [
      { header: '汇报日期', key: 'period', width: 25 },
      { header: '类型', key: 'type', width: 11 },
      { header: '附件名称（点击打开）', key: 'name', width: 42 },
      { header: '附件地址', key: 'url', width: 70 }
    ];
    attachmentRows.forEach(({ row, attachment, url }) => {
      const added = attachmentSheet.addRow({
        period: row.report_type === 'daily' ? row.period_start : `${row.period_start} 至 ${row.period_end}`,
        type: row.report_type === 'daily' ? '日报' : '周报',
        name: { text: attachment.name, hyperlink: url },
        url
      });
      added.getCell('name').font = { color: { argb: 'FF1677FF' }, underline: true };
    });
    attachmentSheet.getRow(1).height = 24;
    attachmentSheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    attachmentSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2D7D6B' } };
    attachmentSheet.getRow(1).alignment = { vertical: 'middle', horizontal: 'center' };
    attachmentSheet.eachRow((row, rowNumber) => {
      row.alignment = { vertical: 'top', wrapText: true };
      if (rowNumber > 1) row.height = 28;
      row.eachCell(cell => {
        cell.border = {
          top: { style: 'thin', color: { argb: 'FFD7E7E2' } },
          left: { style: 'thin', color: { argb: 'FFD7E7E2' } },
          bottom: { style: 'thin', color: { argb: 'FFD7E7E2' } },
          right: { style: 'thin', color: { argb: 'FFD7E7E2' } }
        };
      });
    });

    const fileName = `${owner.name}-日报周报-${periodStart}至${periodEnd}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="work-reports.xlsx"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    next(error);
  }
});

app.post('/api/work-reports/review', requireAuth, reviewUpload, async (req, res, next) => {
  if (req.user.role !== 'staff') return res.status(403).json({ error: '仅普通人员可审核自己的周报。' });
  try {
    const periodStart = String(req.body?.periodStart || '');
    const periodEnd = String(req.body?.periodEnd || '');
    const reportId = Number(req.body?.reportId || 0);
    if (!isDate(periodStart) || !isDate(periodEnd) || periodEnd < periodStart) {
      return res.status(400).json({ error: '请选择正确的周报开始和结束日期。' });
    }

    let existingFiles = [];
    if (reportId) {
      const report = db.prepare("SELECT id, report_type FROM work_reports WHERE id = ? AND user_id = ?").get(reportId, req.user.id);
      if (!report || report.report_type !== 'weekly') return res.status(404).json({ error: '周报不存在，或您无权审核。' });
      let removedIds = [];
      if (req.body?.removeAttachmentIds) {
        try {
          const parsed = JSON.parse(req.body.removeAttachmentIds);
          if (!Array.isArray(parsed) || parsed.some(id => !Number.isInteger(id) || id < 1)) throw new Error('invalid');
          removedIds = [...new Set(parsed)];
        } catch { return res.status(400).json({ error: '附件删除信息无效，请重新操作。' }); }
      }
      existingFiles = workReportAttachments(report.id)
        .filter(attachment => !removedIds.includes(attachment.id))
        .map(attachmentFile);
    }
    const newFiles = (req.files || []).map(uploadedReviewFile);
    const files = [...existingFiles, ...newFiles];
    if (files.some(file => !isWeeklyDocument(file))) return res.status(400).json({ error: '周报审核仅支持 PDF 或 DOCX 文档。' });
    if (files.length < 1) return res.status(400).json({ error: '请至少上传 1 个周报文档。' });
    if (files.length > reviewMaxFiles) return res.status(400).json({ error: '每份周报最多保留 5 个文档。' });
    const review = await requestWeeklyReview(files);
    const inputHash = reviewInputHash({ periodStart, periodEnd, reportId, files });
    const reviewToken = jwt.sign({ purpose: 'weekly-review', userId: req.user.id, inputHash, review, model: openAiReviewModel }, jwtSecret, { expiresIn: '1h' });
    res.json({ review, reviewToken, model: openAiReviewModel });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ error: error.message });
    console.error('[weekly-review]', error);
    return res.status(502).json({ error: '智能审核失败，请检查后端密钥和 OpenAI 服务配置。' });
  }
});

app.post('/api/work-reports', requireAuth, reportUpload, (req, res, next) => {
  const uploadedFiles = reportFiles(req);
  if (req.user.role !== 'staff') {
    removeUploadedFiles(uploadedFiles);
    return res.status(403).json({ error: '仅普通人员可提交工作日志。' });
  }
  try {
    const { type, periodStart, periodEnd } = req.body || {};
    const sections = {
      completion: String(req.body?.completion || '').trim(),
      learning: String(req.body?.learning || '').trim(),
      blockers: String(req.body?.blockers || '').trim(),
      solutions: String(req.body?.solutions || '').trim()
    };
    if (!['daily', 'weekly'].includes(type)) return res.status(400).json({ error: '请选择日报或周报。' });
    if (!isDate(periodStart) || !isDate(periodEnd)) return res.status(400).json({ error: '请选择正确的日期。' });
    if (type === 'daily' && periodStart !== periodEnd) return res.status(400).json({ error: '日报只能选择一个日期。' });
    if (type === 'weekly' && periodEnd < periodStart) return res.status(400).json({ error: '周报结束日期不能早于开始日期。' });
    if (type === 'daily' && uploadedFiles.length) return res.status(400).json({ error: '日报不支持上传附件，请在周报中添加附件。' });
    if (uploadedFiles.length > 5) return res.status(400).json({ error: '每份周报最多上传 5 个附件。' });
    if (type === 'weekly' && (!uploadedFiles.length || uploadedFiles.some(file => !isWeeklyDocument(file)))) {
      removeUploadedFiles(uploadedFiles);
      return res.status(400).json({ error: '周报请上传 1 至 5 个 PDF 或 DOCX 文档。' });
    }
    if (type === 'daily' && (sections.completion.length < 2 || Object.values(sections).some(value => value.length > 5000))) return res.status(400).json({ error: '请填写完成内容，单项内容不能超过 5000 个字符。' });
    if (type === 'daily' && Object.values(sections).join('').length > 16000) return res.status(400).json({ error: '汇报内容总长度不能超过 16000 个字符。' });
    const weeklyReview = type === 'weekly' ? verifiedWeeklyReview({
      reviewToken: req.body?.reviewToken,
      userId: req.user.id,
      periodStart,
      periodEnd,
      reportId: 0,
      existingAttachmentIds: [],
      uploadedFiles
    }) : null;
    const legacyContent = type === 'daily' ? Object.values(sections).filter(Boolean).join('\n\n') : '';
    let reportId;
    db.transaction(() => {
      const created = db.prepare(`
        INSERT INTO work_reports (user_id, report_type, period_start, period_end, content, details_json, attachment_id)
        VALUES (?, ?, ?, ?, ?, ?, NULL)
      `).run(req.user.id, type, periodStart, periodEnd, legacyContent, JSON.stringify(sections));
      reportId = created.lastInsertRowid;
      const attachmentIds = uploadedFiles.map(saveAttachment);
      const linkAttachment = db.prepare('INSERT INTO work_report_attachments (report_id, attachment_id) VALUES (?, ?)');
      attachmentIds.forEach(attachmentId => linkAttachment.run(reportId, attachmentId));
      if (attachmentIds.length) db.prepare('UPDATE work_reports SET attachment_id = ? WHERE id = ?').run(attachmentIds[0], reportId);
      if (weeklyReview) saveWorkReportReview(reportId, weeklyReview.review, weeklyReview.model);
    })();
    const row = db.prepare(`${detailedReportQuery} WHERE r.id = ?`).get(reportId);
    return res.status(201).json({ report: formatDetailedReport(row) });
  } catch (error) {
    removeUploadedFiles(uploadedFiles);
    if (error.status) return res.status(error.status).json({ error: error.message });
    return next(error);
  }
});

app.patch('/api/work-reports/:id', requireAuth, reportUpload, (req, res, next) => {
  const uploadedFiles = reportFiles(req);
  if (req.user.role !== 'staff') {
    removeUploadedFiles(uploadedFiles);
    return res.status(403).json({ error: '仅普通人员可修改自己的工作日志。' });
  }
  try {
    const report = db.prepare('SELECT * FROM work_reports WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
    if (!report) {
      removeUploadedFiles(uploadedFiles);
      return res.status(404).json({ error: '日志不存在，或您无权修改。' });
    }
    const { type, periodStart, periodEnd } = req.body || {};
    const sections = {
      completion: String(req.body?.completion || '').trim(),
      learning: String(req.body?.learning || '').trim(),
      blockers: String(req.body?.blockers || '').trim(),
      solutions: String(req.body?.solutions || '').trim()
    };
    if (!['daily', 'weekly'].includes(type)) return res.status(400).json({ error: '请选择日报或周报。' });
    if (!isDate(periodStart) || !isDate(periodEnd)) return res.status(400).json({ error: '请选择正确的日期。' });
    if (type === 'daily' && periodStart !== periodEnd) return res.status(400).json({ error: '日报只能选择一个日期。' });
    if (type === 'weekly' && periodEnd < periodStart) return res.status(400).json({ error: '周报结束日期不能早于开始日期。' });
    let removeAttachmentIds = [];
    if (req.body?.removeAttachmentIds) {
      try {
        const parsed = JSON.parse(req.body.removeAttachmentIds);
        if (!Array.isArray(parsed) || parsed.some(id => !Number.isInteger(id) || id < 1)) throw new Error('invalid');
        removeAttachmentIds = [...new Set(parsed)];
      } catch {
        return res.status(400).json({ error: '附件删除信息无效，请重新操作。' });
      }
    }
    const currentAttachmentIds = workReportAttachments(report.id).map(attachment => attachment.id);
    if (removeAttachmentIds.some(id => !currentAttachmentIds.includes(id))) return res.status(400).json({ error: '只能删除当前周报的附件。' });
    const remainingAttachmentIds = currentAttachmentIds.filter(id => !removeAttachmentIds.includes(id));
    if (type === 'daily' && (remainingAttachmentIds.length || uploadedFiles.length)) return res.status(400).json({ error: '日报不支持附件，请先删除现有附件。' });
    if (remainingAttachmentIds.length + uploadedFiles.length > 5) return res.status(400).json({ error: '每份周报最多保留 5 个附件。' });
    if (type === 'weekly' && (!remainingAttachmentIds.length && !uploadedFiles.length)) {
      removeUploadedFiles(uploadedFiles);
      return res.status(400).json({ error: '周报请至少保留 1 个 PDF 或 DOCX 文档。' });
    }
    if (type === 'weekly' && ([...remainingAttachmentIds.map(id => attachmentFile({ id })), ...uploadedFiles].some(file => !isWeeklyDocument(file)))) {
      removeUploadedFiles(uploadedFiles);
      return res.status(400).json({ error: '周报仅支持 PDF 或 DOCX 文档。' });
    }
    if (type === 'daily' && (sections.completion.length < 2 || Object.values(sections).some(value => value.length > 5000))) return res.status(400).json({ error: '请填写完成内容，单项内容不能超过 5000 个字符。' });
    if (type === 'daily' && Object.values(sections).join('').length > 16000) return res.status(400).json({ error: '汇报内容总长度不能超过 16000 个字符。' });
    const weeklyReview = type === 'weekly' ? verifiedWeeklyReview({
      reviewToken: req.body?.reviewToken,
      userId: req.user.id,
      periodStart,
      periodEnd,
      reportId: report.id,
      existingAttachmentIds: remainingAttachmentIds,
      uploadedFiles
    }) : null;

    const legacyContent = type === 'daily' ? Object.values(sections).filter(Boolean).join('\n\n') : '';
    db.transaction(() => {
      if (removeAttachmentIds.length) {
        const placeholders = removeAttachmentIds.map(() => '?').join(', ');
        db.prepare(`DELETE FROM work_report_attachments WHERE report_id = ? AND attachment_id IN (${placeholders})`).run(report.id, ...removeAttachmentIds);
      }
      const newAttachmentIds = uploadedFiles.map(saveAttachment);
      const linkAttachment = db.prepare('INSERT INTO work_report_attachments (report_id, attachment_id) VALUES (?, ?)');
      newAttachmentIds.forEach(attachmentId => linkAttachment.run(report.id, attachmentId));
      const firstAttachment = db.prepare('SELECT attachment_id FROM work_report_attachments WHERE report_id = ? ORDER BY created_at, attachment_id LIMIT 1').get(report.id);
      db.prepare(`
        UPDATE work_reports
        SET report_type = ?, period_start = ?, period_end = ?, content = ?, details_json = ?, attachment_id = ?
        WHERE id = ? AND user_id = ?
      `).run(type, periodStart, periodEnd, legacyContent, JSON.stringify(sections), firstAttachment?.attachment_id || null, report.id, req.user.id);
      if (weeklyReview) saveWorkReportReview(report.id, weeklyReview.review, weeklyReview.model);
      if (type === 'daily') db.prepare('DELETE FROM work_report_reviews WHERE report_id = ?').run(report.id);
    })();
    removeUnusedAttachments(removeAttachmentIds);
    const row = db.prepare(`${detailedReportQuery} WHERE r.id = ?`).get(report.id);
    res.json({ report: formatDetailedReport(row) });
  } catch (error) {
    removeUploadedFiles(uploadedFiles);
    if (error.status) return res.status(error.status).json({ error: error.message });
    next(error);
  }
});

app.delete('/api/work-reports/:id', requireAuth, (req, res) => {
  if (req.user.role !== 'staff') return res.status(403).json({ error: '仅普通人员可删除自己的工作日志。' });
  const report = db.prepare('SELECT id FROM work_reports WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  const attachmentIds = report ? workReportAttachments(report.id).map(attachment => attachment.id) : [];
  const result = db.transaction(() => {
    const deleted = db.prepare('DELETE FROM work_reports WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
    return deleted;
  })();
  if (!result.changes) return res.status(404).json({ error: '日志不存在，或您无权删除该日志。' });
  removeUnusedAttachments(attachmentIds);
  res.status(204).end();
});

app.get('/api/work-reports-legacy', requireAuth, (req, res) => {
  const baseQuery = `
    SELECT r.*, u.id AS user_id, u.name AS user_name
    FROM work_reports r JOIN users u ON u.id = r.user_id
  `;
  const rows = req.user.role === 'admin'
    ? db.prepare(`${baseQuery} ORDER BY u.name COLLATE NOCASE, r.period_start DESC, r.submitted_at DESC`).all()
    : db.prepare(`${baseQuery} WHERE r.user_id = ? ORDER BY r.period_start DESC, r.submitted_at DESC`).all(req.user.id);
  res.json({ reports: rows.map(formatReport) });
});

app.post('/api/work-reports-legacy', requireAuth, (req, res) => {
  if (req.user.role !== 'staff') return res.status(403).json({ error: '仅普通人员可提交工作日志。' });
  const { type, periodStart, periodEnd, content } = req.body || {};
  if (!['daily', 'weekly'].includes(type)) return res.status(400).json({ error: '请选择日报或周报。' });
  if (!isDate(periodStart) || !isDate(periodEnd)) return res.status(400).json({ error: '请选择正确的日期。' });
  if (type === 'daily' && periodStart !== periodEnd) return res.status(400).json({ error: '日报只能选择一个日期。' });
  if (type === 'weekly' && periodEnd < periodStart) return res.status(400).json({ error: '周报结束日期不能早于开始日期。' });
  if (!content || content.trim().length < 5 || content.trim().length > 5000) return res.status(400).json({ error: '内容需为 5 至 5000 个字符。' });
  db.prepare(`
    INSERT INTO work_reports (user_id, report_type, period_start, period_end, content)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, report_type, period_start) DO UPDATE SET
      period_end = excluded.period_end,
      content = excluded.content,
      submitted_at = CURRENT_TIMESTAMP
  `).run(req.user.id, type, periodStart, periodEnd, content.trim());
  const row = db.prepare(`
    SELECT r.*, u.id AS user_id, u.name AS user_name
    FROM work_reports r JOIN users u ON u.id = r.user_id
    WHERE r.user_id = ? AND r.report_type = ? AND r.period_start = ?
  `).get(req.user.id, type, periodStart);
  res.status(201).json({ report: formatReport(row) });
});

app.delete('/api/work-reports/:id', requireAuth, (req, res) => {
  if (req.user.role !== 'staff') return res.status(403).json({ error: '仅普通人员可删除自己的工作日志。' });
  const result = db.prepare('DELETE FROM work_reports WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  if (!result.changes) return res.status(404).json({ error: '日志不存在，或您无权删除该日志。' });
  res.status(204).end();
});

const expenseQuery = `
  SELECT e.id, e.amount_cents, e.purpose, e.receipt_type, e.status, e.submitted_at, e.reimbursed_at, e.rejected_at,
         u.id AS user_id, u.name AS user_name
  FROM expenses e
  JOIN users u ON u.id = e.user_id
`;
const expenseAttachmentQuery = `
  SELECT a.id, a.original_name, a.mime_type, a.file_size, a.stored_name
  FROM expense_attachments ea JOIN attachments a ON a.id = ea.attachment_id
  WHERE ea.expense_id = ? ORDER BY ea.created_at, a.id
`;

function expenseAttachments(expenseId) {
  return db.prepare(expenseAttachmentQuery).all(expenseId).map(attachment => ({
    id: attachment.id, name: attachment.original_name, mimeType: attachment.mime_type, size: attachment.file_size, storedName: attachment.stored_name
  }));
}

function formatExpense(row) {
  const attachments = expenseAttachments(row.id);
  return {
    id: row.id, amount: row.amount_cents / 100, purpose: row.purpose, receiptType: row.receipt_type,
    status: row.status, submittedAt: row.submitted_at, reimbursedAt: row.reimbursed_at, rejectedAt: row.rejected_at,
    user: { id: row.user_id, name: row.user_name },
    attachments: attachments.map(({ storedName, ...attachment }) => attachment),
    attachment: attachments.length ? (({ storedName, ...attachment }) => attachment)(attachments[0]) : null
  };
}

function deleteExpenseAndAttachments(expenseId) {
  const attachments = expenseAttachments(expenseId);
  db.transaction(() => {
    db.prepare('DELETE FROM expenses WHERE id = ?').run(expenseId);
    const deleteAttachment = db.prepare('DELETE FROM attachments WHERE id = ?');
    attachments.forEach(attachment => deleteAttachment.run(attachment.id));
  })();
  attachments.forEach(attachment => fs.rm(path.join(uploadDir, attachment.storedName), { force: true }, () => {}));
}

app.get('/api/expenses', requireAuth, (req, res) => {
  const rows = req.user.role === 'admin'
    ? db.prepare(`${expenseQuery} ORDER BY e.submitted_at DESC`).all()
    : db.prepare(`${expenseQuery} WHERE e.user_id = ? ORDER BY e.submitted_at DESC`).all(req.user.id);
  res.json({ expenses: rows.map(formatExpense) });
});

app.post('/api/expenses', requireAuth, expenseUpload, (req, res, next) => {
  const files = expenseFiles(req);
  try {
    const { amount, purpose, receiptType } = req.body;
    const amountCents = Math.round(Number(amount) * 100);
    if (!files.length || files.length > 20) {
      removeUploadedFiles(files);
      return res.status(400).json({ error: '请上传 1 至 6 个附件。' });
    }
    const expenseAllowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (files.some(file => !expenseAllowedMimes.includes(file.mimetype))) {
      removeUploadedFiles(files);
      return res.status(400).json({ error: '报销附件仅支持 JPG、PNG、WEBP 或 PDF 文件，DOCX 请上传到周报。' });
    }
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      removeUploadedFiles(files);
      return res.status(400).json({ error: '请输入正确的报销金额。' });
    }
    if (!purpose || purpose.trim().length < 2 || purpose.trim().length > 120) {
      removeUploadedFiles(files);
      return res.status(400).json({ error: '开销用途需为 2 至 120 个字符。' });
    }
    if (!['invoice', 'image'].includes(receiptType)) {
      removeUploadedFiles(files);
      return res.status(400).json({ error: '请选择附件类型。' });
    }
    const id = db.transaction(() => {
      const attachmentIds = files.map(saveAttachment);
      const expenseId = db.prepare('INSERT INTO expenses (user_id, attachment_id, amount_cents, purpose, receipt_type) VALUES (?, ?, ?, ?, ?)')
        .run(req.user.id, attachmentIds[0], amountCents, purpose.trim(), receiptType).lastInsertRowid;
      const linkAttachment = db.prepare('INSERT INTO expense_attachments (expense_id, attachment_id) VALUES (?, ?)');
      attachmentIds.forEach(attachmentId => linkAttachment.run(expenseId, attachmentId));
      return expenseId;
    })();
    const row = db.prepare(`${expenseQuery} WHERE e.id = ?`).get(id);
    res.status(201).json({ expense: formatExpense(row) });
  } catch (error) {
    removeUploadedFiles(files);
    next(error);
  }
});

app.post('/api/expenses/:id/reimburse', requireAuth, requireAdmin, (req, res) => {
  const result = db.prepare("UPDATE expenses SET status = 'reimbursed', reimbursed_at = CURRENT_TIMESTAMP, reimbursed_by = ?, rejected_at = NULL, rejected_by = NULL WHERE id = ? AND status = 'pending'").run(req.user.id, req.params.id);
  if (!result.changes) return res.status(409).json({ error: '该记录不存在或已处理。' });
  res.json({ ok: true });
});

app.post('/api/expenses/:id/reject', requireAuth, requireAdmin, (req, res) => {
  const result = db.prepare("UPDATE expenses SET status = 'rejected', rejected_at = CURRENT_TIMESTAMP, rejected_by = ? WHERE id = ? AND status = 'pending'").run(req.user.id, req.params.id);
  if (!result.changes) return res.status(409).json({ error: '该记录不存在或已处理。' });
  res.json({ ok: true });
});

app.delete('/api/admin/expenses/:id', requireAuth, requireAdmin, (req, res) => {
  const expense = db.prepare('SELECT id, status FROM expenses WHERE id = ?').get(req.params.id);
  if (!expense) return res.status(404).json({ error: '报销申请不存在。' });
  if (expense.status !== 'reimbursed') return res.status(409).json({ error: '只有已报销的申请可以由管理员删除。' });
  deleteExpenseAndAttachments(expense.id);
  res.status(204).end();
});

app.delete('/api/expenses/:id', requireAuth, (req, res) => {
  if (req.user.role !== 'staff') return res.status(403).json({ error: '仅普通人员可删除自己的报销申请。' });
  const expense = db.prepare('SELECT id, user_id, status FROM expenses WHERE id = ?').get(req.params.id);
  if (!expense || expense.user_id !== req.user.id) return res.status(404).json({ error: '报销申请不存在，或您无权删除。' });
  if (!['pending', 'rejected'].includes(expense.status)) return res.status(409).json({ error: '已报销的申请不能删除。' });
  deleteExpenseAndAttachments(expense.id);
  res.status(204).end();
});

app.patch('/api/users/:id', requireAuth, requireAdmin, (req, res, next) => {
  try {
    const { name, phone } = req.body || {};
    if (!name || name.trim().length < 2 || name.trim().length > 30) return res.status(400).json({ error: '姓名需为 2 至 30 个字符。' });
    const phoneError = validatePhone(phone);
    if (phoneError) return res.status(400).json({ error: phoneError });
    const user = db.prepare('SELECT * FROM users WHERE id = ? AND role = ?').get(req.params.id, 'staff');
    if (!user) return res.status(404).json({ error: '普通人员账号不存在。' });
    db.prepare('UPDATE users SET name = ?, phone = ? WHERE id = ?').run(name.trim(), phone.trim(), user.id);
    const saved = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    res.json({ user: sessionUser(saved) });
  } catch (error) {
    if (String(error.message).includes('UNIQUE')) return res.status(409).json({ error: '该姓名的普通人员账号已存在。' });
    next(error);
  }
});

app.get('/api/users', requireAuth, requireAdmin, (_req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.name, u.phone, u.role, u.created_at,
      COUNT(e.id) AS expense_count, COALESCE(SUM(e.amount_cents), 0) AS expense_cents
    FROM users u LEFT JOIN expenses e ON e.user_id = u.id
    GROUP BY u.id ORDER BY u.role DESC, u.name COLLATE NOCASE
  `).all().map(row => ({ id: row.id, name: row.name, phone: row.phone || '', role: row.role, createdAt: row.created_at, expenseCount: row.expense_count, expenseTotal: row.expense_cents / 100 }));
  res.json({ users });
});

app.get('/api/users-legacy', requireAuth, requireAdmin, (_req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.name, u.role, u.created_at,
      COUNT(e.id) AS expense_count, COALESCE(SUM(e.amount_cents), 0) AS expense_cents
    FROM users u LEFT JOIN expenses e ON e.user_id = u.id
    GROUP BY u.id ORDER BY u.role DESC, u.name COLLATE NOCASE
  `).all().map(row => ({ id: row.id, name: row.name, role: row.role, createdAt: row.created_at, expenseCount: row.expense_count, expenseTotal: row.expense_cents / 100 }));
  res.json({ users });
});

app.get('/api/attachments/:id', (req, res) => {
  const row = db.prepare(`
    SELECT a.*, COALESCE(e.user_id, r.user_id) AS owner_id,
      EXISTS (
        SELECT 1
        FROM work_report_attachments wra2
        JOIN work_reports r2 ON r2.id = wra2.report_id
        WHERE wra2.attachment_id = a.id
      ) AS is_work_report_attachment
    FROM attachments a
    LEFT JOIN expense_attachments ea ON ea.attachment_id = a.id
    LEFT JOIN expenses e ON e.id = ea.expense_id
    LEFT JOIN work_report_attachments wra ON wra.attachment_id = a.id
    LEFT JOIN work_reports r ON r.attachment_id = a.id OR r.id = wra.report_id
    WHERE a.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: '附件不存在。' });
  let exportTokenValid = false;
  if (req.query.exportToken) {
    try {
      const claims = jwt.verify(String(req.query.exportToken), jwtSecret);
      exportTokenValid = claims.purpose === 'attachment-export' && Number(claims.attachmentId) === Number(req.params.id);
    } catch {}
  }
  if (!exportTokenValid) {
    try { req.user = jwt.verify(getCookies(req).invoice_session, jwtSecret); } catch { return res.status(401).json({ error: '登录已失效，请重新登录。' }); }
    if (req.user.role !== 'admin' && row.owner_id !== req.user.id && !row.is_work_report_attachment) return res.status(403).json({ error: '无权访问该附件。' });
  }
  res.type(row.mime_type);
  const isDocx = row.mime_type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || path.extname(row.original_name).toLowerCase() === '.docx';
  res.setHeader('Content-Disposition', `${isDocx ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(row.original_name)}`);
  res.sendFile(path.join(uploadDir, row.stored_name));
});

app.get('/api/attachments-legacy/:id', requireAuth, (req, res) => {
  const row = db.prepare(`SELECT a.*, e.user_id FROM attachments a JOIN expenses e ON e.attachment_id = a.id WHERE a.id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: '附件不存在。' });
  if (req.user.role !== 'admin' && row.user_id !== req.user.id) return res.status(403).json({ error: '无权访问该附件。' });
  res.type(row.mime_type);
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(row.original_name)}`);
  res.sendFile(path.join(uploadDir, row.stored_name));
});

app.get('/vendor/lucide.js', (_req, res) => res.sendFile(path.join(root, 'node_modules', 'lucide', 'dist', 'umd', 'lucide.js')));
app.use('/preview-ledger-studio', express.static(path.join(root, 'preview-ledger-studio')));
app.get('/', (_req, res) => res.sendFile(path.join(root, 'index.html')));
app.get('/styles.css', (_req, res) => res.sendFile(path.join(root, 'styles.css')));
app.get('/app.js', (_req, res) => res.sendFile(path.join(root, 'app.js')));

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError && ['LIMIT_FILE_COUNT', 'LIMIT_UNEXPECTED_FILE'].includes(error.code)) return res.status(400).json({ error: '报销一次最多上传 20 个附件，周报一次最多上传 5 个附件。' });
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: '附件不能超过 10MB。' });
  if (error instanceof multer.MulterError && ['LIMIT_FILE_COUNT', 'LIMIT_UNEXPECTED_FILE'].includes(error.code)) return res.status(400).json({ error: '一次最多上传 6 个附件。' });
  if (error.message === '仅支持 JPG、PNG、WEBP、PDF 或 DOCX 文件。') return res.status(400).json({ error: error.message });
  console.error(error);
  res.status(500).json({ error: '服务器处理失败，请稍后再试。' });
});

const host = process.env.HOST || '0.0.0.0';
app.listen(port, host, () => console.log(`票据台账已启动：http://${host}:${port}`));
