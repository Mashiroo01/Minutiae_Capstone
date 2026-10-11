<?php
require_once __DIR__ . '/../../backend/FingerprintDB.php';

function notificationTestDatabase() {
    $pdo = new PDO('sqlite::memory:');
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $pdo->exec("
        CREATE TABLE applicants (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL
        );
        CREATE TABLE criminal_records (
            id INTEGER PRIMARY KEY,
            name TEXT NOT NULL
        );
        CREATE TABLE fingerprint_matches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            applicant_id INTEGER,
            criminal_id INTEGER,
            finger_matched TEXT,
            match_score INTEGER NOT NULL,
            is_match INTEGER DEFAULT 0,
            review_status TEXT DEFAULT 'CLEAR',
            review_outcome TEXT,
            review_notes TEXT,
            reviewed_at TEXT,
            disclosure_level TEXT DEFAULT 'RESTRICTED',
            comparison_id TEXT,
            comparison_result TEXT,
            notification_status TEXT NOT NULL DEFAULT 'none',
            notification_final_result TEXT,
            notification_seen_at TEXT,
            notification_read_at TEXT,
            matched_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE fingerprint_comparison_result_chunks (
            match_id INTEGER NOT NULL,
            chunk_index INTEGER NOT NULL,
            payload BLOB NOT NULL,
            PRIMARY KEY (match_id, chunk_index)
        )
    ");
    $pdo->exec("INSERT INTO applicants (id, name) VALUES (1, 'Applicant One')");
    $pdo->exec("INSERT INTO criminal_records (id, name) VALUES (7, 'Reference Seven')");

    $reflection = new ReflectionClass(FingerprintDB::class);
    $database = $reflection->newInstanceWithoutConstructor();
    $property = $reflection->getProperty('db');
    $property->setAccessible(true);
    $property->setValue($database, $pdo);
    $GLOBALS['notificationTestPdo'] = $pdo;
    return $database;
}

function comparisonResult($comparisonId, $decision) {
    return [
        'schemaVersion' => 'fingerprint-comparison-result/v1',
        'comparisonId' => $comparisonId,
        'createdAt' => '2026-10-08T00:00:00.000Z',
        'finalResult' => ['decision' => $decision],
        'matchers' => []
    ];
}

$mode = $argv[1] ?? '';
$database = notificationTestDatabase();

if ($mode === 'record-match') {
    echo json_encode($database->recordMatchResult(
        1,
        7,
        'RIGHT_THUMB',
        92,
        true,
        'PENDING_REVIEW',
        'RESTRICTED',
        comparisonResult('comparison-match-1', 'MATCH')
    ));
    exit;
}

if ($mode === 'record-no-match') {
    echo json_encode($database->recordMatchResult(
        1,
        7,
        'RIGHT_THUMB',
        12,
        false,
        'CLEAR',
        'STANDARD',
        comparisonResult('comparison-no-match-1', 'NO MATCH')
    ));
    exit;
}

if ($mode === 'lifecycle') {
    $first = $database->recordMatchResult(
        1,
        7,
        'RIGHT_THUMB',
        92,
        true,
        'PENDING_REVIEW',
        'RESTRICTED',
        comparisonResult('comparison-match-a', 'MATCH')
    );
    $second = $database->recordMatchResult(
        1,
        7,
        'LEFT_THUMB',
        94,
        true,
        'PENDING_REVIEW',
        'RESTRICTED',
        comparisonResult('comparison-match-b', 'MATCH')
    );
    $database->recordMatchResult(
        1,
        7,
        'RIGHT_INDEX',
        8,
        false,
        'CLEAR',
        'STANDARD',
        comparisonResult('comparison-no-match-b', 'NO MATCH')
    );

    $unreadBefore = $database->getFingerprintMatchNotifications('unread', 20);
    $database->updateFingerprintMatchNotificationStatus($first['notification']['id'], 'seen');
    $unreadAfterSeen = $database->getFingerprintMatchNotifications('unread', 20);
    $activeAfterSeen = $database->getFingerprintMatchNotifications('active', 20);
    $database->updateFingerprintMatchNotificationStatus($first['notification']['id'], 'read');
    $activeAfterRead = $database->getFingerprintMatchNotifications('active', 20);
    $exactComparison = $database->getComparisonResultByComparisonId('comparison-match-a');

    echo json_encode([
        'first' => $first,
        'second' => $second,
        'unreadBefore' => $unreadBefore,
        'unreadAfterSeen' => $unreadAfterSeen,
        'activeAfterSeen' => $activeAfterSeen,
        'activeAfterRead' => $activeAfterRead,
        'exactComparison' => $exactComparison
    ]);
    exit;
}

if ($mode === 'large-result') {
    $largeResult = comparisonResult('comparison-large-match', 'MATCH');
    $largeResult['diagnostics'] = ['payload' => str_repeat('x', 2 * 1024 * 1024)];
    $recorded = $database->recordMatchResult(
        1,
        7,
        'RIGHT_THUMB',
        96,
        true,
        'PENDING_REVIEW',
        'RESTRICTED',
        $largeResult
    );
    $pdo = $GLOBALS['notificationTestPdo'];
    $stored = $pdo->query("SELECT LENGTH(comparison_result) AS inline_bytes FROM fingerprint_matches LIMIT 1")->fetch(PDO::FETCH_ASSOC);
    $chunkStats = $pdo->query("SELECT COUNT(*) AS chunk_count, MAX(LENGTH(payload)) AS largest_chunk FROM fingerprint_comparison_result_chunks")->fetch(PDO::FETCH_ASSOC);
    $exactComparison = $database->getComparisonResultByComparisonId('comparison-large-match');

    echo json_encode([
        'recorded' => $recorded,
        'inlineBytes' => intval($stored['inline_bytes'] ?? 0),
        'chunkCount' => intval($chunkStats['chunk_count'] ?? 0),
        'largestChunk' => intval($chunkStats['largest_chunk'] ?? 0),
        'restoredPayloadBytes' => strlen((string)($exactComparison['comparison_result']['diagnostics']['payload'] ?? '')),
        'restoredDecision' => $exactComparison['comparison_result']['finalResult']['decision'] ?? null
    ]);
    exit;
}

if ($mode === 'history-summary') {
    $largeResult = comparisonResult('comparison-history-large', 'MATCH');
    $largeResult['diagnostics'] = ['payload' => str_repeat('x', 2 * 1024 * 1024)];
    $database->recordMatchResult(
        1,
        7,
        'RIGHT_MIDDLE',
        50,
        true,
        'PENDING_REVIEW',
        'RESTRICTED',
        $largeResult
    );
    $history = $database->getComparisonHistory(20);
    echo json_encode([
        'count' => count($history),
        'comparisonId' => $history[0]['comparison_id'] ?? null,
        'hasComparisonResult' => array_key_exists('comparison_result', $history[0] ?? []),
        'finalResult' => $history[0]['notification_final_result'] ?? null,
    ]);
    exit;
}

if ($mode === 'applicant-history-notifications') {
    $largeResult = comparisonResult('comparison-applicant-view', 'MATCH');
    $largeResult['diagnostics'] = ['payload' => str_repeat('x', 2 * 1024 * 1024)];
    $database->recordMatchResult(
        1,
        7,
        'RIGHT_RING',
        67,
        true,
        'PENDING_REVIEW',
        'RESTRICTED',
        $largeResult
    );
    $history = $database->getMatchHistory(1, true);
    echo json_encode([
        'count' => count($history),
        'hasComparisonResult' => array_key_exists('comparison_result', $history[0] ?? []),
        'comparisonId' => $history[0]['comparison_id'] ?? null,
        'notificationStatus' => $history[0]['notification_status'] ?? null,
        'notificationFinalResult' => $history[0]['notification_final_result'] ?? null,
        'fingerMatched' => $history[0]['finger_matched'] ?? null,
    ]);
    exit;
}

fwrite(STDERR, "Unknown test mode.\n");
exit(2);
