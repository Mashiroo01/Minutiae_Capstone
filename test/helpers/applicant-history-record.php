<?php
require_once __DIR__ . '/../../backend/applicant_info.php';

class ApplicantHistoryTestDatabase {
    public function getApplicantById($applicantId) {
        return [
            'id' => intval($applicantId),
            'name' => 'Applicant, History',
            'age' => 31,
            'sex' => 'F',
            'email' => 'history@example.test',
            'clearance_status' => 'UNDER_REVIEW',
            'fingerprint_verification_status' => 'POTENTIAL_MATCH',
            'submitted_at' => '2026-10-10 06:55:44',
            'last_updated_at' => '2026-10-10 06:57:35',
            'privacy_notice_version' => '2026-01'
        ];
    }

    public function getApplicantFingerprints($applicantId = null) {
        return [[
            'id' => 9,
            'applicant_id' => intval($applicantId),
            'finger_position' => 'RIGHT_INDEX',
            'template' => "\xB3\x9A\xFF\x00",
            'template_format' => 'ISO',
            'quality_score' => 84,
            'submitted_at' => '2026-10-10 06:56:01'
        ]];
    }

    public function getApplicantFingerprintSummaries($applicantId = null) {
        return [[
            'id' => 9,
            'applicant_id' => intval($applicantId),
            'finger_position' => 'RIGHT_INDEX',
            'template_format' => 'ISO',
            'quality_score' => 84,
            'submitted_at' => '2026-10-10 06:56:01'
        ]];
    }

    public function getMatchHistory($applicantId, $includeSensitive = true) {
        return [];
    }

    public function getApplicantReviewSummary($applicantId) {
        return ['pending_reviews' => 1, 'positive_matches' => 1, 'best_score' => 78];
    }

    public function getApplicationUpdateLogs($applicantId, $viewerRole = 'admin') {
        return [[
            'id' => 4,
            'applicant_id' => intval($applicantId),
            'change_type' => 'STATUS_UPDATED',
            'note' => 'Application moved to manual review.',
            'previous_status' => 'PENDING_FINGERPRINT',
            'new_status' => 'UNDER_REVIEW',
            'previous_fingerprint_status' => 'SUBMITTED',
            'new_fingerprint_status' => 'POTENTIAL_MATCH',
            'actor_name' => 'system',
            'actor_role' => 'system',
            'changed_at' => '2026-10-10 06:57:35'
        ]];
    }
}

$reflection = new ReflectionClass(ApplicantInfo::class);
$applicantInfo = $reflection->newInstanceWithoutConstructor();
$databaseProperty = $reflection->getProperty('db');
$databaseProperty->setAccessible(true);
$databaseProperty->setValue($applicantInfo, new ApplicantHistoryTestDatabase());

$result = $applicantInfo->getApplicantRecord(87, 'super_admin');
echo json_encode($result, JSON_THROW_ON_ERROR);
