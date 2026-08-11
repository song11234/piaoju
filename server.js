const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const ExcelJS = require('exceljs');
const mammoth = require('mammoth');
const sanitizeHtml = require('sanitize-html');

const reviewMaxFiles = 5;
const reviewMaxBytes = 25 * 1024 * 1024;
// The deployed project uses the configured OpenAI-compatible relay by default.
// Both values remain overrideable through environment variables.
const openAiBaseUrl = (String(process.env.OPENAI_BASE_URL || 'https://ergouzi.life/v1').trim() || 'https://ergouzi.life/v1').replace(/\/$/, '');
const openAiReviewModel = String(process.env.OPENAI_REVIEW_MODEL || '').trim() || 'gpt-5.4-mini';

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

// Multi-dimensional review fields are additive so existing reports and review history remain intact.
const reviewColumns = new Set(db.prepare("PRAGMA table_info('work_report_reviews')").all().map(column => column.name));
if (!reviewColumns.has('grade')) db.exec("ALTER TABLE work_report_reviews ADD COLUMN grade TEXT");
if (!reviewColumns.has('dimension_scores_json')) db.exec("ALTER TABLE work_report_reviews ADD COLUMN dimension_scores_json TEXT NOT NULL DEFAULT '[]'");
if (!reviewColumns.has('urgent_actions_json')) db.exec("ALTER TABLE work_report_reviews ADD COLUMN urgent_actions_json TEXT NOT NULL DEFAULT '[]'");
if (!reviewColumns.has('standard_actions_json')) db.exec("ALTER TABLE work_report_reviews ADD COLUMN standard_actions_json TEXT NOT NULL DEFAULT '[]'");
if (!reviewColumns.has('advanced_actions_json')) db.exec("ALTER TABLE work_report_reviews ADD COLUMN advanced_actions_json TEXT NOT NULL DEFAULT '[]'");

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

const reviewDimensions = [
  { id: 'objective_alignment', title: '内容目标匹配度', maxScore: 15, floor: 6 },
  { id: 'learning_absorption', title: '学习收获与知识吸收', maxScore: 30, floor: 12 },
  { id: 'growth_progress', title: '成长进步与能力变化', maxScore: 20, floor: 8 },
  { id: 'reuse_value', title: '经验沉淀与复用价值', maxScore: 15, floor: 6 },
  { id: 'problem_closed_loop', title: '问题闭环与踩坑沉淀', maxScore: 10, floor: 4 },
  { id: 'readability', title: '结构可读性与素材规范', maxScore: 10, floor: 4 }
];

