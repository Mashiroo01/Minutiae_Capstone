<?php
/**
 * Academic fingerprint dataset collection API.
 *
 * Every capture is retained in the dedicated research tables. Synthetic
 * criminal references are also linked to the operational criminal index by
 * FingerprintDB so they remain searchable. This endpoint never runs matchers.
 */

require_once __DIR__ . '/FingerprintDB.php';
require_once __DIR__ . '/auth.php';

header('Content-Type: application/json');

const DATASET_FINGERS = [
    'rth' => ['code' => 'rth', 'side' => 'right', 'name' => 'thumb', 'label' => 'Right Thumb'],
    'rin' => ['code' => 'rin', 'side' => 'right', 'name' => 'index', 'label' => 'Right Index'],
    'rmi' => ['code' => 'rmi', 'side' => 'right', 'name' => 'middle', 'label' => 'Right Middle'],
    'rri' => ['code' => 'rri', 'side' => 'right', 'name' => 'ring', 'label' => 'Right Ring'],
    'rpi' => ['code' => 'rpi', 'side' => 'right', 'name' => 'pinky', 'label' => 'Right Pinky'],
    'lth' => ['code' => 'lth', 'side' => 'left', 'name' => 'thumb', 'label' => 'Left Thumb'],
    'lin' => ['code' => 'lin', 'side' => 'left', 'name' => 'index', 'label' => 'Left Index'],
    'lmi' => ['code' => 'lmi', 'side' => 'left', 'name' => 'middle', 'label' => 'Left Middle'],
    'lri' => ['code' => 'lri', 'side' => 'left', 'name' => 'ring', 'label' => 'Left Ring'],
    'lpi' => ['code' => 'lpi', 'side' => 'left', 'name' => 'pinky', 'label' => 'Left Pinky']
];

function datasetRequestData() {
    $contentType = $_SERVER['CONTENT_TYPE'] ?? '';
    if (stripos($contentType, 'application/json') !== false) {
        return json_decode(file_get_contents('php://input'), true) ?? [];
    }
    return $_POST;
}

function datasetTypeFromMode($mode) {
    $mode = strtolower(trim((string)$mode));
    if ($mode === 'criminal' || $mode === 'criminal_reference') return 'criminal_reference';
    if ($mode === 'applicant') return 'applicant';
    return null;
}

function normalizeDatasetImage($value) {
    $value = trim((string)$value);
    if (stripos($value, 'data:image/') === 0 && strpos($value, ',') !== false) {
        $parts = explode(',', $value, 2);
        $value = trim((string)($parts[1] ?? ''));
    }
    return preg_replace('/\s+/', '', $value);
}

function datasetQuality($value) {
    if (!is_numeric($value)) return null;
    $score = max(0, min(100, intval(round(floatval($value)))));
    if ($score >= 70) return ['score' => $score, 'label' => 'Good'];
    if ($score >= 45) return ['score' => $score, 'label' => 'Acceptable'];
    return ['score' => $score, 'label' => 'Poor'];
}

