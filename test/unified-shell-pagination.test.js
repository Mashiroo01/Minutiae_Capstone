'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const admin = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
const dashboard = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');
const criminalApi = fs.readFileSync(path.join(root, 'backend', 'criminal_info.php'), 'utf8');
const database = fs.readFileSync(path.join(root, 'backend', 'FingerprintDB.php'), 'utf8');

test('admin shell attaches its navigation to the viewport and uses a restrained blue header', () => {
    assert.match(admin, /--sidebar-inset:\s*0/);
    assert.match(admin, /\.sidebar\s*\{[^}]*width:\s*var\(--sidebar-width\)[^}]*left:\s*0[^}]*border-radius:\s*0/s);
    assert.match(admin, /\.main-content\s*\{[^}]*margin-left:\s*var\(--sidebar-width\)/s);
    assert.match(admin, /\.navbar-admin\s*\{[^}]*background:\s*radial-gradient\([^;]+\),\s*var\(--pnp-blue\)/s);
    assert.match(admin, /@media \(max-width:\s*992px\)[\s\S]*?\.sidebar\s*\{[^}]*display:\s*flex[^}]*overflow-x:\s*auto/s);
});

test('applicant dashboard uses the full viewport and a wide 65/35 hero', () => {
    assert.match(dashboard, /\.main-container\s*\{[^}]*width:\s*100%[^}]*max-width:\s*none[^}]*margin:\s*0/s);
    assert.match(dashboard, /\.hero-shell\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1\.85fr\)\s+minmax\(280px,\s*1fr\)/s);
    assert.match(dashboard, /\.navbar\s*\{[^}]*position:\s*sticky[^}]*top:\s*0[^}]*z-index:\s*1030/s);
});

test('criminal database API performs bounded server-side pagination and filtering', () => {
    assert.match(database, /function getCriminalRecordsPage\(/);
    assert.match(database, /LIMIT\s+\{\$perPage\}\s+OFFSET\s+\{\$offset\}/);
    assert.match(database, /COUNT\(\*\).*criminal_records/s);
    assert.match(criminalApi, /min\(50,\s*intval\(\$_GET\['limit'\]/);
    assert.match(criminalApi, /\$_GET\['search'\]/);
    assert.match(criminalApi, /getCriminalRecordsPage\(/);
});

test('criminal database UI requests 50 records and exposes search-aware pagination', () => {
    assert.match(admin, /const CRIMINALS_PER_PAGE = 50/);
    assert.match(admin, /id="criminalPaginationInfo"/);
    assert.match(admin, /id="criminalPaginationControls"/);
    assert.match(admin, /params\.set\('limit',\s*String\(CRIMINALS_PER_PAGE\)\)/);
    assert.match(admin, /params\.set\('search',\s*criminalSearchTerm\)/);
    assert.match(admin, /criminalPage\s*=\s*1;[\s\S]*?loadCriminals\(1\)/);
    assert.match(admin, /function changeCriminalPage\(page\)/);
});

test('system status uses readable service, technical-detail, and matcher typography', () => {
    assert.match(admin, /\.system-status-toolbar \.page-subtitle\s*\{[^}]*font-size:\s*16px/s);
    assert.match(admin, /\.system-health-card h4\s*\{[^}]*font-size:\s*18px/s);
    assert.match(admin, /\.system-health-card p\s*\{[^}]*font-size:\s*15px/s);
    assert.match(admin, /\.system-health-state\s*\{[^}]*font-size:\s*13px/s);
    assert.match(admin, /\.system-detail-row dd\s*\{[^}]*font-size:\s*14px/s);
    assert.match(admin, /\.system-matcher-item\s*\{[^}]*min-height:\s*48px[^}]*font-size:\s*15px/s);
    assert.match(admin, /\.system-status-advice\s*\{[^}]*font-size:\s*14px/s);
    assert.match(admin, /system-matcher-state/);
});