function parseReviewResult(value) {
  let parsed;
  try { parsed = typeof value === 'string' ? JSON.parse(value) : value; } catch {
    const error = new Error('智能审核返回的内容不是有效 JSON，可能是模型接口格式不兼容。');
    error.code = 'REVIEW_INVALID_RESPONSE';
    throw error;
  }
  if (!parsed || typeof parsed !== 'object') {
    const error = new Error('智能审核返回格式无效，可能是模型接口格式不兼容。');
    error.code = 'REVIEW_INVALID_RESPONSE';
    throw error;
  }
  const compactList = input => Array.isArray(input)
    ? input.map(item => String(item || '').trim()).filter(Boolean).slice(0, 8)
    : [];
  const score = Number(parsed.score);
  const summary = String(parsed.summary || '').trim();
  const dimensions = Array.isArray(parsed.dimensions) ? parsed.dimensions : [];
  const normalizedDimensions = reviewDimensions.map(definition => {
    const item = dimensions.find(candidate => candidate && candidate.id === definition.id);
    const rawScore = Number(item?.score);
    if (!item || !Number.isInteger(rawScore) || rawScore < 0 || rawScore > definition.maxScore || Number(item.maxScore) !== definition.maxScore) {
      const error = new Error(`智能审核缺少“${definition.title}”的有效分项评分。`);
      error.code = 'REVIEW_INVALID_RESPONSE';
      throw error;
    }
    // Enforce the rubric's per-dimension floor at the server boundary.
    const itemScore = Math.max(definition.floor, rawScore);
    return {
      id: definition.id,
      title: definition.title,
      score: itemScore,
      maxScore: definition.maxScore,
      assessment: String(item.assessment || '').trim().slice(0, 600),
      evidence: compactList(item.evidence),
      deductions: compactList(item.deductions),
      improvement: String(item.improvement || '').trim().slice(0, 500)
    };
  });
  const calculatedScore = normalizedDimensions.reduce((sum, item) => sum + item.score, 0);
  if (!Number.isInteger(score) || score !== calculatedScore || score < 0 || score > 100 || !summary) {
    const error = new Error('智能审核分项评分与总分不一致，请重新审核。');
    error.code = 'REVIEW_INVALID_RESPONSE';
    throw error;
  }
  const grade = score >= 90 ? 'excellent' : score >= 75 ? 'good' : score >= 45 ? 'qualified' : 'unqualified';
  const decision = score >= 75 && parsed.decision !== 'needs_revision' ? 'recommend_submit' : 'needs_revision';
  return {
    score,
    grade,
    summary: summary.slice(0, 1600),
    dimensions: normalizedDimensions,
    strengths: compactList(parsed.strengths),
    issues: compactList(parsed.issues),
    suggestions: compactList(parsed.suggestions),
    urgentActions: compactList(parsed.urgentActions),
    standardActions: compactList(parsed.standardActions),
    advancedActions: compactList(parsed.advancedActions),
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

function makeReviewError(message, status, code, retryable = false) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.retryable = retryable;
  return error;
}

function classifyReviewUpstreamError(status, detail = '') {
  const extra = detail && !/^HTTP \d+$/.test(detail) ? `（中转站：${detail.slice(0, 240)}）` : '';
  if (status === 400) return makeReviewError(`审核请求被拒绝，可能是文件格式、模型参数或文档内容不兼容${extra}。请重新导出为有效 PDF/DOCX 后重试。`, 400, 'REVIEW_BAD_REQUEST');
  if (status === 401) return makeReviewError(`审核 Key 无效或已过期${extra}。请检查 OPENAI_API_KEY，并在中转站后台重新生成 Key。`, 503, 'REVIEW_INVALID_API_KEY');
  if (status === 403) return makeReviewError(`审核 Key 没有调用权限${extra}。请检查中转站账户权限、模型权限或余额。`, 503, 'REVIEW_FORBIDDEN');
  if (status === 404) return makeReviewError(`审核地址或模型不存在${extra}。请检查 OPENAI_BASE_URL 是否包含 /v1，以及模型名称是否正确。`, 502, 'REVIEW_ENDPOINT_NOT_FOUND');
  if (status === 408 || status === 504) return makeReviewError(`中转站等待模型响应超时${extra}。请稍后重试，或减少文档数量和大小。`, 504, 'REVIEW_UPSTREAM_TIMEOUT', true);
  if (status === 413) return makeReviewError(`上传文档超过中转站限制${extra}。请减少文件数量或压缩文档。`, 413, 'REVIEW_PAYLOAD_TOO_LARGE');
  if (status === 429) return makeReviewError(`中转站当前限流或额度不足${extra}。请等待几十秒后重试，或检查账户余额与调用限额。`, 429, 'REVIEW_RATE_LIMITED', true);
  if (status >= 500) return makeReviewError(`中转站暂时不可用${extra}。请稍后重试；若持续失败，请联系中转站服务商。`, 502, 'REVIEW_UPSTREAM_UNAVAILABLE', true);
  return makeReviewError(`审核服务返回异常状态（${status}）${extra}。请检查中转站配置后重试。`, 502, 'REVIEW_UPSTREAM_ERROR', true);
}

function saveWorkReportReview(reportId, review, model) {
  db.prepare(`
    INSERT INTO work_report_reviews (
      report_id, score, grade, summary, strengths_json, issues_json, suggestions_json,
      dimension_scores_json, urgent_actions_json, standard_actions_json, advanced_actions_json, model, reviewed_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(report_id) DO UPDATE SET
      score = excluded.score,
      grade = excluded.grade,
      summary = excluded.summary,
      strengths_json = excluded.strengths_json,
      issues_json = excluded.issues_json,
      suggestions_json = excluded.suggestions_json,
      dimension_scores_json = excluded.dimension_scores_json,
      urgent_actions_json = excluded.urgent_actions_json,
      standard_actions_json = excluded.standard_actions_json,
      advanced_actions_json = excluded.advanced_actions_json,
      model = excluded.model,
      reviewed_at = CURRENT_TIMESTAMP
  `).run(
    reportId, review.score, review.grade, review.summary,
    JSON.stringify(review.strengths), JSON.stringify(review.issues), JSON.stringify(review.suggestions),
    JSON.stringify(review.dimensions), JSON.stringify(review.urgentActions), JSON.stringify(review.standardActions), JSON.stringify(review.advancedActions), model
  );
}

async function requestWeeklyReview(files) {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) {
    const error = new Error('尚未配置 OPENAI_API_KEY，暂时无法进行智能审核。');
    error.status = 503;
    error.code = 'REVIEW_MISSING_API_KEY';
    throw error;
  }
  if (files.length < 1) {
    const error = new Error('请至少上传 1 个周报文档后再审核。');
    error.status = 400;
    error.code = 'REVIEW_NO_FILES';
    throw error;
  }
  if (files.some(file => !Number(file.size))) {
    const error = new Error('发现 0 KB 空文档，请删除后重新选择有效的 PDF 或 DOCX 文件。');
    error.status = 400;
    error.code = 'REVIEW_EMPTY_FILE';
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
        grade: { type: 'string', enum: ['excellent', 'good', 'qualified', 'unqualified'] },
        summary: { type: 'string' },
        dimensions: {
          type: 'array',
          minItems: 6,
          maxItems: 6,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', enum: reviewDimensions.map(item => item.id) },
              title: { type: 'string' },
              score: { type: 'integer', minimum: 0, maximum: 30 },
              maxScore: { type: 'integer', enum: reviewDimensions.map(item => item.maxScore) },
              assessment: { type: 'string' },
              evidence: { type: 'array', items: { type: 'string' } },
              deductions: { type: 'array', items: { type: 'string' } },
              improvement: { type: 'string' }
            },
            required: ['id', 'title', 'score', 'maxScore', 'assessment', 'evidence', 'deductions', 'improvement']
          }
        },
        strengths: { type: 'array', items: { type: 'string' } },
        issues: { type: 'array', items: { type: 'string' } },
        suggestions: { type: 'array', items: { type: 'string' } },
        urgentActions: { type: 'array', items: { type: 'string' } },
        standardActions: { type: 'array', items: { type: 'string' } },
        advancedActions: { type: 'array', items: { type: 'string' } },
        decision: { type: 'string', enum: ['recommend_submit', 'needs_revision'] }
      },
      required: ['score', 'grade', 'summary', 'dimensions', 'strengths', 'issues', 'suggestions', 'urgentActions', 'standardActions', 'advancedActions', 'decision']
    };
    const reviewPrompt = [
      '你是企业学习与工作文档审核助手。先判断场景：A=周期性工作/学习周报，无豁免；B=单次实操/单点学习笔记，若属于一次性部署、单次故障排查、单知识点学习或临时工具测试，则豁免无开篇目标、全程无报错记录、无后续计划三项扣分。不得编造文档中没有的事实。',
      '总分100，六维满分与保底分固定，保底分是硬约束：objective_alignment内容目标匹配度15/保底6；learning_absorption学习收获与知识吸收30/保底12（第一核心）；growth_progress成长进步与能力变化20/保底8（第二核心）；reuse_value经验沉淀与复用价值15/保底6（第三核心）；problem_closed_loop问题闭环与踩坑沉淀10/保底4；readability结构可读性与素材规范10/保底4。每项score不得低于对应保底分，且总分必须等于六项分数之和。',
      '目标匹配：无目标扣3，单次笔记豁免；每大段偏题扣1；未区分掌握进度扣2。学习收获：只有操作无知识总结扣8；无个人理解扣5；未区分新旧知识扣4；有完整操作记录不低于12。成长进步：无能力复盘扣6；无前后对比扣4；未梳理短板扣2。经验复用：无通用模板扣4；全部硬编码无通用说明扣3；缺验证素材扣2。问题闭环：出现故障无记录/方案扣3；无通用避坑经验扣2；未标遗留风险扣1；零故障单次笔记豁免。可读性：逻辑混乱扣2；脚本堆正文扣1；图文不匹配或截图无说明每处扣1。',
      '评级固定：90-100 excellent优秀，75-89 good良好，45-74 qualified合格，0-44 unqualified不合格。总分必须等于六个分项之和；低于75时decision=needs_revision，否则recommend_submit。',
      '输出四段：第一段总分评级和六维得分，并突出学习收获、成长进步、经验复用；第二段亮点；第三段逐条扣分待优化点且标明维度；第四段urgentActions紧急优化、standardActions常规优化、advancedActions进阶优化。每个维度都要有assessment、evidence、deductions、improvement。使用简体中文，建议具体可执行。'
    ].join('\\n');
    const performReviewFetch = () => fetch(`${openAiBaseUrl}/responses`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify((payload => {
        // Keep the request body shape intact while ensuring the active scoring
        // rubric above is the prompt actually sent to the model.
        payload.input[0].content[0].text = reviewPrompt;
        return payload;
      })({
        model: openAiReviewModel,
        max_output_tokens: 3200,
        input: [{
          role: 'user',
          content: [
            {
              type: 'input_text',
              text: `你是企业周报审核助手。仅依据所附文件进行多维度、可复核的评估，不得编造文件中没有的事实；信息不足时必须明确写入 assessment、evidence 或 deductions。文档可以是周报、技术实操笔记、开发记录、业务需求记录或项目实践记录，不强制固定模板，重点评价文档本身的闭环价值。

请严格按以下六个维度评分，分项满分和含义不可改变：
1. objective_alignment 内容目标匹配度，满分20：是否明确本周/本次学习或工作目标、待解决问题、预期产出，内容是否围绕目标，是否区分完成与未完成；无明确目标扣10，目标未区分完成进度扣5，明显偏题每处扣3。
2. process_completeness 实操/业务信息完整度，满分25：技术文档应覆盖前置依赖、环境（本地/服务器/内网/公网）、命令、配置、路径、端口、参数和验证；业务文档应覆盖流程、角色、上下游、需求细节、交互逻辑、业务规则、边界和特殊场景。关键流程断点每处扣4，缺环境/边界区分扣5，无验证/校验手段扣6，关键参数或业务规则每处扣3。
3. verifiable_output 可验证成果与产出，满分20：逐项目标给出功能点、接口、测试输出、截图、配置文件、落地模块等量化或实物成果，说明影响范围、完成度、验收标准，并提供日志、端口检测、页面效果或业务测试数据。无成果描述扣12，有成果但无证据扣6，完成度或影响范围不清扣3。
4. problem_closed_loop 问题闭环与风险沉淀，满分15：记录故障/阻塞/异常、成因、排查过程、最终方案，区分已解决与遗留问题，并注明限制条件、现存风险和潜在隐患。无问题/故障记录扣8，有问题但无原因或方案扣5，未标注遗留风险扣4。
5. follow_up_plan 后续规划与迭代动作，满分10：对应遗留问题和未完成目标给出下一步动作，说明优先级、推进目标、待完成事项、预期产出以及针对短板的学习/优化计划。无后续计划扣7，计划笼统无可落地动作扣3。
6. readability 结构可读性与素材规范，满分10：内容按目标-过程-成果-问题-计划组织，关键命令/路径/业务规则突出，截图或素材紧贴正文且有文字说明，命令和大段配置折叠到附件或附录，正文简洁。逻辑顺序混乱扣4，大量命令堆正文扣3，图文不匹配或截图无说明每处扣2。

总分必须等于六个分项之和。评级固定为：90-100 excellent（优秀）、75-89 good（良好）、50-74 qualified（合格但需大幅补充）、0-49 unqualified（不合格）。建议 decision：总分低于75时 needs_revision，否则 recommend_submit。每个维度都必须给出 score、maxScore、assessment、evidence、deductions、improvement。输出 strengths、issues、suggestions，同时把建议分为 urgentActions（不改会明显影响得分的紧急修改）、standardActions（提升完整度的常规优化）、advancedActions（提升复用价值的进阶优化）。使用简体中文，建议内容要具体、可执行。`
            },
            ...inputFiles
          ]
        }],
        text: { format: { type: 'json_schema', name: 'weekly_report_review', strict: true, schema } }
      })),
      signal: controller.signal
    });
    let reviewResponse;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        reviewResponse = await performReviewFetch();
        break;
      } catch (error) {
        const networkCode = String(error?.cause?.code || error?.code || '').toUpperCase();
        const transient = ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'ECONNABORTED'].includes(networkCode);
        if (!transient || attempt === 2) throw error;
        await new Promise(resolve => setTimeout(resolve, 1200));
      }
    }
    const reviewData = await reviewResponse.json().catch(() => ({}));
    if (!reviewResponse.ok) {
      const apiMessage = reviewData?.error?.message || reviewData?.message || `HTTP ${reviewResponse.status}`;
      throw classifyReviewUpstreamError(reviewResponse.status, apiMessage);
    }
    const outputText = reviewData.output_text
      || reviewData.output?.flatMap(item => item.content || []).find(item => item.type === 'output_text')?.text
      || reviewData.output?.flatMap(item => item.content || []).find(item => typeof item.text === 'string')?.text;
    return parseReviewResult(outputText);
  } catch (error) {
    if (error.name === 'AbortError') {
      throw makeReviewError('本地审核请求超时（超过 180 秒）。请检查网络代理和中转站状态后重试。', 504, 'REVIEW_LOCAL_TIMEOUT', true);
    }
    if (error.code === 'REVIEW_INVALID_RESPONSE') {
      throw makeReviewError(`${error.message} 请检查中转站是否完整支持 Responses 结构化输出。`, 502, 'REVIEW_INVALID_RESPONSE', true);
    }
    if (!error.status) {
      const networkMessage = error?.cause?.code || error?.code || error?.message || '未知网络错误';
      const networkCode = String(networkMessage).slice(0, 180);
      console.error('[weekly-review-network]', { baseUrl: openAiBaseUrl, model: openAiReviewModel, code: networkCode });
      const hint = String(networkMessage).toUpperCase() === 'ECONNRESET'
        ? '中转站主动重置了连接，系统已自动重试；请稍后再次点击审核，若持续出现请检查代理或中转站请求体限制'
        : '请检查网络、代理和 OPENAI_BASE_URL';
      throw makeReviewError(`无法连接审核中转站（${networkCode}）。${hint}。当前地址：${openAiBaseUrl}`, 502, 'REVIEW_NETWORK_ERROR', true);
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
      grade: row.review_grade || (row.review_score >= 90 ? 'excellent' : row.review_score >= 75 ? 'good' : row.review_score >= 45 ? 'qualified' : 'unqualified'),
      summary: row.review_summary,
      dimensions: safeJsonObjectList(row.review_dimension_scores_json),
      strengths: safeJsonList(row.review_strengths_json),
      issues: safeJsonList(row.review_issues_json),
      suggestions: safeJsonList(row.review_suggestions_json),
      urgentActions: safeJsonList(row.review_urgent_actions_json),
      standardActions: safeJsonList(row.review_standard_actions_json),
      advancedActions: safeJsonList(row.review_advanced_actions_json),
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

function safeJsonObjectList(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'object') : [];
  } catch { return []; }
}

