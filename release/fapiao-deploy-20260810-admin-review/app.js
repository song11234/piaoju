const state = {
  mode: 'loading', authMode: 'register', setup: null, user: null, view: 'submit',
  selectedRole: 'staff', uploadType: 'invoice', reportType: 'daily', reportFilter: 'all', selectedReportUser: null, expandedReportDates: {}, reportCalendarMonth: '', selectedReportDate: '', squareDate: '', squarePickerOpen: false, squarePickerMonth: '', squareUserId: '', squareDocumentPreviews: {}, expenseFiles: [], reportFiles: [], removedReportAttachmentIds: [], editingReportId: null, reportDraft: null, pendingWeeklyReview: null, reviewError: '', expenses: [], users: [], reports: [], squareReports: [], modal: null, busy: false
};

const $ = selector => document.querySelector(selector);
const icon = (name, extra = '') => `<i data-lucide="${name}" ${extra}></i>`;
const initials = name => (name || '').slice(-2);
const money = amount => `¥${Number(amount || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = value => new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(`${String(value).replace(' ', 'T')}Z`)).replaceAll('/', '-');

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...options.headers } });
  const body = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || '请求失败，请稍后再试。');
  return body;
}

async function loadWorkspace() {
  const [expenses, users, reports, squareReports] = await Promise.all([
    api('/api/expenses'),
    state.user.role === 'admin' ? api('/api/users') : Promise.resolve({ users: [] }),
    api('/api/work-reports'),
    api('/api/report-square')
  ]);
  state.expenses = expenses.expenses;
  state.users = users.users;
  state.reports = reports.reports;
  state.squareReports = squareReports.reports;
}

async function bootstrap() {
  try {
    const result = await api('/api/auth/me');
    state.user = result.user;
    state.mode = 'app';
    state.view = state.user.role === 'admin' ? 'overview' : 'submit';
    await loadWorkspace();
  } catch {
    state.mode = 'entry';
    try { state.setup = await api('/api/auth/setup-status'); } catch { state.setup = { hasUsers: false }; }
    if (!state.setup.hasUsers) state.selectedRole = 'admin';
  }
  render();
}

function render() {
  $('#app').innerHTML = state.mode === 'loading' ? loadingScreen() : state.mode === 'entry' ? authScreen() : dashboard();
  if (state.mode === 'app' && state.view === 'report-square') {
    const squareSummary = $('.square-date-summary');
    if (squareSummary) squareSummary.insertAdjacentHTML('afterend', squareExportControls());
  }
  if (window.lucide) lucide.createIcons();
  bindEvents();
  const selectedSquareDate = $('.square-date.selected');
  if (selectedSquareDate) requestAnimationFrame(() => selectedSquareDate.scrollIntoView({ block: 'nearest', inline: 'center' }));
}

function loadingScreen() {
  return `<section class="auth-wrap" style="min-height:100vh"><div class="auth-card"><div class="brand"><span class="brand-mark">${icon('receipt-text')}</span>票据台账</div><p class="auth-sub" style="margin-top:22px">正在连接本地服务...</p></div></section>`;
}

function authScreen() {
  const register = state.authMode === 'register';
  return `<section class="entry">
    <div class="entry-panel"><div class="brand"><span class="brand-mark">${icon('receipt-text')}</span>票据台账</div><div class="entry-copy"><div class="eyebrow">Internal expense workflow</div><h1>让每一笔报销<br>清楚、有据可循。</h1><p>企业内部的报销台账。资料、附件与审核状态统一保存在本机数据库中。</p></div><div class="entry-note">企业内部使用 · 附件仅限登录用户访问</div></div>
    <div class="auth-wrap"><div class="auth-card"><h2>${register ? '创建账号' : '登录系统'}</h2><p class="auth-sub">${register ? (state.setup?.hasUsers ? '请使用本人的信息注册普通人员账号。' : '请创建首个账号，此账号将自动成为管理员。') : '输入已注册的姓名与密码，系统将自动识别权限。'}</p>${register ? registerForm() : loginForm()}</div></div>
  </section>`;
}

function registerForm() {
  return `<form id="register-form">
    ${roleOptions()}
    <div class="form-group"><label for="reg-name">姓名</label><input id="reg-name" required minlength="2" maxlength="30" autocomplete="name" placeholder="请输入本人真实姓名"></div>
    <div class="form-group"><label for="reg-password">密码</label><input id="reg-password" required minlength="6" type="password" autocomplete="new-password" placeholder="设置 6 位以上登录密码"></div>
    <button class="primary" type="submit">${state.busy ? '正在创建...' : '创建账号'}</button>
  </form><div class="auth-switch">已有账号？ <button class="text-action" data-auth="login">立即登录</button></div>`;
}

function loginForm() {
  return `${roleOptions()}<form id="login-form">
    <div class="form-group"><label for="login-name">姓名</label><input id="login-name" required autocomplete="username" placeholder="请输入已注册的姓名"></div>
    <div class="form-group"><label for="login-password">密码</label><input id="login-password" required type="password" autocomplete="current-password" placeholder="请输入密码"></div>
    <button class="primary" type="submit">${state.busy ? '正在登录...' : '登录系统'}</button>
  </form><div class="auth-switch">还没有账号？ <button class="text-action" data-auth="register">立即注册</button></div>`;
}

function roleOptions() {
  return `<div class="role-grid"><button type="button" class="role-button ${state.selectedRole === 'staff' ? 'active' : ''}" data-role="staff">${icon('user-round')}<strong>普通人员</strong><span>提交报销与查看记录</span></button><button type="button" class="role-button ${state.selectedRole === 'admin' ? 'active' : ''}" data-role="admin">${icon('shield-check')}<strong>管理员</strong><span>审核报销与管理员工</span></button></div>`;
}

function dashboard() {
  const admin = state.user.role === 'admin';
  const nav = admin ? [['overview', 'layout-dashboard', '审核概览'], ['report-square', 'panels-top-left', '周日志广场'], ['people', 'users-round', '员工信息']] : [['submit', 'file-plus-2', '提交报销'], ['history', 'clock-3', '历史记录'], ['report-history', 'calendar-days', '提交记录'], ['report-square', 'panels-top-left', '周日志广场'], ['profile', 'user-cog', '我的资料']];
  return `<section class="shell"><aside class="sidebar"><div class="brand"><span class="brand-mark">${icon('receipt-text')}</span>票据台账</div><div class="workspace">${admin ? 'Finance console' : 'My workspace'}</div><nav class="nav">${nav.map(([view, glyph, label]) => `<button class="nav-item ${state.view === view ? 'active' : ''}" data-view="${view}">${icon(glyph)}<span>${label}</span></button>`).join('')}</nav><div class="profile-mini"><span class="avatar">${initials(state.user.name)}</span><div><strong>${state.user.name}</strong><span>${admin ? '管理员' : '普通人员'}</span></div><button class="logout" title="退出登录" data-logout>${icon('log-out')}</button></div></aside><main class="page">${admin ? adminPage() : staffPage()}</main></section>${state.modal ? modal() : ''}`;
}

function staffPage() { if (state.view === 'history') return staffHistory(); if (state.view === 'reports') return staffReports(); if (state.view === 'report-history') return staffReportHistory(); if (state.view === 'report-square') return reportSquare(); if (state.view === 'profile') return profilePage(); return staffSubmit(); }

function staffSubmit() {
  return `<div class="content-width"><header class="topbar"><div><h1 class="page-title">提交报销</h1><p class="page-lead">上传票据并填写本次开销信息。</p></div><div class="date">${today()}</div></header><form id="expense-form" class="section-card"><h2 class="section-title">${icon('paperclip')}附件类型</h2><p class="section-helper">支持 JPG、PNG、WEBP、PDF 格式；一次最多 6 个附件，每个不超过 10MB。</p><div class="upload-choice"><label class="upload-option ${state.uploadType === 'invoice' ? 'selected' : ''}"><input type="radio" name="upload-type" value="invoice" ${state.uploadType === 'invoice' ? 'checked' : ''}><div class="option-top">${icon('receipt-text', 'class="option-icon"')}<span class="radio"></span></div><strong>发票上传</strong><span>增值税发票、行程单等</span></label><label class="upload-option ${state.uploadType === 'image' ? 'selected' : ''}"><input type="radio" name="upload-type" value="image" ${state.uploadType === 'image' ? 'checked' : ''}><div class="option-top">${icon('image', 'class="option-icon"')}<span class="radio"></span></div><strong>普通图片上传</strong><span>收据、付款截图等</span></label></div><div class="dropzone expense-dropzone" id="expense-dropzone" role="button" tabindex="0"><span class="drop-icon">${icon('upload-cloud')}</span><span class="dropzone-copy"><strong>拖入文件，或点击选择</strong><span>最多 6 个附件，支持图片和 PDF</span></span><button class="choose-file" type="button" data-choose-expense-files>选择文件</button><input id="attachment" type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf"></div><div id="expense-file-list" class="expense-file-list">${expenseFileList()}</div><div class="form-grid"><div class="form-group"><label for="amount">报销金额（元）</label><input id="amount" required type="number" min="0.01" step="0.01" placeholder="0.00"></div><div class="form-group"><label for="purpose">开销用途</label><input id="purpose" required minlength="2" maxlength="120" placeholder="例如：客户拜访交通费"></div></div><div class="form-foot"><button class="primary" type="submit">${state.busy ? '正在上传...' : '确认提交'}</button><span class="muted">提交后将进入管理员审核流程</span></div></form></div>`;
}

function staffHistory() {
  const total = state.expenses.reduce((sum, e) => sum + e.amount, 0);
  const paid = state.expenses.filter(e => e.status === 'reimbursed').reduce((sum, e) => sum + e.amount, 0);
  return `<div class="content-width"><header class="topbar"><div><h1 class="page-title">历史记录</h1><p class="page-lead">查看您提交过的报销申请与处理进度。</p></div><div class="date">${today()}</div></header><div class="stats"><div class="stat"><span class="stat-label">累计提交</span><strong>${state.expenses.length}<small>笔</small></strong></div><div class="stat"><span class="stat-label">申请总额</span><strong>${money(total)}</strong></div><div class="stat"><span class="stat-label">已报销金额</span><strong>${money(paid)}</strong></div></div><section class="section-card table-card"><div class="table-toolbar"><h3>提交明细</h3></div>${expenseTable(state.expenses, false)}</section></div>`;
}

function profilePage() {
  return `<div class="content-width"><header class="topbar"><div><h1 class="page-title">我的资料</h1><p class="page-lead">更新您的登录信息。</p></div><div class="date">${today()}</div></header><form id="profile-form" class="section-card"><h2 class="section-title">${icon('user-round-pen')}账户资料</h2><p class="section-helper">保存后，管理员端的员工资料会同步更新。</p><div class="form-grid"><div class="form-group"><label for="profile-name">姓名</label><input id="profile-name" required minlength="2" maxlength="30" value="${escapeHtml(state.user.name)}"></div><div class="form-group"><label for="profile-password">新密码</label><input id="profile-password" minlength="6" type="password" autocomplete="new-password" placeholder="留空则不修改密码"></div></div><div class="form-foot"><button class="primary" type="submit">${state.busy ? '正在保存...' : '保存修改'}</button><span class="muted">修改后请使用新信息登录</span></div></form></div>`;
}

function staffSubmit() {
  return `<div class="content-width"><header class="topbar"><div><h1 class="page-title">提交报销</h1><p class="page-lead">上传票据并填写本次开销信息。</p></div><div class="date">${today()}</div></header><form id="expense-form" class="section-card"><h2 class="section-title">${icon('paperclip')}附件类型</h2><p class="section-helper">支持 JPG、PNG、WEBP、PDF 格式；一次最多 20 个附件，每个不超过 10MB。</p><div class="upload-choice"><label class="upload-option ${state.uploadType === 'invoice' ? 'selected' : ''}"><input type="radio" name="upload-type" value="invoice" ${state.uploadType === 'invoice' ? 'checked' : ''}><div class="option-top">${icon('receipt-text', 'class="option-icon"')}<span class="radio"></span></div><strong>发票上传</strong><span>增值税发票、行程单等</span></label><label class="upload-option ${state.uploadType === 'image' ? 'selected' : ''}"><input type="radio" name="upload-type" value="image" ${state.uploadType === 'image' ? 'checked' : ''}><div class="option-top">${icon('image', 'class="option-icon"')}<span class="radio"></span></div><strong>普通图片上传</strong><span>收据、付款截图等</span></label></div><div class="dropzone expense-dropzone" id="expense-dropzone" role="button" tabindex="0"><span class="drop-icon">${icon('upload-cloud')}</span><span class="dropzone-copy"><strong>拖入文件，或点击选择</strong><span>最多 20 个附件，支持图片和 PDF</span></span><button class="choose-file" type="button" data-choose-expense-files>选择文件</button><input id="attachment" type="file" multiple accept="image/jpeg,image/png,image/webp,application/pdf"></div><div id="expense-file-list" class="expense-file-list">${expenseFileList()}</div><div class="form-grid"><div class="form-group"><label for="amount">报销金额（元）</label><input id="amount" required type="number" min="0.01" step="0.01" placeholder="0.00"></div><div class="form-group"><label for="purpose">开销用途</label><input id="purpose" required minlength="2" maxlength="120" placeholder="例如：客户拜访交通费"></div></div><div class="form-foot"><button class="primary" type="submit">${state.busy ? '正在上传...' : '确认提交'}</button><span class="muted">提交后将进入管理员审核流程</span></div></form></div>`;
}

