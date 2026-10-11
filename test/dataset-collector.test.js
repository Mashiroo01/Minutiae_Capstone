'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

test('dataset filename generation covers the exact ten-finger coding standard', () => {
    const collector = require('../dataset-collector');
    const expected = {
        rth: ['Right Thumb', 'ptrth1', 'crth1'],
        rin: ['Right Index', 'ptrin1', 'crin1'],
        rmi: ['Right Middle', 'ptrmi1', 'crmi1'],
        rri: ['Right Ring', 'ptrri1', 'crri1'],
        rpi: ['Right Pinky', 'ptrpi1', 'crpi1'],
        lth: ['Left Thumb', 'ptlth1', 'clth1'],
        lin: ['Left Index', 'ptlin1', 'clin1'],
        lmi: ['Left Middle', 'ptlmi1', 'clmi1'],
        lri: ['Left Ring', 'ptlri1', 'clri1'],
        lpi: ['Left Pinky', 'ptlpi1', 'clpi1']
    };

    assert.equal(collector.FINGERS.length, 10);
    for (const finger of collector.FINGERS) {
        const [label, applicantName, criminalName] = expected[finger.code];
        assert.equal(finger.label, label);
        assert.equal(collector.filenameFor('applicant', finger.code, 1), applicantName);
        assert.equal(collector.filenameFor('criminal', finger.code, 1), criminalName);
    }
    assert.equal(collector.filenameFor('applicant', 'rth', 3, 'png'), 'ptrth3.png');
    assert.equal(collector.filenameFor('criminal', 'lin', 12, 'bmp'), 'clin12.bmp');
    assert.throws(() => collector.filenameFor('criminal', 'unknown', 1), /finger code/i);
});

test('dataset quality labels reject poor captures without inventing a score', () => {
    const collector = require('../dataset-collector');

    assert.deepEqual(collector.qualityState(82), { score: 82, label: 'Good', importable: true });
    assert.deepEqual(collector.qualityState(50), { score: 50, label: 'Acceptable', importable: true });
    assert.deepEqual(collector.qualityState(30), { score: 30, label: 'Poor', importable: false });
    assert.deepEqual(collector.qualityState(null), { score: null, label: 'Unavailable', importable: false });
});

test('collector page uses the real scanner, preserves original capture, and never starts matching', () => {
    const page = fs.readFileSync(path.join(root, 'dataset-collector.html'), 'utf8');
    const client = fs.readFileSync(path.join(root, 'dataset-collector.js'), 'utf8');

    assert.match(page, /Academic Dataset Collection/);
    assert.match(page, /Applicant Dataset/);
    assert.match(page, /Criminal Dataset/);
    assert.match(page, /explicitly consented/i);
    assert.match(page, /id="fingerSelector"/);
    assert.match(page, /id="collectionProgress"/);
    assert.match(page, /id="newParticipantButton"/);
    assert.match(client, /http:\/\/localhost:9000\/scan/);
    assert.match(client, /data\.scanned !== true/);
    assert.match(client, /data\.originalImage \|\| data\.image/);
    assert.match(client, /backend\/dataset_collection\.php\?action=import/);
    assert.match(client, /capture\.filename = data\.sample\.filename/);
    assert.match(client, /capture\.filename \|\| state\.collection\?\.next_filename/);
    assert.doesNotMatch(client, /\/afis\/compare|Modified Bozorth3|SourceAFIS|OpenAFIS|MCC|Jiang/);
});

