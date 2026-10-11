'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

function read(relativePath) {
    return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('Docker Compose packages the web app, database, and fingerprint service', () => {
    const compose = read('compose.yaml');

    assert.match(compose, /^services:\s*$/m);
    assert.match(compose, /^  web:\s*$/m);
    assert.match(compose, /^  database:\s*$/m);
    assert.match(compose, /^  fingerprint:\s*$/m);
    assert.match(compose, /MINUTIAE_DB_HOST:\s*database/);
    assert.match(compose, /MINUTIAE_AFIS_BASE_URL:\s*\$\{MINUTIAE_AFIS_BASE_URL:-http:\/\/host\.docker\.internal:9000\}/);
    assert.match(compose, /db_data:/);
});

test('real scanner mode routes the web container to the Windows host service', () => {
    const compose = read('compose.yaml');

    assert.match(compose, /MINUTIAE_AFIS_BASE_URL:\s*\$\{MINUTIAE_AFIS_BASE_URL:-http:\/\/host\.docker\.internal:9000\}/);
    assert.match(compose, /extra_hosts:[\s\S]*host\.docker\.internal:host-gateway/);
    assert.match(compose, /^  fingerprint:[\s\S]*profiles:\s*\["simulation"\]/m);
});

test('container credentials are configurable and local secrets are excluded from images', () => {
    const compose = read('compose.yaml');
    const dockerignore = read('.dockerignore');

    assert.match(compose, /MINUTIAE_DB_PASSWORD:\s*["']?\$\{MINUTIAE_DB_PASSWORD:\?/);
    assert.match(compose, /MINUTIAE_ADMIN_PASSWORD:\s*["']?\$\{MINUTIAE_ADMIN_PASSWORD:\?/);
    assert.match(dockerignore, /^\.env$/m);
    assert.match(dockerignore, /^backend\/config\.php$/m);
    assert.match(dockerignore, /^temp\/$/m);
    assert.match(dockerignore, /^node_modules\/$/m);
});

test('PHP API uses the configured fingerprint service base URL', () => {
    const config = read('backend/config.example.php');
    const applicant = read('backend/applicant_info.php');
    const criminal = read('backend/criminal_info.php');

    assert.match(config, /MINUTIAE_AFIS_BASE_URL/);
    assert.match(applicant, /fingerprint_service_url/);
    assert.match(criminal, /fingerprint_service_url/);
    assert.doesNotMatch(applicant, /file_get_contents\('http:\/\/localhost:9000/);
    assert.doesNotMatch(criminal, /file_get_contents\('http:\/\/localhost:9000/);
});