function setExpenseFiles(files) {
  const nextFiles = Array.from(files || []);
  if (nextFiles.length > 20) showToast('一次最多选择 20 个附件，已保留前 20 个。');
  state.expenseFiles = nextFiles.slice(0, 20);
  refreshExpenseFileList();
}

function staffReports() {
  const daily = state.reportType === 'daily';
  const reports = state.reports;
  return `<div class="report-page"><header class="topbar"><div><h1 class="page-title">日报与周报</h1><p class="page-lead">记录每日工作进展，并提交阶段性周报。</p></div><div class="date">${today()}</div></header><div class="report-layout"><section class="section-card report-form-card"><div class="report-form-head"><div><h2 class="section-title">${icon('notebook-pen')}提交工作汇报</h2><p class="section-helper">同一周期再次提交会更新原内容。</p></div><div class="report-type-switch"><button type="button" class="${daily ? 'active' : ''}" data-report-type="daily">日报</button><button type="button" class="${!daily ? 'active' : ''}" data-report-type="weekly">周报</button></div></div><form id="work-report-form"><div class="report-date-grid">${daily ? `<div class="form-group"><label for="report-start">汇报日期</label><input id="report-start" type="date" required value="${todayInput()}"></div>` : `<div class="form-group"><label for="report-start">开始日期</label><input id="report-start" type="date" required value="${weekStartInput()}"></div><div class="form-group"><label for="report-end">结束日期</label><input id="report-end" type="date" required value="${todayInput()}"></div>`}</div><div class="form-group"><label for="report-content">工作内容</label><textarea id="report-content" required minlength="5" maxlength="5000" placeholder="填写完成事项、当前进展、问题与下步计划"></textarea></div><div class="form-foot"><button class="primary" type="submit">${state.busy ? '正在提交...' : daily ? '提交日报' : '提交周报'}</button><span class="muted">内容会同步给管理员查看</span></div></form></section><section class="section-card report-history-card"><div class="table-toolbar"><h3>我的提交记录</h3><span class="muted">${reports.length} 条</span></div>${reportList(reports, false)}</section></div></div>`;
}

function adminPage() { if (state.view === 'people') return peoplePage(); if (state.view === 'reports') return reportSquare(); if (state.view === 'report-square') return reportSquare(); return adminOverview(); }

function adminOverview() {
  const pending = state.expenses.filter(e => e.status === 'pending');
  const pendingAmount = pending.reduce((sum, e) => sum + e.amount, 0);
  return `<div><header class="topbar"><div><h1 class="page-title">报销审核概览</h1><p class="page-lead">管理团队的报销申请与付款状态。</p></div><div class="date">${today()}</div></header><div class="admin-summary"><div class="admin-stat"><span class="mini-icon">${icon('files')}</span><strong>${state.expenses.length}</strong><span>累计提交申请</span></div><div class="admin-stat"><span class="mini-icon">${icon('circle-dollar-sign')}</span><strong>${money(pendingAmount)}</strong><span>待报销金额</span></div><div class="admin-stat"><span class="mini-icon">${icon('hourglass')}</span><strong>${pending.length}</strong><span>待处理申请</span></div></div>${expensePeopleSummary()}<section class="section-card table-card"><div class="table-toolbar"><h3>报销申请</h3><div class="search">${icon('search')}<input placeholder="搜索姓名或用途" id="admin-search"></div></div><div id="admin-table">${expenseTable(state.expenses, true)}</div></section></div>`;
}

function expensePeopleSummary() {
  const byPerson = new Map();
  state.expenses.forEach(expense => {
    const current = byPerson.get(expense.user.id) || { ...expense.user, count: 0, total: 0, pending: 0 };
    current.count += 1; current.total += expense.amount; if (expense.status === 'pending') current.pending += expense.amount;
    byPerson.set(expense.user.id, current);
  });
  const people = [...byPerson.values()].sort((a, b) => b.total - a.total);
  return `<section class="expense-people-section"><div class="section-band-head"><div><h2>按员工汇总</h2><p>每位员工的申请笔数、累计金额与待报销金额。</p></div><span>${people.length} 人</span></div>${people.length ? `<div class="expense-people-grid">${people.map(person => `<article class="expense-person-card"><div class="person"><span class="avatar">${initials(person.name)}</span><div><strong>${person.name}</strong><span class="muted">${person.count} 笔申请</span></div></div><div class="expense-person-total"><span>累计申请</span><strong>${money(person.total)}</strong></div><div class="expense-person-pending"><span>待报销</span><strong>${money(person.pending)}</strong></div></article>`).join('')}</div>` : '<div class="empty">暂无员工报销数据</div>'}</section>`;
}

function adminReports() {
  const byPerson = new Map();
  state.reports.forEach(report => { const list = byPerson.get(report.user.id) || { user: report.user, reports: [] }; list.reports.push(report); byPerson.set(report.user.id, list); });
  const groups = state.users.filter(user => user.role === 'staff').map(user => byPerson.get(user.id) || { user, reports: [] }).sort((a, b) => a.user.name.localeCompare(b.user.name, 'zh-CN'));
  if (!groups.some(group => group.user.id === state.selectedReportUser)) state.selectedReportUser = groups[0]?.user.id || null;
  const selected = groups.find(group => group.user.id === state.selectedReportUser);
  const selectedReports = selected ? selected.reports.filter(report => state.reportFilter === 'all' || report.type === state.reportFilter) : [];
  const submittedPeople = groups.filter(group => group.reports.length).length;
  return `<div class="report-admin-page"><header class="topbar"><div><h1 class="page-title">日志与周报</h1><p class="page-lead">选择员工后，集中阅读该员工的日报和周报。</p></div><div class="date">${today()}</div></header><div class="report-admin-summary"><span class="mini-icon">${icon('notebook-tabs')}</span><div><strong>${state.reports.length}</strong><span>累计提交日志</span></div><div><strong>${submittedPeople}</strong><span>已提交员工</span></div><div><strong>${groups.length}</strong><span>普通人员</span></div></div><div class="admin-reports-layout"><section class="admin-report-directory"><div class="admin-report-directory-head"><div><h2>员工列表</h2><p>点击员工查看其汇报</p></div><span>${groups.length} 人</span></div><div class="report-people-search">${icon('search')}<input id="report-people-search" placeholder="搜索员工姓名"></div><div id="report-people-list" class="admin-report-person-list">${reportPersonDirectory(groups)}</div></section><section class="admin-report-detail"><header class="admin-report-detail-head">${selected ? `<div class="person"><span class="avatar">${initials(selected.user.name)}</span><div><h2>${selected.user.name}</h2><span>${selected.reports.length} 条汇报</span></div></div>` : '<div><h2>请选择员工</h2><span>员工提交后会显示在左侧列表</span></div>'}<label class="report-filter"><span>查看类型</span><select id="admin-report-filter"><option value="all" ${state.reportFilter === 'all' ? 'selected' : ''}>全部汇报</option><option value="daily" ${state.reportFilter === 'daily' ? 'selected' : ''}>日报</option><option value="weekly" ${state.reportFilter === 'weekly' ? 'selected' : ''}>周报</option></select></label></header><div class="admin-report-detail-list">${reportList(selectedReports, true)}</div></section></div></div>`;
}

function reportPersonDirectory(groups) {
  if (!groups.length) return '<div class="empty">暂时没有普通人员</div>';
  return groups.map(group => {
    const daily = group.reports.filter(report => report.type === 'daily').length;
    const weekly = group.reports.filter(report => report.type === 'weekly').length;
    return `<button type="button" class="admin-report-person ${state.selectedReportUser === group.user.id ? 'active' : ''}" data-report-person="${group.user.id}"><span class="avatar">${initials(group.user.name)}</span><span class="admin-report-person-name"><strong>${group.user.name}</strong><small>${group.reports.length ? `${group.reports.length} 条汇报` : '暂无汇报'}</small></span><span class="admin-report-person-count">${daily} 日<br>${weekly} 周</span>${icon('chevron-right')}</button>`;
  }).join('');
}

function reportList(reports, admin) {
  if (!reports.length) return '<div class="empty">暂无提交记录</div>';
  return `<div class="report-list">${reports.map(report => `<article class="report-item ${report.type}"><div class="report-item-head"><span class="report-badge ${report.type}">${report.type === 'daily' ? '日报' : '周报'}</span><strong>${report.type === 'daily' ? report.periodStart : `${report.periodStart} 至 ${report.periodEnd}`}</strong><time>${fmtDate(report.submittedAt)}</time>${admin ? '' : `<button type="button" class="report-delete" data-delete-report="${report.id}" title="删除此汇报" aria-label="删除此汇报">${icon('trash-2')}</button>`}</div><p>${formatReportContent(report.content)}</p>${admin ? '' : `<span class="report-updated">已提交</span>`}</article>`).join('')}</div>`;
}

function formatReportContent(content) { return escapeHtml(content).replaceAll('\n', '<br>'); }

function expenseTable(entries, admin) {
  if (!entries.length) return '<div class="empty">暂无报销记录</div>';
  return `<div class="table-wrap"><table><thead><tr>${admin ? '<th>申请人</th>' : ''}<th>提交日期</th><th>用途</th><th>金额</th><th>附件</th><th>状态</th>${admin ? '<th>操作</th>' : ''}</tr></thead><tbody>${entries.map(e => `<tr>${admin ? `<td><div class="person"><span class="avatar tiny">${initials(e.user.name)}</span><button data-person="${e.user.id}">${e.user.name}</button></div></td>` : ''}<td>${fmtDate(e.submittedAt)}</td><td>${e.purpose}</td><td class="money">${money(e.amount)}</td><td><button class="file-link" data-attachment="${e.attachment.id}">${icon('paperclip')}${e.attachment.name}</button></td><td><span class="status ${e.status === 'reimbursed' ? 'done' : 'pending'}">${e.status === 'reimbursed' ? '已报销' : '待报销'}</span></td>${admin ? `<td><button class="action-btn ${e.status === 'reimbursed' ? 'disabled' : ''}" data-reimburse="${e.id}" ${e.status === 'reimbursed' ? 'disabled' : ''}>${e.status === 'reimbursed' ? '已完成' : '标记已报销'}</button></td>` : ''}</tr>`).join('')}</tbody></table></div>`;
}

function peoplePage() {
  const staff = state.users.filter(user => user.role === 'staff');
  const pending = state.expenses.filter(expense => expense.status === 'pending');
  const reimbursed = state.expenses.filter(expense => expense.status === 'reimbursed');
  return `<div class="people-page"><header class="topbar"><div><h1 class="page-title">员工信息</h1><p class="page-lead">查看员工资料及提交情况。</p></div><div class="date">${today()}</div></header><div class="people-layout"><section class="section-card employee-panel"><div class="directory-head"><div><h2 class="section-title">${icon('users-round')}员工目录</h2><p class="section-helper">共 ${staff.length} 位普通人员</p></div><div class="search people-search">${icon('search')}<input id="people-search" placeholder="搜索员工姓名"></div></div><div class="employee-list" id="employee-list">${employeeList(staff)}</div></section><aside class="directory-aside"><section class="team-card"><div class="team-card-head"><div><span class="eyebrow">Team expenses</span><h2>团队报销概览</h2></div><span class="mini-icon">${icon('wallet-cards')}</span></div><div class="team-total"><span>累计申请金额</span><strong>${money(state.expenses.reduce((sum, expense) => sum + expense.amount, 0))}</strong></div><div class="team-split"><div><span class="metric-dot amber"></span><p>待报销</p><strong>${money(pending.reduce((sum, expense) => sum + expense.amount, 0))}</strong></div><div><span class="metric-dot teal"></span><p>已报销</p><strong>${money(reimbursed.reduce((sum, expense) => sum + expense.amount, 0))}</strong></div></div></section><section class="account-card"><div class="account-card-head"><h3>${icon('user-check')}员工概览</h3><span>${staff.length} 人</span></div>${staff.length ? staff.slice(0, 4).map(user => `<button class="account-person" data-person="${user.id}"><span class="avatar tiny">${initials(user.name)}</span><span><strong>${user.name}</strong><small>累计 ${user.expenseCount} 笔申请</small></span><span class="account-tail">${icon('chevron-right')}</span></button>`).join('') : '<div class="empty">暂无员工资料</div>'}</section></aside></div></div>`;
}

function employeeList(users) {
  return users.length ? users.map(user => `<article class="employee-row"><div class="person"><span class="avatar">${initials(user.name)}</span><div><button data-person="${user.id}">${user.name}</button><span class="muted">普通人员</span></div></div><div class="row-stat"><span>提交记录</span><strong>${user.expenseCount} 笔</strong></div><div class="amount">累计申请<strong>${money(user.expenseTotal)}</strong></div><button class="action-btn" data-person="${user.id}">查看资料</button></article>`).join('') : '<div class="empty">没有符合条件的员工</div>';
}

