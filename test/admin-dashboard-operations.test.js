'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const adminPage = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');

test('dashboard prioritizes current workload and biometric alerts over lifetime totals', () => {
    assert.match(adminPage, /id="dashboardNeedsAttention"/);
    assert.match(adminPage, /id="dashboardSubmittedToday"/);
    assert.match(adminPage, /id="dashboardDecisionRate"/);
    assert.match(adminPage, /id="dashboardFingerprintAlerts"/);
    assert.match(adminPage, /id="dashboardAttentionBreakdown"/);
    assert.match(adminPage, /id="dashboardRecentApplications"/);
});

test('dashboard provides direct operator actions and live system readiness', () => {
    assert.match(adminPage, /Review applications/);
    assert.match(adminPage, /Register criminal/);
    assert.match(adminPage, /Open analytics/);
    assert.match(adminPage, /View system status/);
    assert.match(adminPage, /id="dashboardSystemReadiness"/);
    assert.match(adminPage, /function renderDashboardOperations\(applicantData, criminalData, historyData, notificationData, systemData\)/);
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
