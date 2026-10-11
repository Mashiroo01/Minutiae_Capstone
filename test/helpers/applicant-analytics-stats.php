<?php
require_once __DIR__ . '/../../backend/FingerprintDB.php';

class ApplicantAnalyticsStatement {
    private $rows;

    public function __construct($rows) {
        $this->rows = $rows;
    }

    public function fetch($mode = null) {
        return $this->rows[0] ?? false;
    }

    public function fetchAll($mode = null) {
        return $this->rows;
    }
}

class ApplicantAnalyticsDatabase {
    public function query($sql) {
        if (stripos($sql, 'GROUP BY fingerprint_verification_status') !== false) {
            return new ApplicantAnalyticsStatement([
                ['status' => 'CONFIRMED_MATCH', 'count' => 8],
                ['status' => 'NOT_STARTED', 'count' => 12],
                ['status' => 'CLEARED', 'count' => 20]
            ]);
        }

        if (stripos($sql, 'GROUP BY DATE(submitted_at)') !== false) {
            return new ApplicantAnalyticsStatement([
                ['date' => '2026-10-10', 'total' => 7, 'approved' => 5, 'rejected' => 1],
                ['date' => '2026-10-11', 'total' => 3, 'approved' => 1, 'rejected' => 0]
            ]);
        }

        return new ApplicantAnalyticsStatement([[
            'total' => 40,
            'approved' => 24,
            'rejected' => 8,
            'pending' => 4,
            'under_review' => 3,
            'flagged' => 1,
            'submitted_today' => 3,
            'submitted_last_7_days' => 18,
            'fingerprint_completed' => 28,
            'average_processing_hours' => 5.5
        ]]);
    }
}

$reflection = new ReflectionClass(FingerprintDB::class);
$database = $reflection->newInstanceWithoutConstructor();
$databaseProperty = $reflection->getProperty('db');
$databaseProperty->setAccessible(true);
$databaseProperty->setValue($database, new ApplicantAnalyticsDatabase());

echo json_encode($database->getApplicantStatusStats(), JSON_THROW_ON_ERROR);