function adminReports() {
  const byPerson = new Map();
  state.reports.forEach(report => { const list = byPerson.get(report.user.id) || { user: report.user, reports: [] }; list.reports.push(report); byPerson.set(report.user.id, list); });
  const groups = state.users.filter(user => user.role === 'staff').map(user => byPerson.get(user.id) || { user, reports: [] }).sort((a, b) => a.user.name.localeCompare(b.user.name, 'zh-CN'));
  if (!groups.some(group => group.user.id === state.selectedReportUser)) state.selectedReportUser = groups[0]?.user.id || null;
  const selected = groups.find(group => group.user.id === state.selectedReportUser);
  const selectedReports = selected ? selected.reports.filter(report => state.reportFilter === 'all' || report.type === state.reportFilter) : [];
  const submittedPeople = groups.filter(group => group.reports.length).length;
  return `<div class="report-admin-page"><header class="topbar"><div><h1 class="page-title">日志与周报</h1><p class="page-lead">选择员工后，集中阅读和导出该员工的日报与周报。</p></div><div class="date">${today()}</div></header><div class="report-admin-summary"><span class="mini-icon">${icon('notebook-tabs')}</span><div><strong>${state.reports.length}</strong><span>累计提交日志</span></div><div><strong>${submittedPeople}</strong><span>已提交员工</span></div><div><strong>${groups.length}</strong><span>普通人员</span></div></div>${selected ? reportExportControls(selected.user.id, selected.user.name) : ''}<div class="admin-reports-layout"><section class="admin-report-directory"><div class="admin-report-directory-head"><div><h2>员工列表</h2><p>点击员工查看其汇报</p></div><span>${groups.length} 人</span></div><div class="report-people-search">${icon('search')}<input id="report-people-search" placeholder="搜索员工姓名"></div><div id="report-people-list" class="admin-report-person-list">${reportPersonDirectory(groups)}</div></section><section class="admin-report-detail"><header class="admin-report-detail-head">${selected ? `<div class="person"><span class="avatar">${initials(selected.user.name)}</span><div><h2>${escapeHtml(selected.user.name)}</h2><span>${selected.reports.length} 条汇报</span></div></div>` : '<div><h2>请选择员工</h2><span>员工提交后会显示在左侧列表</span></div>'}<label class="report-filter"><span>查看类型</span><select id="admin-report-filter"><option value="all" ${state.reportFilter === 'all' ? 'selected' : ''}>全部汇报</option><option value="daily" ${state.reportFilter === 'daily' ? 'selected' : ''}>日报</option><option value="weekly" ${state.reportFilter === 'weekly' ? 'selected' : ''}>周报</option></select></label></header><div class="admin-report-detail-list">${reportList(selectedReports, true)}</div></section></div></div>`;
}