try {
    $auth = new MinutiaeAuth();
    $user = $auth->requireRole(['admin', 'super_admin'], 'manage_research_dataset', 'dataset');
    $database = new FingerprintDB();
    $action = strtolower(trim((string)($_GET['action'] ?? 'state')));
    $data = $_SERVER['REQUEST_METHOD'] === 'POST' ? datasetRequestData() : $_GET;
    $datasetType = datasetTypeFromMode($data['mode'] ?? 'applicant');

    if (!$datasetType) {
        $auth->sendJson(['success' => false, 'error' => 'Invalid dataset mode.'], 422);
    }

    if ($action === 'list' && $_SERVER['REQUEST_METHOD'] === 'GET') {
        $result = $database->getDatasetParticipants(
            $datasetType,
            $data['search'] ?? '',
            $data['page'] ?? 1,
            $data['page_size'] ?? 40
        );
        $auth->sendJson($result, !empty($result['success']) ? 200 : 500);
    }

    if ($action === 'participant' && $_SERVER['REQUEST_METHOD'] === 'GET') {
        $participantId = intval($data['participant_id'] ?? 0);
        $result = $database->getDatasetParticipantDetails($datasetType, $participantId);
        $status = !empty($result['success']) ? 200 : (($result['code'] ?? '') === 'DATASET_PARTICIPANT_NOT_FOUND' ? 404 : 422);
        $auth->sendJson($result, $status);
    }

    if ($action === 'state' && $_SERVER['REQUEST_METHOD'] === 'GET') {
        $fingerCode = strtolower(trim((string)($data['finger_code'] ?? 'rth')));
        if (!isset(DATASET_FINGERS[$fingerCode])) {
            $auth->sendJson(['success' => false, 'error' => 'Invalid finger code.'], 422);
        }
        $state = $database->getDatasetCollectionState(
            $datasetType,
            !empty($data['participant_id']) ? intval($data['participant_id']) : null,
            $fingerCode,
            $data['image_format'] ?? 'png'
        );
        $auth->sendJson($state, !empty($state['success']) ? 200 : 500);
    }

    if ($action === 'new_participant' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        $consentGiven = !empty($data['consent_given']);
        $result = $database->createDatasetParticipant($datasetType, $consentGiven);
        if (!empty($result['success'])) {
            $auth->logAction(
                'create_dataset_participant',
                'dataset_participant',
                $result['participant']['id'] ?? null,
                ['dataset_type' => $datasetType, 'participant_number' => $result['participant']['participant_number'] ?? null]
            );
        }
        $auth->sendJson($result, !empty($result['success']) ? 201 : (($result['code'] ?? '') === 'CONSENT_REQUIRED' ? 422 : 500));
    }

    if ($action === 'import' && $_SERVER['REQUEST_METHOD'] === 'POST') {
        if (($data['scanner_capture'] ?? null) !== true) {
            $auth->sendJson([
                'success' => false,
                'error' => 'A real fingerprint scanner capture is required.',
                'code' => 'SCANNER_CAPTURE_REQUIRED'
            ], 422);
        }

        $fingerCode = strtolower(trim((string)($data['finger_code'] ?? '')));
        if (!isset(DATASET_FINGERS[$fingerCode])) {
            $auth->sendJson(['success' => false, 'error' => 'Invalid finger code.'], 422);
        }

        $quality = datasetQuality($data['quality_score'] ?? null);
        if (!$quality || $quality['label'] === 'Poor') {
            $auth->sendJson([
                'success' => false,
                'error' => 'Fingerprint quality is too low. Please scan again.',
                'code' => 'QUALITY_TOO_LOW'
            ], 422);
        }

        $participantId = intval($data['participant_id'] ?? 0);
        if ($participantId <= 0) {
            $auth->sendJson(['success' => false, 'error' => 'Select or create a dataset participant first.'], 422);
        }

        $templateBase64 = preg_replace('/\s+/', '', trim((string)($data['template_base64'] ?? '')));
        $template = base64_decode($templateBase64, true);
        if ($template === false || $template === '') {
            $auth->sendJson(['success' => false, 'error' => 'The scanner did not return a valid fingerprint template.'], 422);
        }

        $originalImage = normalizeDatasetImage($data['original_image'] ?? '');
        $imageBinary = base64_decode($originalImage, true);
        if ($originalImage === '' || $imageBinary === false || strlen($imageBinary) < 8) {
            $auth->sendJson(['success' => false, 'error' => 'The scanner did not return a valid original fingerprint image.'], 422);
        }

        $result = $database->storeDatasetFingerprintSample(
            $participantId,
            $datasetType,
            DATASET_FINGERS[$fingerCode],
            $template,
            $data['template_format'] ?? 'ISO',
            $originalImage,
            $data['image_format'] ?? 'png',
            $quality['score'],
            $quality['label'],
            $data['scanner_source'] ?? 'ZKTeco ZK9500 optical scanner',
            $data['captured_at'] ?? null
        );

        if (!empty($result['success'])) {
            $auth->logAction(
                'import_dataset_fingerprint',
                'dataset_fingerprint_sample',
                $result['sample']['id'] ?? null,
                [
                    'dataset_type' => $datasetType,
                    'participant_id' => $participantId,
                    'finger_code' => $fingerCode,
                    'filename' => $result['sample']['filename'] ?? null,
                    'quality_label' => $quality['label']
                ]
            );
            $result['state'] = $database->getDatasetCollectionState(
                $datasetType,
                $participantId,
                $fingerCode,
                $data['image_format'] ?? 'png'
            );
        }

        $status = !empty($result['success']) ? 201 : (($result['code'] ?? '') === 'DUPLICATE_DATASET_CAPTURE' ? 409 : 422);
        $auth->sendJson($result, $status);
    }

    $auth->sendJson(['success' => false, 'error' => 'Unsupported dataset collection action.'], 404);
} catch (Throwable $e) {
    error_log('Dataset collection endpoint error: ' . $e->getMessage());
    if (!headers_sent()) header('Content-Type: application/json');
    http_response_code(500);
    echo json_encode(['success' => false, 'error' => 'Dataset collection service is temporarily unavailable.']);
}
