<?php
require_once __DIR__ . '/../../backend/FingerprintDB.php';

$pdo = new PDO('sqlite::memory:');
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
$pdo->exec("
    CREATE TABLE applicants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        age INTEGER,
        sex TEXT,
        email TEXT,
        clearance_status TEXT,
        fingerprint_verification_status TEXT,
        privacy_consent_given INTEGER,
        privacy_consent_at TEXT,
        privacy_notice_version TEXT
    );
    CREATE TABLE application_update_logs (
        applicant_id INTEGER,
        change_type TEXT,
        note TEXT,
        previous_status TEXT,
        new_status TEXT,
        previous_fingerprint_status TEXT,
        new_fingerprint_status TEXT,
        actor_user_id INTEGER,
        actor_name TEXT,
        actor_role TEXT,
        metadata TEXT
    );
");

$reflection = new ReflectionClass(FingerprintDB::class);
$database = $reflection->newInstanceWithoutConstructor();
$property = $reflection->getProperty('db');
$property->setAccessible(true);
$property->setValue($database, $pdo);

$result = $database->registerApplicant(
    'Timestamp Regression',
    30,
    'F',
    null,
    [
        'accepted' => true,
        'consented_at' => '2026-10-10T06:49:19.544Z',
        'version' => 'test-v1'
    ]
);

$stored = $pdo->query('SELECT privacy_consent_at FROM applicants LIMIT 1')->fetchColumn();
echo json_encode(['result' => $result, 'stored' => $stored]);
