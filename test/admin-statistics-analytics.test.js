'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const adminPage = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');

test('applicant statistics API exposes decision, fingerprint, throughput, and trend analytics', () => {
    const harness = path.join(__dirname, 'helpers', 'applicant-analytics-stats.php');
    const execution = spawnSync('php', [harness], { cwd: root, encoding: 'utf8' });

    assert.equal(execution.status, 0, execution.stderr || execution.stdout);
    const stats = JSON.parse(execution.stdout);
    assert.equal(stats.total, 40);
    assert.equal(stats.approval_rate, 75);
    assert.equal(stats.decision_rate, 80);
    assert.equal(stats.fingerprint_completion_rate, 70);
    assert.equal(stats.average_processing_hours, 5.5);
    assert.equal(stats.submitted_today, 3);
    assert.equal(stats.submitted_last_7_days, 18);
    assert.deepEqual(stats.status_distribution.map((item) => item.key), [
        'approved', 'rejected', 'pending', 'under_review', 'flagged'
    ]);
    assert.equal(stats.fingerprint_distribution[0].status, 'CONFIRMED_MATCH');
    assert.equal(stats.daily_trend.length, 2);
});

test('Analytics navigation renders accessible operational analytics instead of two static counters', () => {
    assert.match(adminPage, /switchSection\('statistics', event\)[\s\S]*?<i class="bi bi-bar-chart"><\/i> Analytics/);
    assert.match(adminPage, /class="analytics-kpi-grid"/);
    assert.match(adminPage, /id="analyticsTrendChart"/);
    assert.match(adminPage, /id="clearanceOutcomeChart"/);
    assert.match(adminPage, /id="fingerprintAnalyticsList"/);
    assert.match(adminPage, /id="analyticsInsights"/);
    assert.match(adminPage, /aria-label="14-day application volume"/);
    assert.match(adminPage, /function renderStatisticsAnalytics\(stats\)/);
    assert.match(adminPage, /function renderAnalyticsTrend\(points\)/);
});

test('statistics analytics includes loading, refresh timestamp, and recoverable error states', () => {
    assert.match(adminPage, /id="statisticsLoadingState"/);
    assert.match(adminPage, /id="statisticsUpdatedAt"/);
    assert.match(adminPage, /id="statisticsErrorState"/);
    assert.match(adminPage, /Unable to load analytics/);
});
