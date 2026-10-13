'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');

const fixture = {
    profile: {
        matcher: 'Modified Bozorth3',
        dataset: 'DB4_B',
        threshold: 16,
        generatedAt: '2026-10-09T03:10:30.181Z',
        validation: { tp: 107, fn: 33, fp: 2, tn: 138 }
    },
    evidence: {
        applicant_records: 91,
        applicants_with_fingerprints: 74,
        active_criminal_records: 308,
        active_criminal_fingerprints: 147,
        dataset_participants: 16,
        dataset_samples: 140,
        stored_comparisons: 168,
        reviewed_comparisons: 4,
        reviewed_confirmed_matches: 3,
        reviewed_cleared_matches: 1
    }
};

test('Python analysis returns the held-out error matrix and smoothed posterior probabilities', () => {
    const execution = spawnSync('python', ['biometric_analytics.py'], {
        cwd: root,
        encoding: 'utf8',
        input: JSON.stringify(fixture)
    });

    assert.equal(execution.status, 0, execution.stderr || execution.stdout);
    const result = JSON.parse(execution.stdout);

    assert.equal(result.status, 'ready');
    assert.deepEqual(result.confusion_matrix, {
        true_positive: 107,
        false_negative: 33,
        false_positive: 2,
        true_negative: 138
    });
    assert.equal(result.metrics.sample_count, 280);
    assert.equal(result.metrics.false_accept_rate, 1.4286);
    assert.equal(result.metrics.false_reject_rate, 23.5714);
    assert.equal(result.posterior.match_given_positive, 97.2973);
    assert.equal(result.posterior.nonmatch_given_negative, 80.3468);
    assert.equal(result.operational_posterior.match_given_reviewed_alert, 66.6667);
    assert.equal(result.evidence.active_criminal_records, 308);
    assert.match(result.method, /Laplace-smoothed/i);
});

test('Python analysis refuses to invent an error matrix without held-out labels', () => {
    const execution = spawnSync('python', ['biometric_analytics.py'], {
        cwd: root,
        encoding: 'utf8',
        input: JSON.stringify({ profile: { matcher: 'Modified Bozorth3' }, evidence: fixture.evidence })
    });

    assert.equal(execution.status, 0, execution.stderr || execution.stdout);
    const result = JSON.parse(execution.stdout);
    assert.equal(result.status, 'insufficient_validation_data');
    assert.equal(result.confusion_matrix, null);
    assert.match(result.message, /held-out/i);
});

test('database evidence export is aggregate-only and covers applicants, datasets, and criminal records', () => {
    const helper = path.join(__dirname, 'helpers', 'biometric-analytics-evidence.php');
    const execution = spawnSync('php', [helper], { cwd: root, encoding: 'utf8' });

    assert.equal(execution.status, 0, execution.stderr || execution.stdout);
    assert.deepEqual(JSON.parse(execution.stdout), fixture.evidence);
});

test('PHP analytics adapter executes the Python module through one JSON interface', () => {
    const helper = path.join(__dirname, 'helpers', 'biometric-analytics-runner.php');
    const execution = spawnSync('php', [helper], {
        cwd: root,
        encoding: 'utf8',
        input: JSON.stringify(fixture)
    });

    assert.equal(execution.status, 0, execution.stderr || execution.stdout);
    const result = JSON.parse(execution.stdout);
    assert.equal(result.status, 'ready');
    assert.equal(result.confusion_matrix.true_positive, 107);
    assert.equal(result.posterior.match_given_positive, 97.2973);
});

test('admin Analytics renders biometric error and posterior evidence with clear provenance', () => {
    const admin = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
    const applicantApi = fs.readFileSync(path.join(root, 'backend', 'applicant_info.php'), 'utf8');
    const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');

    assert.match(admin, /<h3 class="analytics-panel-title">Error matrix<\/h3>/);
    assert.match(admin, /id="biometricErrorMatrix"/);
    assert.match(admin, /id="biometricPosteriorProbabilities"/);
    assert.match(admin, /id="biometricEvidenceCoverage"/);
    assert.match(admin, /function renderBiometricEvaluation\(evaluation\)/);
    assert.match(admin, /renderBiometricEvaluation\(stats\.biometric_evaluation\)/);
    assert.match(applicantApi, /BiometricAnalytics/);
    assert.match(applicantApi, /biometric_evaluation/);
    assert.match(dockerfile, /python3/);
    assert.match(dockerfile, /biometric_analytics\.py/);
});