test('research storage is participant-linked, append-only, and isolated from operational fingerprint tables', () => {
    const database = fs.readFileSync(path.join(root, 'backend', 'FingerprintDB.php'), 'utf8');
    const endpoint = fs.readFileSync(path.join(root, 'backend', 'dataset_collection.php'), 'utf8');

    assert.match(database, /CREATE TABLE IF NOT EXISTS dataset_participants/);
    assert.match(database, /CREATE TABLE IF NOT EXISTS dataset_fingerprint_samples/);
    assert.match(database, /FOREIGN KEY \(participant_id\) REFERENCES dataset_participants\(id\)/);
    assert.match(database, /UNIQUE KEY unique_dataset_filename \(filename\)/);
    assert.match(database, /UNIQUE KEY unique_dataset_sample \(dataset_type, finger_code, sample_number\)/);
    assert.match(database, /GREATEST\(300/);
    assert.match(database, /random_int\(19, 65\)/);
    assert.match(database, /INSERT INTO dataset_fingerprint_samples/);
    assert.doesNotMatch(endpoint, /storeCriminalFingerprint|storeApplicantFingerprint|recordMatchResult/);
    assert.match(endpoint, /requireRole\(\['admin', 'super_admin'\]/);
    assert.match(endpoint, /QUALITY_TOO_LOW/);
    assert.match(endpoint, /SCANNER_CAPTURE_REQUIRED/);
});

test('synthetic reference participants are linked into the existing searchable criminal database', () => {
    const database = fs.readFileSync(path.join(root, 'backend', 'FingerprintDB.php'), 'utf8');
    const client = fs.readFileSync(path.join(root, 'dataset-collector.js'), 'utf8');

    assert.match(database, /criminal_record_id INT DEFAULT NULL/);
    assert.match(database, /FOREIGN KEY \(criminal_record_id\) REFERENCES criminal_records\(id\)/);
    assert.match(database, /function syncDatasetCriminalParticipant\(/);
    assert.match(database, /INSERT INTO criminal_records/);
    assert.match(database, /function datasetCriminalCaseNumber\(/);
    assert.match(database, /return 'CASE-'\s*\.\s*\$year\s*\.\s*'-'\s*\.\s*intval\(\$participantNumber\)/);
    assert.doesNotMatch(database, /RESEARCH-REF-/);
    assert.match(database, /storeCriminalFingerprint\(/);
    assert.match(database, /function backfillDatasetCriminalLinks\(/);
    assert.match(client, /Operational criminal record #\$\{participant\.criminal_record_id\}/);
});

test('dataset collector provides navigation and a browsable participant dataset', () => {
    const page = fs.readFileSync(path.join(root, 'dataset-collector.html'), 'utf8');
    const client = fs.readFileSync(path.join(root, 'dataset-collector.js'), 'utf8');
    const endpoint = fs.readFileSync(path.join(root, 'backend', 'dataset_collection.php'), 'utf8');
    const database = fs.readFileSync(path.join(root, 'backend', 'FingerprintDB.php'), 'utf8');

    assert.match(page, /id="viewNavigation"/);
    assert.match(page, /data-workspace-view="collect"/);
    assert.match(page, /data-workspace-view="browse"/);
    assert.match(page, /id="datasetParticipantList"/);
    assert.match(page, /id="datasetParticipantDetail"/);
    assert.match(page, /id="datasetSearch"/);
    assert.match(client, /action=list/);
    assert.match(client, /action=participant/);
    assert.match(client, /sample\.original_image/);
    assert.match(endpoint, /\$action === 'list'/);
    assert.match(endpoint, /\$action === 'participant'/);
    assert.match(database, /function getDatasetParticipants\(/);
    assert.match(database, /function getDatasetParticipantDetails\(/);
});

test('synthetic criminal imports always use a male or female sex value', () => {
    const database = fs.readFileSync(path.join(root, 'backend', 'FingerprintDB.php'), 'utf8');
    const client = fs.readFileSync(path.join(root, 'dataset-collector.js'), 'utf8');

    assert.match(database, /function datasetCriminalSex\(/);
    assert.match(database, /random_int\(0, 1\).*'M'.*'F'/s);
    assert.match(database, /cr\.sex AS sex/);
    assert.match(database, /SET case_number = \?, sex = \?/);
    assert.doesNotMatch(database, /VALUES \([^\n]*'U'/);
    assert.match(client, /participant\.sex === 'M' \? 'Male' : 'Female'/);
});