function legacyModal() {
  if (state.modal.type === 'weekly-review') {
    const review = state.pendingWeeklyReview?.review;
    if (!review) return '';
    const list = (items, empty) => items?.length ? `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : `<p class="muted">${empty}</p>`;
    const status = review.decision === 'needs_revision' ? '建议修改后提交' : '可以确认提交';
    return `<div class="modal-backdrop review-backdrop" data-backdrop><section class="modal weekly-review-modal" role="dialog" aria-modal="true" aria-labelledby="weekly-review-title"><div class="modal-head"><div><p class="review-kicker">智能周报审核</p><h3 id="weekly-review-title">审核结果</h3></div><button class="close" data-return-weekly-edit title="返回修改" aria-label="返回修改">${icon('x')}</button></div><div class="review-score-row"><div class="review-score"><strong>${review.score}</strong><span>分</span></div><div><span class="review-decision ${review.decision === 'needs_revision' ? 'revision' : 'ready'}">${status}</span><p>${escapeHtml(review.summary)}</p></div></div><div class="review-findings"><section><h4>${icon('badge-check')}做得较好</h4>${list(review.strengths, '审核未列出特别项')}</section><section><h4>${icon('circle-alert')}需要关注</h4>${list(review.issues, '未发现明显问题')}</section><section><h4>${icon('list-checks')}修改建议</h4>${list(review.suggestions, '当前可以直接确认提交')}</section></div><div class="review-note">评分和分析会在确认提交后保存，管理员端和导出 Excel 均可查看。</div><div class="form-foot review-actions"><button type="button" class="action-btn" data-return-weekly-edit>返回更改</button><button type="button" class="primary" data-submit-weekly-review>确认提交</button></div></section></div>`;
  }
  if (state.modal.type === 'attachment') {
    const expense = state.expenses.find(item => item.attachment.id === state.modal.id);
    const isImage = expense.attachment.mimeType.startsWith('image/');
    return `<div class="modal-backdrop" data-backdrop><section class="modal"><div class="modal-head"><div><h3>附件预览</h3><p class="section-helper">${expense.attachment.name}</p></div><button class="close" data-close>${icon('x')}</button></div><div class="attachment-preview">${isImage ? `<img class="attachment-image" src="/api/attachments/${expense.attachment.id}" alt="${expense.attachment.name}">` : `<div class="receipt"><div class="receipt-logo">PDF 凭证</div><div class="receipt-line"></div><div class="receipt-line short"></div><div class="receipt-line"></div><div class="receipt-line short"></div><div class="receipt-total">${money(expense.amount)}</div></div>`}<div class="attachment-info"><strong>${expense.attachment.name}</strong><p>${expense.receiptType === 'invoice' ? '发票凭证' : '普通图片凭证'} · ${formatBytes(expense.attachment.size)}</p><a class="action-btn" href="/api/attachments/${expense.attachment.id}" target="_blank" rel="noopener">${icon('external-link')} 打开原文件</a></div></div><div class="detail-list"><div><span>申请人</span><strong>${expense.user.name}</strong></div><div><span>报销金额</span><strong class="money">${money(expense.amount)}</strong></div><div><span>开销用途</span><strong>${expense.purpose}</strong></div><div><span>当前状态</span><strong><span class="status ${expense.status === 'reimbursed' ? 'done' : 'pending'}">${expense.status === 'reimbursed' ? '已报销' : '待报销'}</span></strong></div></div></section></div>`;
  }
  const user = state.users.find(item => item.id === state.modal.id);
  return `<div class="modal-backdrop" data-backdrop><section class="modal"><div class="modal-head"><div><h3>员工资料</h3><p class="section-helper">普通人员</p></div><button class="close" data-close>${icon('x')}</button></div><div class="person" style="margin-bottom:20px"><span class="avatar" style="width:46px;height:46px;font-size:15px">${initials(user.name)}</span><div><strong style="font-size:16px">${user.name}</strong><span class="muted" style="display:block;margin-top:3px">注册于 ${fmtDate(user.createdAt)}</span></div></div><div class="detail-list"><div><span>累计提交</span><strong>${user.expenseCount} 笔</strong></div><div><span>累计申请金额</span><strong class="money">${money(user.expenseTotal)}</strong></div><div><span>账号身份</span><strong>普通人员</strong></div><div><span>账户状态</span><strong>正常</strong></div></div></section></div>`;
}

function bindEvents() {
  document.querySelectorAll('[data-auth]').forEach(el => el.addEventListener('click', () => { state.authMode = el.dataset.auth; state.busy = false; render(); }));
  document.querySelectorAll('[data-role]').forEach(el => el.addEventListener('click', () => { state.selectedRole = el.dataset.role; render(); }));
  document.querySelectorAll('[data-view]').forEach(el => el.addEventListener('click', async () => { state.view = el.dataset.view; if (state.user.role === 'admin' || state.view === 'report-square') await loadWorkspace(); render(); }));
  document.querySelectorAll('[data-report-type]').forEach(el => el.addEventListener('click', () => {
    state.reportType = el.dataset.reportType;
    state.reportFiles = [];
    state.pendingWeeklyReview = null;
    state.reviewError = '';
    state.reportDraft = null;
    render();
  }));
  document.querySelectorAll('[data-square-date]').forEach(el => el.addEventListener('click', () => {
    state.squareDate = el.dataset.squareDate;
    render();
  }));
  document.querySelectorAll('[data-square-submit]').forEach(el => el.addEventListener('click', () => {
    state.view = 'reports';
    state.reportType = 'daily';
    state.editingReportId = null;
    state.reportFiles = [];
    state.removedReportAttachmentIds = [];
    state.reportDraft = null;
    state.pendingWeeklyReview = null;
    state.reviewError = '';
    render();
  }));
  document.querySelectorAll('[data-report-square-back]').forEach(el => el.addEventListener('click', () => {
    state.view = 'report-square';
    state.editingReportId = null;
    state.reportFiles = [];
    state.removedReportAttachmentIds = [];
    state.reportDraft = null;
    state.pendingWeeklyReview = null;
    state.reviewError = '';
    render();
  }));
  document.querySelectorAll('[data-square-shift]').forEach(el => el.addEventListener('click', () => {
    state.squareDate = shiftDate(state.squareDate || todayInput(), Number(el.dataset.squareShift));
    render();
  }));
  document.querySelectorAll('[data-square-picker-toggle]').forEach(el => el.addEventListener('click', () => {
    state.squarePickerOpen = !state.squarePickerOpen;
    state.squarePickerMonth = (state.squareDate || todayInput()).slice(0, 7);
    render();
  }));
  document.querySelectorAll('[data-square-picker-nav]').forEach(el => el.addEventListener('click', () => {
    state.squarePickerMonth = shiftMonth(state.squarePickerMonth || (state.squareDate || todayInput()).slice(0, 7), Number(el.dataset.squarePickerNav));
    render();
  }));
  document.querySelectorAll('[data-square-picker-date]').forEach(el => el.addEventListener('click', () => {
    state.squareDate = el.dataset.squarePickerDate;
    state.squarePickerMonth = state.squareDate.slice(0, 7);
    state.squarePickerOpen = false;
    render();
  }));
  document.querySelectorAll('[data-square-picker-today]').forEach(el => el.addEventListener('click', () => {
    state.squareDate = todayInput();
    state.squarePickerMonth = state.squareDate.slice(0, 7);
    state.squarePickerOpen = false;
    render();
  }));
  document.querySelectorAll('[data-square-user]').forEach(el => el.addEventListener('click', () => {
    state.squareUserId = el.dataset.squareUser === 'all' ? '' : el.dataset.squareUser;
    render();
  }));
  document.querySelectorAll('[data-open-square-weekly-report]').forEach(el => el.addEventListener('click', async () => {
    const report = state.squareReports.find(item => String(item.id) === String(el.dataset.openSquareWeeklyReport));
    const selectedAttachmentId = el.dataset.openSquareWeeklyAttachment;
    state.modal = { type: 'square-weekly-report', id: el.dataset.openSquareWeeklyReport, attachmentId: selectedAttachmentId || null };
    if (!report) return render();
    const docxAttachments = (report.attachments || (report.attachment ? [report.attachment] : [])).filter(attachment => String(attachment.id) === String(selectedAttachmentId) && (attachment.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || /\.docx$/i.test(attachment.name)));
    docxAttachments.forEach(attachment => {
      const key = `${report.id}:${attachment.id}`;
      if (!state.squareDocumentPreviews[key]) state.squareDocumentPreviews[key] = { loading: true };
    });
    render();
    await Promise.all(docxAttachments.map(async attachment => {
      const key = `${report.id}:${attachment.id}`;
      if (!state.squareDocumentPreviews[key]?.loading) return;
      try {
        state.squareDocumentPreviews[key] = await api(`/api/report-square/${report.id}/documents/${attachment.id}/preview`);
      } catch (error) {
        state.squareDocumentPreviews[key] = { error: error.message || '文档内容载入失败，请下载原文件查看。' };
      }
    }));
    if (state.modal?.type === 'square-weekly-report' && String(state.modal.id) === String(report.id)) render();
  }));
  document.querySelectorAll('[data-calendar-nav]').forEach(el => el.addEventListener('click', () => {
    state.reportCalendarMonth = shiftMonth(state.reportCalendarMonth || todayInput().slice(0, 7), Number(el.dataset.calendarNav));
    render();
  }));
  document.querySelectorAll('[data-calendar-date]').forEach(el => el.addEventListener('click', () => {
    state.selectedReportDate = el.dataset.calendarDate;
    state.reportCalendarMonth = state.selectedReportDate.slice(0, 7);
    render();
  }));
  document.querySelectorAll('[data-calendar-today]').forEach(el => el.addEventListener('click', () => {
    state.reportCalendarMonth = todayInput().slice(0, 7);
    state.selectedReportDate = todayInput();
    render();
  }));
  document.querySelectorAll('[data-calendar-clear]').forEach(el => el.addEventListener('click', () => { state.selectedReportDate = ''; render(); }));
  document.querySelectorAll('[data-report-group]').forEach(el => el.addEventListener('click', () => {
    const key = el.dataset.reportGroup;
    state.expandedReportDates[key] = !state.expandedReportDates[key];
    render();
  }));
  const bindReportPersonSelection = () => document.querySelectorAll('[data-report-person]').forEach(el => el.addEventListener('click', () => { state.selectedReportUser = Number(el.dataset.reportPerson); render(); }));
  bindReportPersonSelection();
  const adminReportFilter = $('#admin-report-filter');
  if (adminReportFilter) adminReportFilter.addEventListener('change', () => { state.reportFilter = adminReportFilter.value; render(); });
  document.querySelectorAll('[data-report-export-date]').forEach(el => el.addEventListener('change', () => {
    if (el.dataset.reportExportDate === 'start') state.reportExportStart = el.value;
    if (el.dataset.reportExportDate === 'end') state.reportExportEnd = el.value;
  }));
  document.querySelectorAll('[data-export-reports]').forEach(el => el.addEventListener('click', async () => {
    const periodStart = $('#report-export-start')?.value;
    const periodEnd = $('#report-export-end')?.value;
    if (!periodStart || !periodEnd || periodEnd < periodStart) return showToast('请选择正确的导出开始和结束日期');
    const params = new URLSearchParams({ start: periodStart, end: periodEnd });
    if (el.dataset.exportReports) params.set('userId', el.dataset.exportReports);
    const originalHtml = el.innerHTML;
    el.disabled = true;
    el.textContent = '正在生成 Excel...';
    try {
      const response = await fetch(`/api/work-reports/export?${params.toString()}`, { credentials: 'same-origin' });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || '导出失败，请稍后再试');
      }
      const disposition = response.headers.get('content-disposition') || '';
      const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
      const fileName = encodedName ? decodeURIComponent(encodedName) : '日报周报.xlsx';
      const blobUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(blobUrl);
      showToast('Excel 已开始下载');
    } catch (error) {
      showToast(error.message);
    } finally {
      el.disabled = false;
      el.innerHTML = originalHtml;
      if (window.lucide) lucide.createIcons();
    }
  }));
  const login = $('#login-form');
  if (login) login.addEventListener('submit', async event => {
    event.preventDefault(); const credentials = { name: $('#login-name').value, phone: $('#login-phone').value, role: state.selectedRole }; state.busy = true; render();
    try { const result = await api('/api/auth/login', { method: 'POST', body: JSON.stringify(credentials) }); await startSession(result.user); } catch (error) { state.busy = false; render(); showToast(error.message); }
  });
  const register = $('#register-form');
  if (register) register.addEventListener('submit', async event => {
    event.preventDefault(); const registration = { name: $('#reg-name').value, phone: $('#reg-phone').value, role: state.selectedRole }; state.busy = true; render();
    try { const result = await api('/api/auth/register', { method: 'POST', body: JSON.stringify(registration) }); await startSession(result.user); showToast(result.firstAdmin ? '管理员账号已创建' : '账号已创建'); } catch (error) { state.busy = false; render(); showToast(error.message); }
  });
  document.querySelectorAll('input[name="upload-type"]').forEach(el => el.addEventListener('change', () => { state.uploadType = el.value; render(); }));
  const attachment = $('#attachment');
  if (attachment) attachment.addEventListener('change', () => setExpenseFiles(attachment.files));
  const expenseDropzone = $('#expense-dropzone');
  if (expenseDropzone && attachment) {
    const openExpenseFiles = () => attachment.click();
    expenseDropzone.addEventListener('click', event => { if (event.target !== attachment) openExpenseFiles(); });
    expenseDropzone.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openExpenseFiles(); } });
    expenseDropzone.addEventListener('dragover', event => { event.preventDefault(); expenseDropzone.classList.add('dragging'); });
    expenseDropzone.addEventListener('dragleave', event => { if (!expenseDropzone.contains(event.relatedTarget)) expenseDropzone.classList.remove('dragging'); });
    expenseDropzone.addEventListener('drop', event => { event.preventDefault(); expenseDropzone.classList.remove('dragging'); setExpenseFiles(event.dataTransfer.files); });
  }
  document.querySelectorAll('[data-choose-expense-files]').forEach(el => el.addEventListener('click', event => { event.stopPropagation(); attachment?.click(); }));
  bindExpenseFileActions();
  const expense = $('#expense-form');
  if (expense) expense.addEventListener('submit', async event => {
    event.preventDefault(); const files = state.expenseFiles; const amount = $('#amount').value; const purpose = $('#purpose').value; if (!files.length) return showToast('请先选择附件。');
    state.busy = true; render();
    try { const form = new FormData(); files.forEach(file => form.append('attachments', file)); form.append('amount', amount); form.append('purpose', purpose); form.append('receiptType', state.uploadType); await api('/api/expenses', { method: 'POST', body: form }); await loadWorkspace(); state.expenseFiles = []; state.busy = false; state.view = 'history'; render(); showToast('报销申请已提交'); } catch (error) { state.busy = false; render(); showToast(error.message); }
  });
  const reportAttachment = $('#report-attachment');
  if (reportAttachment) reportAttachment.addEventListener('change', () => {
    setReportFiles(reportAttachment.files);
    reportAttachment.value = '';
  });
  document.querySelectorAll('[data-remove-report-file]').forEach(el => el.addEventListener('click', () => {
    state.reportFiles.splice(Number(el.dataset.removeReportFile), 1);
    state.pendingWeeklyReview = null;
    state.reviewError = '';
    refreshReportFileList();
  }));
  document.querySelectorAll('[data-remove-existing-report-attachment]').forEach(el => el.addEventListener('click', () => {
    const attachmentId = Number(el.dataset.removeExistingReportAttachment);
    if (!state.removedReportAttachmentIds.includes(attachmentId)) state.removedReportAttachmentIds.push(attachmentId);
    state.pendingWeeklyReview = null;
    state.reviewError = '';
    refreshReportFileList();
  }));
  document.querySelectorAll('[data-edit-report]').forEach(el => el.addEventListener('click', () => {
    const report = state.reports.find(item => item.id === Number(el.dataset.editReport));
    if (!report) return;
    state.editingReportId = report.id;
    state.reportType = report.type;
    state.reportFiles = [];
    state.removedReportAttachmentIds = [];
    state.pendingWeeklyReview = null;
    state.reviewError = '';
    state.reportDraft = { periodStart: report.periodStart, periodEnd: report.periodEnd };
    state.view = 'reports';
    render();
  }));
  document.querySelectorAll('[data-cancel-report-edit]').forEach(el => el.addEventListener('click', () => {
    state.editingReportId = null;
    state.reportFiles = [];
    state.removedReportAttachmentIds = [];
    state.pendingWeeklyReview = null;
    state.reviewError = '';
    state.reportDraft = null;
    render();
  }));
  const workReport = $('#work-report-form');
  if (workReport) workReport.addEventListener('submit', async event => {
    event.preventDefault();
    const isWeekly = state.reportType === 'weekly';
    if (isWeekly) return reviewWeeklyReport();
    submitWorkReport();
  });
  document.querySelectorAll('[data-submit-weekly-review]').forEach(el => el.addEventListener('click', () => submitWorkReport(state.pendingWeeklyReview?.reviewToken)));
  document.querySelectorAll('[data-return-weekly-edit]').forEach(el => el.addEventListener('click', () => { state.modal = null; render(); }));
  document.querySelectorAll('[data-delete-report]').forEach(el => el.addEventListener('click', async () => {
    if (!window.confirm('确定删除这条汇报吗？删除后无法恢复。')) return;
    try {
      await api(`/api/work-reports/${el.dataset.deleteReport}`, { method: 'DELETE' });
      await loadWorkspace();
      render();
      showToast('汇报已删除');
    } catch (error) { showToast(error.message); }
  }));
  const profile = $('#profile-form');
  if (profile) profile.addEventListener('submit', async event => {
    event.preventDefault(); const profileData = { name: $('#profile-name').value, phone: $('#profile-phone').value }; state.busy = true; render();
    try { const result = await api('/api/profile', { method: 'PATCH', body: JSON.stringify(profileData) }); state.user = result.user; state.busy = false; render(); showToast('个人资料已更新'); } catch (error) { state.busy = false; render(); showToast(error.message); }
  });
  const employeeEdit = $('#employee-edit-form');
  if (employeeEdit) employeeEdit.addEventListener('submit', async event => {
    event.preventDefault();
    const userId = employeeEdit.dataset.userId;
    try {
      await api(`/api/users/${userId}`, { method: 'PATCH', body: JSON.stringify({ name: $('#employee-name').value, phone: $('#employee-phone').value }) });
      await loadWorkspace();
      state.modal = null;
      render();
      showToast('员工信息已更新');
    } catch (error) { showToast(error.message); }
  });
  bindTableActions();
  document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => { state.modal = null; render(); }));
  document.querySelectorAll('[data-backdrop]').forEach(el => el.addEventListener('click', event => { if (event.target === el) { state.modal = null; render(); } }));
  document.querySelectorAll('.document-reader-content .weekly-document-preview > header > span:first-child').forEach(el => {
    const label = el.textContent.trim();
    if (label) el.title = label;
  });
  document.querySelectorAll('[data-logout]').forEach(el => el.addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }).catch(() => {}); state.mode = 'entry'; state.authMode = 'login'; state.selectedRole = 'staff'; state.user = null; state.expenses = []; state.users = []; state.reports = []; state.squareReports = []; state.squareDate = ''; state.squarePickerOpen = false; state.squarePickerMonth = ''; state.squareUserId = ''; render(); }));
  const search = $('#admin-search');
  if (search) search.addEventListener('input', () => { const keyword = search.value.trim().toLowerCase(); $('#admin-table').innerHTML = expenseTable(state.expenses.filter(e => `${e.user.name}${e.purpose}`.toLowerCase().includes(keyword)), true); if (window.lucide) lucide.createIcons(); bindTableActions(); });
  const peopleSearch = $('#people-search');
  if (peopleSearch) peopleSearch.addEventListener('input', () => { const keyword = peopleSearch.value.trim().toLowerCase(); $('#employee-list').innerHTML = employeeList(state.users.filter(user => user.role === 'staff' && user.name.toLowerCase().includes(keyword))); if (window.lucide) lucide.createIcons(); bindTableActions(); });
  const reportPeopleSearch = $('#report-people-search');
  if (reportPeopleSearch) reportPeopleSearch.addEventListener('input', () => {
    const keyword = reportPeopleSearch.value.trim().toLowerCase();
    const grouped = new Map();
    state.reports.forEach(report => { const list = grouped.get(report.user.id) || { user: report.user, reports: [] }; list.reports.push(report); grouped.set(report.user.id, list); });
    const people = state.users.filter(user => user.role === 'staff').map(user => grouped.get(user.id) || { user, reports: [] }).filter(group => group.user.name.toLowerCase().includes(keyword));
    $('#report-people-list').innerHTML = reportPersonDirectory(people);
    if (window.lucide) lucide.createIcons();
    bindReportPersonSelection();
  });
}

function currentReportValues() {
  const editingReport = state.reports.find(report => report.id === state.editingReportId) || null;
  const type = editingReport?.type || state.reportType;
  const periodStart = $('#report-start')?.value || state.reportDraft?.periodStart || editingReport?.periodStart || (type === 'daily' ? todayInput() : weekStartInput());
  const periodEnd = type === 'daily'
    ? periodStart
    : ($('#report-end')?.value || state.reportDraft?.periodEnd || editingReport?.periodEnd || todayInput());
  return { type, periodStart, periodEnd };
}

function reportFormData(reviewToken = '') {
  const { type, periodStart, periodEnd } = currentReportValues();
  const form = new FormData();
  form.append('type', type);
  form.append('periodStart', periodStart);
  form.append('periodEnd', periodEnd);
  if (type === 'daily') {
    form.append('completion', $('#report-completion')?.value || '');
    form.append('learning', $('#report-learning')?.value || '');
    form.append('blockers', $('#report-blockers')?.value || '');
    form.append('solutions', $('#report-solutions')?.value || '');
  }
  state.reportFiles.forEach(file => form.append('attachments', file));
  if (state.editingReportId && state.removedReportAttachmentIds.length) form.append('removeAttachmentIds', JSON.stringify(state.removedReportAttachmentIds));
  if (reviewToken) form.append('reviewToken', reviewToken);
  return form;
}

async function reviewWeeklyReport() {
  const values = currentReportValues();
  if (!values.periodStart || !values.periodEnd || values.periodEnd < values.periodStart) return showToast('请选择正确的周报开始和结束日期');
  const editingReport = state.reports.find(report => report.id === state.editingReportId) || null;
  const existingFiles = reportAttachmentsForEditor(editingReport);
  if (!existingFiles.length && !state.reportFiles.length) return showToast('请先上传至少 1 个 PDF 或 DOCX 周报文档');
  state.reportDraft = { periodStart: values.periodStart, periodEnd: values.periodEnd };
  state.reviewError = '';
  const form = new FormData();
  form.append('periodStart', values.periodStart);
  form.append('periodEnd', values.periodEnd);
  if (state.editingReportId) form.append('reportId', state.editingReportId);
  if (state.removedReportAttachmentIds.length) form.append('removeAttachmentIds', JSON.stringify(state.removedReportAttachmentIds));
  state.reportFiles.forEach(file => form.append('attachments', file));
  state.busy = true;
  render();
  try {
    const result = await api('/api/work-reports/review', { method: 'POST', body: form });
    state.busy = false;
    state.reviewError = '';
    state.pendingWeeklyReview = result;
    state.modal = { type: 'weekly-review' };
    render();
  } catch (error) {
    state.busy = false;
    state.reviewError = error.message || '审核请求未完成，请稍后重试。';
    render();
    showToast(error.message);
  }
}

async function submitWorkReport(reviewToken = '') {
  const editingReportId = state.editingReportId;
  const values = currentReportValues();
  const form = reportFormData(reviewToken);
  state.busy = true;
  render();
  try {
    await api(editingReportId ? `/api/work-reports/${editingReportId}` : '/api/work-reports', {
      method: editingReportId ? 'PATCH' : 'POST',
      body: form
    });
    await loadWorkspace();
    state.squareDate = values.periodStart;
    state.squareUserId = '';
    state.editingReportId = null;
    state.reportFiles = [];
    state.removedReportAttachmentIds = [];
    state.reportDraft = null;
    state.pendingWeeklyReview = null;
    state.reviewError = '';
    state.modal = null;
    state.busy = false;
    render();
    showToast(editingReportId ? '工作汇报已修改' : values.type === 'daily' ? '日报已提交' : '周报已提交');
  } catch (error) {
    state.busy = false;
    state.reviewError = error.message || '提交失败，请检查周报文件和日期后重试。';
    render();
    showToast(state.reviewError);
  }
}

function bindTableActions() {
  document.querySelectorAll('[data-delete-expense]').forEach(el => el.addEventListener('click', async () => {
    if (!window.confirm('确定删除这条报销申请吗？删除后无法恢复。')) return;
    try { await api(`/api/expenses/${el.dataset.deleteExpense}`, { method: 'DELETE' }); await loadWorkspace(); render(); showToast('报销申请已删除'); } catch (error) { showToast(error.message); }
  }));
  document.querySelectorAll('[data-delete-expense-admin]').forEach(el => el.addEventListener('click', async () => {
    if (!window.confirm('确定删除这条已报销申请吗？删除后无法恢复。')) return;
    try { await api(`/api/admin/expenses/${el.dataset.deleteExpenseAdmin}`, { method: 'DELETE' }); await loadWorkspace(); render(); showToast('已报销申请已删除'); } catch (error) { showToast(error.message); }
  }));
  document.querySelectorAll('[data-reimburse]').forEach(el => el.addEventListener('click', async () => { try { await api(`/api/expenses/${el.dataset.reimburse}/reimburse`, { method: 'POST' }); await loadWorkspace(); render(); showToast('已标记为报销完成'); } catch (error) { showToast(error.message); } }));
  document.querySelectorAll('[data-reject-expense]').forEach(el => el.addEventListener('click', async () => {
    if (!window.confirm('确定驳回这条报销申请吗？员工将看到“已驳回”状态。')) return;
    try { await api(`/api/expenses/${el.dataset.rejectExpense}/reject`, { method: 'POST' }); await loadWorkspace(); render(); showToast('报销申请已驳回'); } catch (error) { showToast(error.message); }
  }));
  document.querySelectorAll('[data-attachment]').forEach(el => el.addEventListener('click', () => { state.modal = { type: 'attachment', id: Number(el.dataset.attachment) }; render(); }));
  document.querySelectorAll('[data-person]').forEach(el => el.addEventListener('click', () => { state.modal = { type: 'person', id: Number(el.dataset.person) }; render(); }));
}

async function startSession(user) { state.user = user; state.mode = 'app'; state.view = user.role === 'admin' ? 'overview' : 'submit'; state.busy = false; await loadWorkspace(); render(); }
function today() { return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' }).format(new Date()); }
function todayInput() { return new Date().toISOString().slice(0, 10); }
function weekStartInput() { const date = new Date(); const day = date.getDay() || 7; date.setDate(date.getDate() - day + 1); return date.toISOString().slice(0, 10); }
function formatBytes(bytes) { return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function escapeHtml(value) { return String(value || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;'); }
function showToast(message) { const toast = $('#toast'); toast.textContent = message; toast.classList.add('show'); clearTimeout(window.toastTimer); window.toastTimer = setTimeout(() => toast.classList.remove('show'), 3000); }

function expenseFileList() {
  if (!state.expenseFiles.length) return '<div class="expense-file-empty">尚未选择附件</div>';
  return state.expenseFiles.map((file, index) => `<div class="expense-file"><span class="expense-file-name">${icon('paperclip')}<span title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span><small>${formatBytes(file.size)}</small></span><button type="button" class="expense-file-remove" data-remove-expense-file="${index}" title="移除此附件" aria-label="移除此附件">${icon('x')}</button></div>`).join('');
}

function refreshExpenseFileList() {
  const list = $('#expense-file-list');
  if (!list) return;
  list.innerHTML = expenseFileList();
  if (window.lucide) lucide.createIcons();
  bindExpenseFileActions();
}

function setExpenseFiles(files) {
  const nextFiles = Array.from(files || []);
  if (nextFiles.length > 6) showToast('一次最多选择 6 个附件，已保留前 6 个。');
  state.expenseFiles = nextFiles.slice(0, 20);
  refreshExpenseFileList();
}

function bindExpenseFileActions() {
  document.querySelectorAll('[data-remove-expense-file]').forEach(el => el.addEventListener('click', () => {
    state.expenseFiles.splice(Number(el.dataset.removeExpenseFile), 1);
    refreshExpenseFileList();
  }));
}

function reportAttachmentsForEditor(report) {
  const saved = report ? (report.attachments || (report.attachment ? [report.attachment] : [])) : [];
  return saved.filter(attachment => !state.removedReportAttachmentIds.includes(attachment.id));
}

function reportFileList(report) {
  const saved = reportAttachmentsForEditor(report);
  const savedFiles = saved.map(attachment => `<div class="expense-file"><a class="expense-file-name" href="/api/attachments/${attachment.id}" target="_blank" rel="noopener"><span>${icon('paperclip')}<span title="${escapeHtml(attachment.name)}">${escapeHtml(attachment.name)}</span><small>${formatBytes(attachment.size)}</small></span></a><button type="button" class="expense-file-remove" data-remove-existing-report-attachment="${attachment.id}" title="删除此附件" aria-label="删除此附件">${icon('x')}</button></div>`);
  const pendingFiles = state.reportFiles.map((file, index) => `<div class="expense-file"><span class="expense-file-name">${icon('paperclip')}<span title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span><small>${formatBytes(file.size)}</small></span><button type="button" class="expense-file-remove" data-remove-report-file="${index}" title="移除此附件" aria-label="移除此附件">${icon('x')}</button></div>`);
  const files = [...savedFiles, ...pendingFiles].join('') || '<div class="expense-file-empty">尚未添加附件</div>';
  const reviewError = state.reviewError
    ? `<div class="review-inline-error" role="alert"><strong>审核未完成</strong><span>${escapeHtml(state.reviewError)}</span></div>`
    : '';
  return `${files}${reviewError}`;
}

function refreshReportFileList() {
  const list = $('#report-file-list');
  if (!list) return;
  const report = state.reports.find(item => item.id === state.editingReportId) || null;
  list.innerHTML = reportFileList(report);
  const count = reportAttachmentsForEditor(report).length + state.reportFiles.length;
  const countNode = $('#report-attachment-count');
  if (countNode) countNode.textContent = `已添加 ${count} / 5 个附件`;
  if (window.lucide) lucide.createIcons();
  document.querySelectorAll('[data-remove-report-file]').forEach(el => el.addEventListener('click', () => {
    state.reportFiles.splice(Number(el.dataset.removeReportFile), 1);
    state.pendingWeeklyReview = null;
    refreshReportFileList();
  }));
  document.querySelectorAll('[data-remove-existing-report-attachment]').forEach(el => el.addEventListener('click', () => {
    const attachmentId = Number(el.dataset.removeExistingReportAttachment);
    if (!state.removedReportAttachmentIds.includes(attachmentId)) state.removedReportAttachmentIds.push(attachmentId);
    state.pendingWeeklyReview = null;
    refreshReportFileList();
  }));
}

function setReportFiles(files) {
  const report = state.reports.find(item => item.id === state.editingReportId) || null;
  const existingCount = reportAttachmentsForEditor(report).length;
  const available = Math.max(0, 5 - existingCount - state.reportFiles.length);
  const selected = Array.from(files || []);
  const supportedFiles = selected.filter(file => /\.(pdf|docx)$/i.test(file.name));
  const nextFiles = supportedFiles.filter(file => Number(file.size) > 0);
  if (selected.length !== supportedFiles.length) showToast('周报审核仅支持 PDF 或 DOCX 文档。');
  if (supportedFiles.length !== nextFiles.length) showToast('发现 0 KB 空文档，已跳过，请重新导出后再上传。');
  if (nextFiles.length > available) showToast(`周报最多保留 5 个附件，本次已添加前 ${available} 个`);
  state.reportFiles = [...state.reportFiles, ...nextFiles.slice(0, available)];
  state.pendingWeeklyReview = null;
  state.reviewError = '';
  refreshReportFileList();
}

function staffReports() {
  const editingReport = state.reports.find(report => report.id === state.editingReportId) || null;
  const daily = (editingReport?.type || state.reportType) === 'daily';
  const reports = state.reports;
  const sections = editingReport?.sections || { completion: '', learning: '', blockers: '', solutions: '' };
  const startDate = editingReport?.periodStart || (daily ? todayInput() : weekStartInput());
  const endDate = editingReport?.periodEnd || todayInput();
  return `<div class="report-page"><header class="topbar"><div><h1 class="page-title">日报与周报</h1><p class="page-lead">记录每日工作进展，并提交阶段性周报。</p></div><div class="date">${today()}</div></header><div class="report-layout report-entry-layout"><section class="section-card report-form-card"><div class="report-form-head"><div><h2 class="section-title">${icon('notebook-pen')}${editingReport ? '修改工作汇报' : '提交工作汇报'}</h2><p class="section-helper">${editingReport ? '在原内容基础上修改，保存后会同步给管理员。' : '同一天可提交多次，每次都会保留为独立记录。'}</p></div><div class="report-type-switch"><button type="button" class="${daily ? 'active' : ''}" data-report-type="daily">日报</button><button type="button" class="${!daily ? 'active' : ''}" data-report-type="weekly">周报</button></div></div><form id="work-report-form"><div class="report-date-grid">${daily ? `<div class="form-group"><label for="report-start">汇报日期</label><input id="report-start" type="date" required value="${startDate}"></div>` : `<div class="form-group"><label for="report-start">开始日期</label><input id="report-start" type="date" required value="${startDate}"></div><div class="form-group"><label for="report-end">结束日期</label><input id="report-end" type="date" required value="${endDate}"></div>`}</div><div class="report-fields-grid"><div class="form-group report-field"><label for="report-completion">完成内容</label><textarea id="report-completion" required maxlength="5000" placeholder="填写今天完成的工作事项">${escapeHtml(sections.completion)}</textarea></div><div class="form-group report-field"><label for="report-learning">学习收获</label><textarea id="report-learning" maxlength="5000" placeholder="记录学习到的方法、经验或新知识">${escapeHtml(sections.learning)}</textarea></div><div class="form-group report-field"><label for="report-blockers">卡点 / 不懂问题</label><textarea id="report-blockers" maxlength="5000" placeholder="记录遇到的困难、疑问或待确认事项">${escapeHtml(sections.blockers)}</textarea></div><div class="form-group report-field"><label for="report-solutions">解决办法（笔记）</label><textarea id="report-solutions" maxlength="5000" placeholder="记录解决思路、处理结果或后续计划">${escapeHtml(sections.solutions)}</textarea></div></div><label class="report-attachment-field" for="report-attachment"><span class="report-attachment-icon">${icon('paperclip')}</span><span><strong>其它文件、附件</strong><small id="report-attachment-name">${editingReport?.attachment ? `当前附件：${escapeHtml(editingReport.attachment.name)}；选择新文件可替换` : '可选，支持 JPG、PNG、WEBP、PDF，单个不超过 10MB'}</small></span><span class="choose-file">选择文件</span><input id="report-attachment" type="file" accept="image/jpeg,image/png,image/webp,application/pdf"></label><div class="form-foot"><button class="primary" type="submit">${state.busy ? '正在保存...' : editingReport ? '保存修改' : daily ? '提交日报' : '提交周报'}</button>${editingReport ? '<button class="action-btn" type="button" data-cancel-report-edit>取消修改</button>' : ''}<span class="muted">内容会同步给管理员查看</span></div></form></section></div></div>`;
}

function reportExportControls(userId = '', userName = '') {
  const periodStart = state.reportExportStart || monthStartInput();
  const periodEnd = state.reportExportEnd || todayInput();
  const subject = userName ? `${escapeHtml(userName)}的` : '我的';
  return `<section class="report-export-bar"><div class="report-export-copy"><span class="mini-icon">${icon('file-down')}</span><div><h2>导出工作汇报</h2><p>按时间区间生成${subject}日报与周报 Excel。</p></div></div><div class="report-export-actions"><label><span>开始日期</span><input id="report-export-start" data-report-export-date="start" type="date" value="${periodStart}"></label><label><span>结束日期</span><input id="report-export-end" data-report-export-date="end" type="date" value="${periodEnd}"></label><button type="button" class="primary" data-export-reports="${userId}">${icon('download')}<span>导出 Excel</span></button></div></section>`;
}

function squareExportControls() {
  const selectedId = String(state.squareUserId || '');
  if (state.user?.role === 'staff') return reportExportControls(state.user.id, state.user.name);
  if (!selectedId) return `<section class="report-export-bar square-export-hint"><div class="report-export-copy"><span class="mini-icon">${icon('file-down')}</span><div><h2>导出团队汇报</h2><p>请先点击左侧人员，再选择时间区间导出该成员的日报与周报 Excel。</p></div></div></section>`;
  const user = state.users.find(item => String(item.id) === selectedId);
  return user ? reportExportControls(user.id, user.name) : '';
}

function monthStartInput() { return `${todayInput().slice(0, 7)}-01`; }

function staffReports() {
  const editingReport = state.reports.find(report => report.id === state.editingReportId) || null;
  const daily = (editingReport?.type || state.reportType) === 'daily';
  const sections = editingReport?.sections || { completion: '', learning: '', blockers: '', solutions: '' };
  const startDate = state.reportDraft?.periodStart || editingReport?.periodStart || (daily ? todayInput() : weekStartInput());
  const endDate = state.reportDraft?.periodEnd || editingReport?.periodEnd || todayInput();
  const attachedCount = reportAttachmentsForEditor(editingReport).length + state.reportFiles.length;
  const dailyFields = `<div class="report-fields-grid"><div class="form-group report-field"><label for="report-completion">完成内容</label><textarea id="report-completion" required maxlength="5000" placeholder="填写今天完成的工作事项">${escapeHtml(sections.completion)}</textarea></div><div class="form-group report-field"><label for="report-learning">学习收获</label><textarea id="report-learning" maxlength="5000" placeholder="记录学习到的方法、经验或新知识">${escapeHtml(sections.learning)}</textarea></div><div class="form-group report-field"><label for="report-blockers">卡点 / 不懂问题</label><textarea id="report-blockers" maxlength="5000" placeholder="记录遇到的困难、疑问或待确认事项">${escapeHtml(sections.blockers)}</textarea></div><div class="form-group report-field"><label for="report-solutions">解决办法（笔记）</label><textarea id="report-solutions" maxlength="5000" placeholder="记录解决思路、处理结果或后续计划">${escapeHtml(sections.solutions)}</textarea></div></div>`;
  const weeklyDocuments = `<div class="weekly-document-intro"><span class="report-attachment-icon">${icon('files')}</span><div><strong>上传周报文档</strong><p>仅支持 PDF、DOCX。上传后先由智能审核生成评分与修改建议，再由您确认提交。</p></div></div><label class="report-attachment-field weekly-document-field" for="report-attachment"><span class="report-attachment-icon">${icon('upload')}</span><span><strong>周报文件</strong><small id="report-attachment-count">已添加 ${attachedCount} / 5 个文档；单个不超过 10MB</small></span><span class="choose-file">选择文档</span><input id="report-attachment" type="file" multiple accept="application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.pdf,.docx"></label><div id="report-file-list" class="expense-file-list report-file-list">${reportFileList(editingReport)}</div>`;
  return `<div class="report-page"><header class="topbar"><div class="report-page-heading"><button type="button" class="report-back-link" data-report-square-back title="返回周日志广场" aria-label="返回周日志广场">${icon('arrow-left')}<span>周日志广场</span></button><div><h1 class="page-title">日报与周报</h1><p class="page-lead">记录每日工作进展，并提交阶段性周报。</p></div></div><div class="date">${today()}</div></header>${reportExportControls()}<div class="report-layout report-entry-layout"><section class="section-card report-form-card"><div class="report-form-head"><div><h2 class="section-title">${icon('notebook-pen')}${editingReport ? '修改工作汇报' : '提交工作汇报'}</h2><p class="section-helper">${daily ? (editingReport ? '在原内容基础上修改，保存后会同步给管理员。' : '同一天可提交多次，每次都会保留为独立记录。') : '周报以文档形式提交，审核通过后再确认上传。'}</p></div><div class="report-type-switch"><button type="button" class="${daily ? 'active' : ''}" data-report-type="daily">日报</button><button type="button" class="${!daily ? 'active' : ''}" data-report-type="weekly">周报</button></div></div><form id="work-report-form"><div class="report-date-grid">${daily ? `<div class="form-group"><label for="report-start">汇报日期</label><input id="report-start" type="date" required value="${startDate}"></div>` : `<div class="form-group"><label for="report-start">开始日期</label><input id="report-start" type="date" required value="${startDate}"></div><div class="form-group"><label for="report-end">结束日期</label><input id="report-end" type="date" required value="${endDate}"></div>`}</div>${daily ? dailyFields : weeklyDocuments}<div class="form-foot"><button class="primary" type="submit">${state.busy ? '正在处理...' : editingReport ? (daily ? '保存修改' : '审核后保存') : daily ? '提交日报' : '审核周报'}</button>${editingReport ? '<button class="action-btn" type="button" data-cancel-report-edit>取消修改</button>' : ''}<span class="muted">${daily ? '内容会同步给管理员查看' : '审核内容将与周报一起同步给管理员，并包含在 Excel 导出中'}</span></div></form></section></div></div>`;
}

function staffReportHistory() {
  return `<div class="report-history-page"><header class="topbar"><div><h1 class="page-title">提交记录</h1><p class="page-lead">按日期查看自己提交的日报和周报。</p></div><div class="date">${today()}</div></header>${reportCalendar(state.reports)}</div>`;
}

function reportSquare() {
  const selectedDate = state.squareDate || todayInput();
  state.squareDate = selectedDate;
  const reportUsers = [...new Map(state.squareReports.map(report => [report.user.id, report.user])).values()];
  const users = state.user?.role === 'admin'
    ? [...new Map([...state.users.filter(user => user.role === 'staff'), ...reportUsers].map(user => [user.id, user])).values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    : reportUsers.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  const selectedUserId = String(state.squareUserId || '');
  const visibleReports = state.squareReports.filter(report => !selectedUserId || String(report.user.id) === selectedUserId);
  const dailyReports = visibleReports.filter(report => report.type === 'daily' && report.periodStart === selectedDate);
  const selectedWeek = reportWeekRange(selectedDate);
  const weeklyReports = visibleReports.filter(report => report.type === 'weekly' && report.periodStart <= selectedWeek.end && report.periodEnd >= selectedWeek.start);
  const weekdayLabels = ['日', '一', '二', '三', '四', '五', '六'];
  const dateStrip = Array.from({ length: 21 }, (_, index) => shiftDate(selectedDate, index - 10)).map(date => {
    const calendarDate = new Date(`${date}T00:00:00Z`);
    const selected = date === selectedDate;
    const currentDay = date === todayInput();
    const hasReports = state.squareReports.some(report => reportCoversDate(report, date));
    return `<button type="button" class="square-date ${selected ? 'selected' : ''} ${currentDay ? 'today' : ''} ${hasReports ? 'has-reports' : ''}" data-square-date="${date}" aria-label="${date}${currentDay ? '，今天' : ''}${hasReports ? '，有提交内容' : ''}"><span>${weekdayLabels[calendarDate.getUTCDay()]}</span><strong>${calendarDate.getUTCDate()}</strong><small>${String(calendarDate.getUTCMonth() + 1).padStart(2, '0')}月</small></button>`;
  }).join('');
  const personList = `<button type="button" class="square-person ${!selectedUserId ? 'selected' : ''}" data-square-user="all"><span class="avatar tiny">全</span><span><strong>全部人员</strong><small>${state.squareReports.length} 条汇报</small></span></button>${users.map(user => {
    const count = state.squareReports.filter(report => report.user.id === user.id).length;
    return `<button type="button" class="square-person ${selectedUserId === String(user.id) ? 'selected' : ''}" data-square-user="${user.id}"><span class="avatar tiny">${initials(user.name)}</span><span><strong>${escapeHtml(user.name)}</strong><small>${count} 条汇报</small></span>${selectedUserId === String(user.id) ? icon('chevron-right') : ''}</button>`;
  }).join('')}`;
  const submitAction = state.user?.role === 'staff' ? `<button type="button" class="primary square-submit-link" data-square-submit>${icon('send')}<span>去提交</span></button>` : '';
  return `<div class="report-square-page"><header class="topbar"><div><h1 class="page-title">周日志广场</h1><p class="page-lead">按日期浏览团队日报，并查看该周覆盖日期的周报。</p></div><div class="square-top-actions"><div class="date">${fmtDate(selectedDate)}</div>${submitAction}</div></header><section class="square-date-rail" aria-label="选择查看日期"><button type="button" class="square-date-nav" data-square-shift="-7" title="前一周" aria-label="前一周">${icon('chevron-left')}</button><div class="square-date-scroll" tabindex="0">${dateStrip}</div><div class="square-date-tools"><div class="square-picker-anchor"><button type="button" class="square-picker-toggle" data-square-picker-toggle title="快速选择日期" aria-label="快速选择日期" aria-expanded="${state.squarePickerOpen}">${icon('calendar-days')}</button>${state.squarePickerOpen ? squareDatePicker(selectedDate) : ''}</div><button type="button" class="square-date-nav" data-square-shift="7" title="后一周" aria-label="后一周">${icon('chevron-right')}</button></div></section><div class="square-date-summary"><span>${icon('calendar-days')}</span><strong>${fmtDate(selectedDate)}</strong><small>日报 ${dailyReports.length} 条 · 周报 ${weeklyReports.length} 条</small></div><div class="square-content-grid"><aside class="square-people-panel"><header><div><h2>人员</h2><p>点击查看当天汇报</p></div><span>${users.length} 人</span></header><div class="square-people-list">${personList}</div></aside><div class="square-report-stack"><section class="square-report-panel daily"><header><div><span class="square-panel-icon">${icon('sun')}</span><h2>当天日报</h2></div><span>${dailyReports.length} 条</span></header><div class="square-report-list">${reportSquareEntries(dailyReports, selectedUserId ? '该人员当天暂无日报' : '当天暂无日报')}</div></section><section class="square-report-panel weekly"><header><div><span class="square-panel-icon">${icon('notebook-tabs')}</span><h2>周报文件</h2></div><span>${weeklyReports.length} 条</span></header><div class="square-report-list">${reportSquareWeeklyFiles(weeklyReports, selectedUserId ? '该人员本周暂无周报文件' : '本周暂无周报文件')}</div></section></div></div></div>`;
}

function squareDatePicker(selectedDate) {
  const month = state.squarePickerMonth || selectedDate.slice(0, 7);
  const [year, monthNumber] = month.split('-').map(Number);
  const firstDay = new Date(Date.UTC(year, monthNumber - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const leadingDays = firstDay.getUTCDay();
  const cellCount = Math.ceil((leadingDays + daysInMonth) / 7) * 7;
  const weekdayLabels = ['日', '一', '二', '三', '四', '五', '六'];
  const cells = Array.from({ length: cellCount }, (_, index) => {
    const dayOffset = index - leadingDays + 1;
    const date = new Date(Date.UTC(year, monthNumber - 1, dayOffset));
    const value = date.toISOString().slice(0, 10);
    const outside = dayOffset < 1 || dayOffset > daysInMonth;
    const currentDay = value === todayInput();
    const selected = value === selectedDate;
    const hasReports = state.squareReports.some(report => reportCoversDate(report, value));
    return `<button type="button" class="square-picker-day ${outside ? 'outside' : ''} ${currentDay ? 'today' : ''} ${selected ? 'selected' : ''} ${hasReports ? 'has-reports' : ''}" data-square-picker-date="${value}" aria-label="${value}">${date.getUTCDate()}</button>`;
  }).join('');
  return `<section class="square-date-picker" role="dialog" aria-label="快速选择日期"><header><strong>${year}年${String(monthNumber).padStart(2, '0')}月</strong><div><button type="button" data-square-picker-nav="-1" title="上个月" aria-label="上个月">${icon('chevron-up')}</button><button type="button" data-square-picker-nav="1" title="下个月" aria-label="下个月">${icon('chevron-down')}</button></div></header><div class="square-picker-weekdays">${weekdayLabels.map(label => `<span>${label}</span>`).join('')}</div><div class="square-picker-grid">${cells}</div><footer><button type="button" data-square-picker-today>今天</button></footer></section>`;
}

function reportSquareEntries(reports, emptyText) {
  if (!reports.length) return `<div class="square-empty">${icon('file-text')}<span>${emptyText}</span></div>`;
  return reports.map(report => `<article class="square-report-entry"><header><div class="person"><span class="avatar tiny">${initials(report.user.name)}</span><div><strong>${escapeHtml(report.user.name)}</strong><span>${report.type === 'daily' ? report.periodStart : `${report.periodStart} 至 ${report.periodEnd}`}</span></div></div><time>${fmtDate(report.submittedAt)}</time></header>${reportBody(report)}</article>`).join('');
}

function reportSquareReviewSummary(report) {
  const review = report.review;
  if (!review) {
    return `<section class="square-review-summary pending"><span class="square-review-status">${icon('clock-3')}尚未完成智能审核</span><p>管理员完成审核后，评分和分析会显示在这里。</p></section>`;
  }
  const score = Number.isFinite(Number(review.score)) ? Number(review.score) : 0;
  const grade = reviewGradeLabel(review.grade) || '已完成';
  const dimensions = Array.isArray(review.dimensions) ? review.dimensions : [];
  const dimensionMarkup = dimensions.length
    ? `<div class="square-review-dimensions" aria-label="审核分项得分">${dimensions.map(dimension => `<span>${escapeHtml(dimension.title || dimension.id || '分项')} ${Number(dimension.score || 0)}/${Number(dimension.maxScore || 0)}</span>`).join('')}</div>`
    : '';
  const suggestions = Array.isArray(review.suggestions) ? review.suggestions.filter(Boolean) : [];
  const actionGroups = [
    ['紧急优化', review.urgentActions],
    ['常规优化', review.standardActions],
    ['进阶优化', review.advancedActions]
  ].filter(([, items]) => Array.isArray(items) && items.length);
  const suggestionMarkup = suggestions.length
    ? `<div class="square-review-suggestions"><strong>待优化建议</strong><ul>${suggestions.slice(0, 4).map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>`
    : '';
  const actionMarkup = actionGroups.length
    ? `<div class="square-review-actions">${actionGroups.map(([label, items]) => `<div><strong>${label}</strong><span>${escapeHtml(items[0])}${items.length > 1 ? ` 等 ${items.length} 项` : ''}</span></div>`).join('')}</div>`
    : '';
  return `<section class="square-review-summary" aria-label="智能审核评分与分析"><header><span>${icon('sparkles')}智能审核 · ${escapeHtml(grade)}</span><strong>${score} <small>分</small></strong></header>${dimensionMarkup}<p class="square-review-analysis">${escapeHtml(review.summary || '审核已完成，暂无摘要。')}</p>${suggestionMarkup}${actionMarkup}</section>`;
}

function reportSquareWeeklyFiles(reports, emptyText) {
  if (!reports.length) return `<div class="square-empty">${icon('file-text')}<span>${emptyText}</span></div>`;
  return reports.map(report => {
    const attachments = report.attachments || (report.attachment ? [report.attachment] : []);
    const isOtherPerson = String(report.user.id) !== String(state.user?.id);
    const links = attachments.length
      ? attachments.map(attachment => isOtherPerson
        ? `<button type="button" class="report-attachment-link square-weekly-preview-link" data-open-square-weekly-report="${report.id}" data-open-square-weekly-attachment="${attachment.id}" title="查看 ${escapeHtml(report.user.name)} 的周志">${icon('book-open-text')}<span>${escapeHtml(attachment.name)}</span></button>`
        : `<a class="report-attachment-link" href="/api/attachments/${attachment.id}" target="_blank" rel="noopener">${icon('paperclip')}<span>${escapeHtml(attachment.name)}</span></a>`).join('')
      : isOtherPerson
        ? `<button type="button" class="report-attachment-link square-weekly-preview-link" data-open-square-weekly-report="${report.id}">${icon('book-open-text')}<span>查看周志内容</span></button>`
        : '<span class="muted">暂无周报文件</span>';
    return `<article class="square-weekly-file-entry"><header><div class="person"><span class="avatar tiny">${initials(report.user.name)}</span><div><strong>${escapeHtml(report.user.name)}</strong><span>${report.periodStart} 至 ${report.periodEnd}</span></div></div><time>${fmtDate(report.submittedAt)}</time></header><div class="square-file-links">${links}</div>${reportSquareReviewSummary(report)}</article>`;
  }).join('');
}

function reportCalendar(reports) {
  const month = state.reportCalendarMonth || todayInput().slice(0, 7);
  state.reportCalendarMonth = month;
  const selectedDate = state.selectedReportDate || todayInput();
  const [year, monthNumber] = month.split('-').map(Number);
  const firstDay = new Date(Date.UTC(year, monthNumber - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const leadingDays = firstDay.getUTCDay();
  const cellCount = Math.ceil((leadingDays + daysInMonth) / 7) * 7;
  const submittedDates = new Set();
  reports.forEach(report => {
    if (report.type === 'daily') submittedDates.add(report.periodStart);
    else for (let date = report.periodStart; date <= report.periodEnd; date = shiftDate(date, 1)) submittedDates.add(date);
  });
  const calendarCells = Array.from({ length: cellCount }, (_, index) => {
    const dayOffset = index - leadingDays + 1;
    const date = new Date(Date.UTC(year, monthNumber - 1, dayOffset));
    const dateValue = date.toISOString().slice(0, 10);
    const inMonth = dayOffset > 0 && dayOffset <= daysInMonth;
    const submitted = submittedDates.has(dateValue);
    const selected = selectedDate === dateValue;
    return `<button type="button" class="report-calendar-day ${inMonth ? '' : 'outside'} ${submitted ? 'submitted' : ''} ${selected ? 'selected' : ''}" data-calendar-date="${dateValue}" aria-label="${dateValue}${submitted ? '，已提交' : ''}"><span>${date.getUTCDate()}</span>${submitted ? '<i></i>' : ''}</button>`;
  }).join('');
  const selectedReports = reports.filter(report => reportCoversDate(report, selectedDate));
  const monthLabel = `${year}年${String(monthNumber).padStart(2, '0')}月`;
  return `<section class="section-card report-calendar-card"><div class="calendar-card-head"><div><h2>${icon('calendar-days')}提交日历</h2><p>深色日期表示当天已有汇报，点击日期查看。</p></div><span class="muted">${reports.length} 条</span></div><div class="report-calendar-nav"><button type="button" data-calendar-nav="-1" title="上个月" aria-label="上个月">${icon('chevron-left')}</button><strong>${monthLabel}</strong><button type="button" data-calendar-nav="1" title="下个月" aria-label="下个月">${icon('chevron-right')}</button></div><div class="report-calendar-weekdays"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div><div class="report-calendar-grid">${calendarCells}</div><div class="report-calendar-actions"><button type="button" data-calendar-clear>清除</button><button type="button" data-calendar-today>今天</button></div><div class="report-calendar-results"><div class="calendar-results-head"><strong>${selectedDate}</strong><span>${selectedReports.length ? `${selectedReports.length} 条汇报` : '暂无提交'}</span></div>${selectedReports.length ? `<div class="report-list">${selectedReports.map(report => reportCard(report)).join('')}</div>` : '<div class="empty">当天暂无提交记录</div>'}</div></section>`;
}

function reportCoversDate(report, date) {
  return report.type === 'daily' ? report.periodStart === date : report.periodStart <= date && date <= report.periodEnd;
}

function reportWeekRange(dateValue) {
  const date = new Date(`${dateValue}T00:00:00Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() - day + 1);
  const start = date.toISOString().slice(0, 10);
  date.setUTCDate(date.getUTCDate() + 6);
  return { start, end: date.toISOString().slice(0, 10) };
}

function shiftDate(dateValue, amount) {
  const date = new Date(`${dateValue}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function shiftMonth(monthValue, amount) {
  const [year, month] = monthValue.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1 + amount, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function reviewGradeLabel(grade) {
  return ({ excellent: '优秀', good: '良好', qualified: '合格（需补充）', unqualified: '不合格' })[grade] || '未评级';
}

function reviewDimensionCards(review) {
  const dimensions = Array.isArray(review?.dimensions) ? review.dimensions : [];
  if (!dimensions.length) return '<p class="muted">当前审核未返回六维分项评分。</p>';
  return dimensions.map(dimension => `<article class="review-dimension-card"><header><strong>${escapeHtml(dimension.title || dimension.id || '评分维度')}</strong><span>${Number(dimension.score || 0)}/${Number(dimension.maxScore || 0)}</span></header><p>${escapeHtml(dimension.assessment || '暂无评语')}</p>${dimension.deductions?.length ? `<small>扣分依据：${escapeHtml(dimension.deductions.join('；'))}</small>` : ''}</article>`).join('');
}

function reviewActionGroup(label, items) {
  if (!items?.length) return '';
  return `<div class="review-action-group"><h5>${escapeHtml(label)}</h5><ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>`;
}

function reportBody(report) {
  const sections = report.sections || { completion: report.content || '' };
  const fields = [['completion', '完成内容'], ['learning', '学习收获'], ['blockers', '卡点 / 不懂问题'], ['solutions', '解决办法（笔记）']];
  const body = fields.filter(([key]) => sections[key]).map(([key, label]) => `<div class="report-content-block"><strong>${label}</strong><p>${formatReportContent(sections[key])}</p></div>`).join('');
  const attachments = report.attachments || (report.attachment ? [report.attachment] : []);
  const attachmentLinks = attachments.map(attachment => `<a class="report-attachment-link" href="/api/attachments/${attachment.id}" target="_blank" rel="noopener">${icon('paperclip')}<span>${escapeHtml(attachment.name)}</span></a>`).join('');
  const review = report.review ? `<section class="report-review-summary"><header><span>${icon('sparkles')}智能审核 · ${reviewGradeLabel(report.review.grade)}</span><strong>${report.review.score} 分</strong></header>${report.review.dimensions?.length ? `<div class="report-review-dimensions">${report.review.dimensions.map(dimension => `<span>${escapeHtml(dimension.title || dimension.id)} ${dimension.score}/${dimension.maxScore}</span>`).join('')}</div>` : ''}<p>${escapeHtml(report.review.summary)}</p>${report.review.suggestions?.length ? `<div><span>建议</span><ul>${report.review.suggestions.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>` : ''}</section>` : '';
  return `<div class="report-content-blocks">${body || (report.type === 'weekly' ? '<p class="muted">本周周报以附件文档提交。</p>' : '<p class="muted">暂无文字内容</p>')}${attachmentLinks}${review}</div>`;
}

function reportList(reports, admin) {
  if (!reports.length) return '<div class="empty">暂无提交记录</div>';
  if (admin) return `<div class="report-list">${reports.map(report => reportCard(report, true)).join('')}</div>`;

  const groups = new Map();
  reports.forEach(report => {
    const key = report.type === 'daily' ? report.periodStart : `${report.periodStart}-${report.periodEnd}`;
    const group = groups.get(key) || {
      key,
      date: report.type === 'daily' ? report.periodStart : `${report.periodStart} 至 ${report.periodEnd}`,
      type: report.type,
      reports: []
    };
    group.reports.push(report);
    groups.set(key, group);
  });

  return `<div class="report-date-groups">${[...groups.values()].map(group => {
    const expanded = Boolean(state.expandedReportDates[group.key]);
    const typeLabel = group.type === 'daily' ? '日报' : '周报';
    return `<section class="report-date-group ${group.type} ${expanded ? 'is-open' : ''}"><button type="button" class="report-date-toggle" data-report-group="${escapeHtml(group.key)}"><span class="report-badge ${group.type}">${typeLabel}</span><strong>${escapeHtml(group.date)}</strong><span class="report-group-meta">${group.reports.length} 条 · 已提交</span>${icon('chevron-down', 'class="report-date-chevron"')}</button>${expanded ? `<div class="report-date-content"><div class="report-list">${group.reports.map(report => reportCard(report)).join('')}</div></div>` : ''}</section>`;
  }).join('')}</div>`;
}

function reportCard(report, admin = false) {
  const actions = admin ? '' : `<span class="report-actions"><button type="button" class="report-edit" data-edit-report="${report.id}" title="修改此汇报" aria-label="修改此汇报">${icon('pencil')}</button><button type="button" class="report-delete" data-delete-report="${report.id}" title="删除此汇报" aria-label="删除此汇报">${icon('trash-2')}</button></span>`;
  const submitted = admin ? '' : '<span class="report-updated">已提交</span>';
  return `<article class="report-item ${report.type}"><div class="report-item-head"><span class="report-badge ${report.type}">${report.type === 'daily' ? '日报' : '周报'}</span><strong>${report.type === 'daily' ? report.periodStart : `${report.periodStart} 至 ${report.periodEnd}`}</strong><time>${fmtDate(report.submittedAt)}</time>${actions}</div>${reportBody(report)}${submitted}</article>`;
}

function expenseTable(entries, admin) {
  if (!entries.length) return '<div class="empty">暂无报销记录</div>';
  return `<div class="table-wrap"><table><thead><tr>${admin ? '<th>申请人</th>' : ''}<th>提交日期</th><th>用途</th><th>金额</th><th>附件</th><th>状态</th>${admin ? '<th>操作</th>' : '<th>管理</th>'}</tr></thead><tbody>${entries.map(expense => `<tr>${admin ? `<td><div class="person"><span class="avatar tiny">${initials(expense.user.name)}</span><button data-person="${expense.user.id}">${expense.user.name}</button></div></td>` : ''}<td>${fmtDate(expense.submittedAt)}</td><td>${escapeHtml(expense.purpose)}</td><td class="money">${money(expense.amount)}</td><td><button class="file-link" data-attachment="${expense.attachment.id}">${icon('paperclip')}${escapeHtml(expense.attachment.name)}</button></td><td><span class="status ${expense.status === 'reimbursed' ? 'done' : 'pending'}">${expense.status === 'reimbursed' ? '已报销' : '待报销'}</span></td>${admin ? `<td><button class="action-btn ${expense.status === 'reimbursed' ? 'disabled' : ''}" data-reimburse="${expense.id}" ${expense.status === 'reimbursed' ? 'disabled' : ''}>${expense.status === 'reimbursed' ? '已完成' : '标记已报销'}</button></td>` : `<td>${expense.status === 'pending' ? `<button type="button" class="expense-delete" data-delete-expense="${expense.id}" title="删除报销申请" aria-label="删除报销申请">${icon('trash-2')}</button>` : '<span class="table-muted">已锁定</span>'}</td>`}</tr>`).join('')}</tbody></table></div>`;
}

function expenseAttachmentLinks(expense) {
  const attachments = expense.attachments || (expense.attachment ? [expense.attachment] : []);
  return `<div class="expense-attachment-links">${attachments.map((attachment, index) => `<button class="file-link" data-attachment="${attachment.id}" title="${escapeHtml(attachment.name)}">${icon('paperclip')}<span>${escapeHtml(attachment.name)}</span>${attachments.length > 1 ? `<small>${index + 1}</small>` : ''}</button>`).join('')}</div>`;
}

function expenseStatus(expense) {
  if (expense.status === 'reimbursed') return '<span class="status done">已报销</span>';
  if (expense.status === 'rejected') return '<span class="status rejected">已驳回</span>';
  return '<span class="status pending">待报销</span>';
}

function expenseTable(entries, admin) {
  if (!entries.length) return '<div class="empty">暂无报销记录</div>';
  return `<div class="table-wrap"><table><thead><tr>${admin ? '<th>申请人</th>' : ''}<th>提交日期</th><th>用途</th><th>金额</th><th>附件</th><th>状态</th>${admin ? '<th>操作</th>' : '<th>管理</th>'}</tr></thead><tbody>${entries.map(expense => `<tr>${admin ? `<td><div class="person"><span class="avatar tiny">${initials(expense.user.name)}</span><button data-person="${expense.user.id}">${escapeHtml(expense.user.name)}</button></div></td>` : ''}<td>${fmtDate(expense.submittedAt)}</td><td>${escapeHtml(expense.purpose)}</td><td class="money">${money(expense.amount)}</td><td>${expenseAttachmentLinks(expense)}</td><td>${expenseStatus(expense)}</td>${admin ? `<td><div class="expense-actions">${expense.status === 'pending' ? `<button class="action-btn" data-reimburse="${expense.id}">标记已报销</button><button class="action-btn reject-action" data-reject-expense="${expense.id}">驳回</button>` : expense.status === 'reimbursed' ? `<span class="table-muted">已完成</span><button type="button" class="expense-delete" data-delete-expense-admin="${expense.id}" title="删除已报销申请" aria-label="删除已报销申请">${icon('trash-2')}</button>` : '<span class="table-muted">已驳回</span>'}</div></td>` : `<td>${['pending', 'rejected'].includes(expense.status) ? `<button type="button" class="expense-delete" data-delete-expense="${expense.id}" title="删除报销申请" aria-label="删除报销申请">${icon('trash-2')}</button>` : '<span class="table-muted">已锁定</span>'}</td>`}</tr>`).join('')}</tbody></table></div>`;
}

function authScreen() {
  const register = state.authMode === 'register';
  return `<section class="entry"><div class="entry-panel"><div class="brand"><span class="brand-mark">${icon('receipt-text')}</span>票据台账</div><div class="entry-copy"><div class="eyebrow">Internal expense workflow</div><h1>让每一笔报销<br>清楚、有据可循。</h1><p>企业内部报销与工作汇报系统。账号、报销记录与附件统一保存在本机数据库中。</p></div><div class="entry-note">企业内部使用 · 附件仅限登录用户访问</div></div><div class="auth-wrap"><div class="auth-card"><h2>${register ? '创建账号' : '登录系统'}</h2><p class="auth-sub">${register ? (state.setup?.hasUsers ? '使用姓名和手机号注册普通人员账号。' : '请创建首个管理员账号。') : '输入已登记的姓名、手机号和身份登录。'}</p>${register ? registerForm() : loginForm()}</div></div></section>`;
}

function registerForm() {
  return `<form id="register-form">${roleOptions()}<div class="form-group"><label for="reg-name">姓名</label><input id="reg-name" required minlength="2" maxlength="30" autocomplete="name" placeholder="请输入本人真实姓名"></div><div class="form-group"><label for="reg-phone">手机号</label><input id="reg-phone" required inputmode="numeric" maxlength="11" autocomplete="tel" placeholder="请输入手机号"></div><button class="primary" type="submit">${state.busy ? '正在创建...' : '创建账号'}</button></form><div class="auth-switch">已有账号？<button class="text-action" data-auth="login">立即登录</button></div>`;
}

function loginForm() {
  return `${roleOptions()}<form id="login-form"><div class="form-group"><label for="login-name">姓名</label><input id="login-name" required autocomplete="username" placeholder="请输入已登记的姓名"></div><div class="form-group"><label for="login-phone">手机号</label><input id="login-phone" required inputmode="numeric" maxlength="11" autocomplete="tel" placeholder="请输入登记的手机号"></div><button class="primary" type="submit">${state.busy ? '正在登录...' : '登录系统'}</button></form><div class="auth-switch">还没有账号？<button class="text-action" data-auth="register">立即注册</button></div>`;
}

function profilePage() {
  return `<div class="content-width"><header class="topbar"><div><h1 class="page-title">我的资料</h1><p class="page-lead">更新姓名和手机号，管理员端会同步显示最新信息。</p></div><div class="date">${today()}</div></header><form id="profile-form" class="section-card"><h2 class="section-title">${icon('user-round-pen')}账户资料</h2><p class="section-helper">手机号用于后续登录，请填写本人正在使用的号码。</p><div class="form-grid"><div class="form-group"><label for="profile-name">姓名</label><input id="profile-name" required minlength="2" maxlength="30" value="${escapeHtml(state.user.name)}"></div><div class="form-group"><label for="profile-phone">手机号</label><input id="profile-phone" required inputmode="numeric" maxlength="11" autocomplete="tel" value="${escapeHtml(state.user.phone)}"></div></div><div class="form-foot"><button class="primary" type="submit">${state.busy ? '正在保存...' : '保存修改'}</button><span class="muted">保存后，后续请使用新的姓名和手机号登录。</span></div></form></div>`;
}

function employeeList(users) {
  return users.length ? users.map(user => `<article class="employee-row"><div class="person"><span class="avatar">${initials(user.name)}</span><div><button data-person="${user.id}">${escapeHtml(user.name)}</button><span class="muted">手机号：${escapeHtml(user.phone || '未登记')}</span></div></div><div class="row-stat"><span>提交记录</span><strong>${user.expenseCount} 笔</strong></div><div class="amount">累计申请<strong>${money(user.expenseTotal)}</strong></div><button class="action-btn" data-person="${user.id}">查看信息</button></article>`).join('') : '<div class="empty">没有符合条件的员工</div>';
}

function modal() {
  if (state.modal.type === 'weekly-review') {
    const review = state.pendingWeeklyReview?.review;
    if (!review) return '';
    const list = (items, empty) => items?.length
      ? `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`
      : `<p class="muted">${empty}</p>`;
    const status = review.decision === 'needs_revision' ? '建议修改后提交' : '可以确认提交';
    const actionGroups = [
      reviewActionGroup('紧急修改', review.urgentActions),
      reviewActionGroup('常规优化', review.standardActions),
      reviewActionGroup('进阶优化', review.advancedActions)
    ].join('');
  const submitError = state.reviewError ? `<div class="review-inline-error" role="alert"><strong>提交未完成</strong><span>${escapeHtml(state.reviewError)}</span></div>` : '';
  return `<div class="modal-backdrop review-backdrop" data-backdrop><section class="modal weekly-review-modal" role="dialog" aria-modal="true" aria-labelledby="weekly-review-title"><div class="modal-head"><div><p class="review-kicker">智能周报审核</p><h3 id="weekly-review-title">审核结果</h3></div><button class="close" data-return-weekly-edit title="返回修改" aria-label="返回修改" ${state.busy ? 'disabled' : ''}>${icon('x')}</button></div><div class="review-score-row"><div class="review-score"><strong>${review.score}</strong><span>分</span></div><div><span class="review-decision ${review.decision === 'needs_revision' ? 'revision' : 'ready'}">${status}</span><strong class="review-grade">${reviewGradeLabel(review.grade)}</strong><p>${escapeHtml(review.summary)}</p></div></div><div class="review-findings"><section class="review-dimension-section"><h4>${icon('scan-search')}六维评分</h4><div class="review-dimension-grid">${reviewDimensionCards(review)}</div></section><section><h4>${icon('badge-check')}做得较好</h4>${list(review.strengths, '审核未列出特别项')}</section><section><h4>${icon('circle-alert')}需要关注</h4>${list(review.issues, '未发现明显问题')}</section><section class="review-action-section"><h4>${icon('list-checks')}分层修改建议</h4>${actionGroups || list(review.suggestions, '当前可以直接确认提交')}</section></div>${submitError}<div class="review-note">评分和分析会在确认提交后保存，管理员端和导出 Excel 均可查看。</div><div class="form-foot review-actions"><button type="button" class="action-btn" data-return-weekly-edit ${state.busy ? 'disabled' : ''}>返回更改</button><button type="button" class="primary" data-submit-weekly-review ${state.busy ? 'disabled' : ''}>${state.busy ? '正在提交...' : '确认提交'}</button></div></section></div>`;
  }
  if (state.modal.type === 'square-weekly-report') {
    const report = state.squareReports.find(item => String(item.id) === String(state.modal.id));
    if (!report || report.type !== 'weekly' || (state.user?.role === 'staff' && String(report.user.id) === String(state.user?.id))) return '';
    const allAttachments = report.attachments || (report.attachment ? [report.attachment] : []);
    const attachments = state.modal.attachmentId
      ? allAttachments.filter(attachment => String(attachment.id) === String(state.modal.attachmentId))
      : allAttachments;
    const pdfAttachments = attachments.filter(attachment => attachment.mimeType === 'application/pdf' || /\.pdf$/i.test(attachment.name));
    const docxAttachments = attachments.filter(attachment => attachment.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || /\.docx$/i.test(attachment.name));
    const closeButton = `<button type="button" class="close document-reader-close" data-close title="关闭" aria-label="关闭">${icon('x')}</button>`;
    const documentPreviews = pdfAttachments.length
      ? `<div class="weekly-document-previews">${pdfAttachments.map(attachment => `<section class="weekly-document-preview"><header><span>${icon('file-text')} ${escapeHtml(attachment.name)}</span><a href="/api/attachments/${attachment.id}" target="_blank" rel="noopener" title="在新窗口打开">${icon('external-link')}<span>新窗口打开</span></a>${closeButton}</header><iframe src="/api/attachments/${attachment.id}" title="${escapeHtml(attachment.name)}"></iframe></section>`).join('')}</div>`
      : '';
    const docxPreviews = docxAttachments.length
      ? `<div class="weekly-document-previews">${docxAttachments.map(attachment => {
        const preview = state.squareDocumentPreviews[`${report.id}:${attachment.id}`];
        const content = preview?.html
          ? `<div class="weekly-docx-content">${preview.html}</div>`
          : `<p class="weekly-document-status ${preview?.error ? 'error' : ''}">${escapeHtml(preview?.error || '正在载入文档内容...')}</p>`;
        return `<section class="weekly-document-preview weekly-docx-preview"><header><span>${icon('file-text')} ${escapeHtml(attachment.name)}</span><a href="/api/attachments/${attachment.id}" target="_blank" rel="noopener" title="下载原文件">${icon('download')}<span>下载原文件</span></a>${closeButton}</header>${content}</section>`;
      }).join('')}</div>`
      : '';
    return `<div class="modal-backdrop weekly-report-backdrop" data-backdrop><section class="modal square-weekly-report-modal document-reader-modal" role="dialog" aria-modal="true" aria-label="周志文档阅读"><div class="square-weekly-report-review">${reportSquareReviewSummary(report)}</div><div class="weekly-report-content document-reader-content">${docxPreviews || documentPreviews || '<p class="muted weekly-report-empty">该周志未附带文档。</p>'}</div></section></div>`;
  }
  if (state.modal.type === 'attachment') {
    const expense = state.expenses.find(item => (item.attachments || [item.attachment]).some(attachment => attachment?.id === state.modal.id));
    if (!expense) return '';
    const attachment = (expense.attachments || [expense.attachment]).find(item => item?.id === state.modal.id);
    const isImage = attachment.mimeType.startsWith('image/');
    return `<div class="modal-backdrop" data-backdrop><section class="modal"><div class="modal-head"><div><h3>附件预览</h3><p class="section-helper">${escapeHtml(attachment.name)}</p></div><button class="close" data-close>${icon('x')}</button></div><div class="attachment-preview">${isImage ? `<img class="attachment-image" src="/api/attachments/${attachment.id}" alt="${escapeHtml(attachment.name)}">` : `<div class="receipt"><div class="receipt-logo">PDF 凭证</div><div class="receipt-line"></div><div class="receipt-line short"></div><div class="receipt-line"></div><div class="receipt-total">${money(expense.amount)}</div></div>`}<div class="attachment-info"><strong>${escapeHtml(attachment.name)}</strong><p>${expense.receiptType === 'invoice' ? '发票凭证' : '普通图片凭证'} · ${formatBytes(attachment.size)}</p><a class="action-btn" href="/api/attachments/${attachment.id}" target="_blank" rel="noopener">${icon('external-link')} 打开原文件</a></div></div></section></div>`;
  }
  const user = state.users.find(item => item.id === state.modal.id);
  if (!user) return '';
  return `<div class="modal-backdrop" data-backdrop><section class="modal"><div class="modal-head"><div><h3>员工信息</h3><p class="section-helper">修改后会立即同步到员工登录信息</p></div><button class="close" data-close>${icon('x')}</button></div><form id="employee-edit-form" data-user-id="${user.id}"><div class="person" style="margin-bottom:20px"><span class="avatar" style="width:46px;height:46px;font-size:15px">${initials(user.name)}</span><div><strong style="font-size:16px">${escapeHtml(user.name)}</strong><span class="muted" style="display:block;margin-top:3px">累计 ${user.expenseCount} 笔报销申请</span></div></div><div class="form-grid"><div class="form-group"><label for="employee-name">姓名</label><input id="employee-name" required minlength="2" maxlength="30" value="${escapeHtml(user.name)}"></div><div class="form-group"><label for="employee-phone">手机号</label><input id="employee-phone" required inputmode="numeric" maxlength="11" value="${escapeHtml(user.phone || '')}"></div></div><div class="detail-list"><div><span>累计申请金额</span><strong class="money">${money(user.expenseTotal)}</strong></div><div><span>注册时间</span><strong>${fmtDate(user.createdAt)}</strong></div></div><div class="form-foot"><button class="primary" type="submit">保存员工信息</button></div></form></section></div>`;
}

bootstrap();
