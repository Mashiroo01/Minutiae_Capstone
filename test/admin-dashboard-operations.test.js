'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const adminPage = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');

test('dashboard prioritizes three balanced workload KPIs without a fingerprint alerts card', () => {
    assert.match(adminPage, /id="dashboardNeedsAttention"/);
    assert.match(adminPage, /id="dashboardSubmittedToday"/);
    assert.match(adminPage, /id="dashboardDecisionRate"/);
    assert.doesNotMatch(adminPage, /id="dashboardFingerprintAlerts"/);
    assert.doesNotMatch(adminPage, /dashboard-kpi-label">Fingerprint alerts/i);
    assert.match(adminPage, /\.dashboard-kpi-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,/s);
    assert.match(adminPage, /id="dashboardAttentionBreakdown"/);
    assert.match(adminPage, /id="dashboardRecentApplications"/);
});

test('work queue shows only pending and under-review work in two equal tiles', () => {
    assert.match(adminPage, /\.dashboard-attention-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,/s);
    assert.match(adminPage, /const needsAttention = pending \+ underReview;/);
    assert.match(adminPage, /\{ label: 'Pending', count: pending \},\s*\{ label: 'Under review', count: underReview \}/s);
    assert.doesNotMatch(adminPage, /\{ label: 'Flagged', count: flagged \}/);
    assert.match(adminPage, /\.dashboard-main-grid\s*\{[^}]*align-items:\s*stretch/s);
});

test('dashboard provides direct operator actions and live system readiness', () => {
    assert.match(adminPage, /Review applications/);
    assert.match(adminPage, /Register criminal/);
    assert.match(adminPage, /Open analytics/);
    assert.match(adminPage, /View system status/);
    assert.match(adminPage, /id="dashboardSystemReadiness"/);
    assert.match(adminPage, /function renderDashboardOperations\(applicantData, criminalData, historyData, systemData\)/);
    assert.doesNotMatch(adminPage, /<strong>System Ready:<\/strong> Modified Bozorth3 fingerprint matching is operational/);
});

test('dashboard has loading, empty, refresh, and accessible live states', () => {
    assert.match(adminPage, /id="dashboardLoading"/);
    assert.match(adminPage, /id="dashboardUpdatedAt"/);
    assert.match(adminPage, /onclick="loadDashboardData\(\)"/);
    assert.match(adminPage, /aria-live="polite"/);
    assert.match(adminPage, /No recent applications yet/);
});

test('navigation and dashboard typography stay readable at normal zoom', () => {
    assert.match(adminPage, /\.nav-item\s*\{[^}]*font-size:\s*17px/s);
    assert.match(adminPage, /\.sidebar-brand small\s*\{[^}]*font-size:\s*13px/s);
    assert.match(adminPage, /\.top-status\s*\{[^}]*font-size:\s*15px/s);
    assert.match(adminPage, /#fingerprintNotificationButton\s*\{[^}]*font-size:\s*15px/s);
    assert.match(adminPage, /\.logout-button\s*\{[^}]*font-size:\s*15px/s);
    assert.match(adminPage, /\.dashboard-panel-title\s*\{[^}]*font-size:\s*17px/s);
    assert.match(adminPage, /\.dashboard-kpi-detail\s*\{[^}]*font-size:\s*13px/s);
    assert.match(adminPage, /\.dashboard-quick-action strong\s*\{[^}]*font-size:\s*14px/s);
    assert.match(adminPage, /\.dashboard-recent-name\s*\{[^}]*font-size:\s*14px/s);
});

test('mobile navigation wraps large header controls without horizontal overflow', () => {
    assert.match(adminPage, /@media \(max-width: 768px\)[\s\S]*?\.navbar-admin \.container-fluid\s*\{[^}]*flex-wrap:\s*wrap/s);
    assert.match(adminPage, /@media \(max-width: 768px\)[\s\S]*?\.navbar-admin \.container-fluid > \.d-flex\s*\{[^}]*width:\s*100%[^}]*flex-wrap:\s*wrap/s);
    assert.match(adminPage, /@media \(max-width: 768px\)[\s\S]*?\.top-status\s*\{[^}]*flex:\s*1 1 100%/s);
});