function reviewGradeLabel(grade) {
  return ({ excellent: '优秀', good: '良好', qualified: '合格（需补充）', unqualified: '不合格' })[grade] || '';
}

function reviewDimensionText(value) {
  return safeJsonObjectList(value).map(item => `${item.title || item.id}: ${item.score}/${item.maxScore}；${item.assessment || ''}`).join('\n');
}

const detailedReportQuery = `
  SELECT r.*, u.id AS user_id, u.name AS user_name,
    a.id AS report_attachment_id, a.original_name AS report_attachment_name,
    a.mime_type AS report_attachment_mime, a.file_size AS report_attachment_size,
    rr.score AS review_score, rr.summary AS review_summary,
    rr.strengths_json AS review_strengths_json, rr.issues_json AS review_issues_json,
    rr.suggestions_json AS review_suggestions_json, rr.grade AS review_grade,
    rr.dimension_scores_json AS review_dimension_scores_json,
    rr.urgent_actions_json AS review_urgent_actions_json,
    rr.standard_actions_json AS review_standard_actions_json,
    rr.advanced_actions_json AS review_advanced_actions_json,
    rr.model AS review_model, rr.reviewed_at
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

app.get('/api/report-square/:reportId/documents/:attachmentId/preview', requireAuth, async (req, res, next) => {
  const reportId = Number(req.params.reportId);
  const attachmentId = Number(req.params.attachmentId);
  if (!Number.isInteger(reportId) || !Number.isInteger(attachmentId)) return res.status(404).json({ error: '周报文档不存在。' });

  const attachment = db.prepare(`
    SELECT a.id, a.original_name, a.stored_name, a.mime_type
    FROM work_reports r
    JOIN work_report_attachments wra ON wra.report_id = r.id
    JOIN attachments a ON a.id = wra.attachment_id
    WHERE r.id = ? AND r.report_type = 'weekly' AND a.id = ?
  `).get(reportId, attachmentId);
  if (!attachment) return res.status(404).json({ error: '周报文档不存在。' });

  const isDocx = attachment.mime_type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    || path.extname(attachment.original_name).toLowerCase() === '.docx';
  if (!isDocx) return res.status(400).json({ error: '该附件不是 DOCX 文档。' });

  const filePath = path.join(uploadDir, attachment.stored_name);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: '找不到该周报文档。' });

  try {
    const result = await mammoth.convertToHtml({ path: filePath });
    const html = sanitizeHtml(continueOrderedListNumbers(result.value), {
      allowedTags: ['p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'u', 's', 'sup', 'sub', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a', 'img', 'blockquote', 'pre', 'code', 'hr'],
      allowedAttributes: { ol: ['start'], a: ['href'], img: ['src', 'alt'], th: ['colspan', 'rowspan'], td: ['colspan', 'rowspan'] },
      allowedSchemes: ['http', 'https', 'mailto'],
      allowedSchemesByTag: { img: ['data'] },
      transformTags: {
        a: (_tagName, attrs) => ({ tagName: 'a', attribs: { href: attrs.href || '#', target: '_blank', rel: 'noopener noreferrer' } })
      }
    });
    res.json({ html, warnings: result.messages.map(message => message.message) });
  } catch (error) {
    next(error);
  }
});

function continueOrderedListNumbers(html) {
  let nextNumber = 1;
  return String(html || '').replace(/<ol\b([^>]*)>([\s\S]*?)<\/ol>/gi, (full, attrs, content) => {
    const explicitStart = attrs.match(/\bstart\s*=\s*["']?(\d+)/i);
    const start = explicitStart ? Number(explicitStart[1]) : nextNumber;
    const itemCount = (content.match(/<li\b/gi) || []).length;
    const nextAttrs = explicitStart ? attrs : `${attrs} start="${start}"`;
    nextNumber = start + itemCount;
    return `<ol${nextAttrs}>${content}</ol>`;
  });
}

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
      owner = db.prepare('SELECT id, name FROM users WHERE id = ?').get(userId);
      if (!owner) return res.status(404).json({ error: '该员工不存在，或不存在。' });
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
      { header: '审核评级', key: 'reviewGrade', width: 18 },
      { header: '六维分项评分', key: 'reviewDimensions', width: 48 },
      { header: '审核结论', key: 'reviewDecision', width: 16 },
      { header: '审核分析', key: 'reviewSummary', width: 42 },
      { header: '修改建议', key: 'reviewSuggestions', width: 42 },
      { header: '紧急修改', key: 'reviewUrgentActions', width: 38 },
      { header: '常规优化', key: 'reviewStandardActions', width: 38 },
      { header: '进阶优化', key: 'reviewAdvancedActions', width: 38 },
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
        grade: row.review_grade,
        dimensions: row.review_dimension_scores_json,
        summary: row.review_summary,
        suggestions: safeJsonList(row.review_suggestions_json),
        issues: safeJsonList(row.review_issues_json),
        urgentActions: safeJsonList(row.review_urgent_actions_json),
        standardActions: safeJsonList(row.review_standard_actions_json),
        advancedActions: safeJsonList(row.review_advanced_actions_json)
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
        reviewGrade: review ? reviewGradeLabel(review.grade) : '',
        reviewDimensions: review ? excelText(reviewDimensionText(review.dimensions)) : '',
        reviewDecision: review ? (review.issues.length ? '建议修改' : '可提交') : '',
        reviewSummary: excelText(review?.summary || ''),
        reviewSuggestions: excelText(review?.suggestions.join('；') || ''),
        reviewUrgentActions: excelText(review?.urgentActions.join('；') || ''),
        reviewStandardActions: excelText(review?.standardActions.join('；') || ''),
        reviewAdvancedActions: excelText(review?.advancedActions.join('；') || ''),
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
    if (error.status) return res.status(error.status).json({
      error: error.message,
      code: error.code || 'REVIEW_ERROR',
      retryable: Boolean(error.retryable)
    });
    console.error('[weekly-review]', error);
    return res.status(502).json({
      error: error.message || '智能审核失败，请检查后端密钥和中转站配置。',
      code: error.code || 'REVIEW_UNKNOWN_ERROR',
      retryable: Boolean(error.retryable)
    });
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
