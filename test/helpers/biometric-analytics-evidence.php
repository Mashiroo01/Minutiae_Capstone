<?php
require_once __DIR__ . '/../../backend/FingerprintDB.php';

class BiometricEvidenceStatement {
    private $row;

    public function __construct($row) {
        $this->row = $row;
    }

    public function fetch($mode = null) {
        return $this->row;
    }
}

class BiometricEvidenceDatabase {
    public function query($sql) {
        if (stripos($sql, 'reviewed_confirmed_matches') !== false) {
            return new BiometricEvidenceStatement([
                'reviewed_comparisons' => 4,
                'reviewed_confirmed_matches' => 3,
                'reviewed_cleared_matches' => 1
            ]);
        }

        return new BiometricEvidenceStatement([
            'applicant_records' => 91,
            'applicants_with_fingerprints' => 74,
            'active_criminal_records' => 308,
            'active_criminal_fingerprints' => 147,
            'dataset_participants' => 16,
            'dataset_samples' => 140,
            'stored_comparisons' => 168
        ]);
    }
}

$reflection = new ReflectionClass(FingerprintDB::class);
$database = $reflection->newInstanceWithoutConstructor();
$databaseProperty = $reflection->getProperty('db');
$databaseProperty->setAccessible(true);
$databaseProperty->setValue($database, new BiometricEvidenceDatabase());

echo json_encode($database->getBiometricAnalyticsEvidence(), JSON_THROW_ON_ERROR);

