<?php
/**
 * Criminal Fingerprint Management
 * Handles storage and retrieval of criminal fingerprints
 */

require_once 'Bozorth3Matcher.php';
require_once 'FingerprintDB.php';
require_once 'auth.php';

class CriminalInfo {
    
    private $db;
    private $matcher;
    private $afisProfileCache = [];
    private $afisBaseUrl;
    
    public function __construct($pdo = null) {
        $config = require __DIR__ . '/config.php';
        $this->db = new FingerprintDB($pdo);
        $this->matcher = new Bozorth3Matcher();
        $this->afisBaseUrl = rtrim(
            $config['services']['fingerprint_service_url'] ?? 'http://localhost:9000',
            '/'
        );
    }

    private function normalizeFingerprintImage($value) {
        if (!is_string($value)) {
            return '';
        }

        $value = trim($value);
        if ($value === '') {
            return '';
        }

        if (strpos($value, ',') !== false && stripos($value, 'data:image/') === 0) {
            $parts = explode(',', $value, 2);
            return trim((string)($parts[1] ?? ''));
        }

        return $value;
    }

    private function looksLikeImageBinary($value) {
        if (!is_string($value) || strlen($value) < 4) {
            return false;
        }

        if (strncmp($value, "\x89PNG", 4) === 0) {
            return true;
        }

        if (strncmp($value, "\xFF\xD8\xFF", 3) === 0) {
            return true;
        }

        if (strncmp($value, 'BM', 2) === 0) {
            return true;
        }

        if (strncmp($value, "II*\x00", 4) === 0 || strncmp($value, "MM\x00*", 4) === 0) {
            return true;
        }

        return false;
    }

    private function buildAfisProfileFromImage($imageBase64) {
        $imageBase64 = $this->normalizeFingerprintImage($imageBase64);
        if ($imageBase64 === '') {
            return ['success' => false, 'error' => 'Missing fingerprint image'];
        }

        $cacheKey = hash('sha256', $imageBase64);
        if (isset($this->afisProfileCache[$cacheKey])) {
            return $this->afisProfileCache[$cacheKey];
        }

        $context = stream_context_create([
            'http' => [
                'method' => 'POST',
                'header' => "Content-Type: application/json\r\n",
                'content' => json_encode(['image' => $imageBase64]),
                'timeout' => 12
            ]
        ]);

        $response = @file_get_contents($this->afisBaseUrl . '/afis/from-image', false, $context);
        if ($response === false) {
            $result = ['success' => false, 'error' => 'Fingerprint image conversion is unavailable. Please ensure the fingerprint service is running.'];
            $this->afisProfileCache[$cacheKey] = $result;
            return $result;
        }

        $decoded = json_decode($response, true);
        if (empty($decoded['success']) || empty($decoded['templateBase64'])) {
            $result = [
                'success' => false,
                'error' => is_array($decoded)
                    ? ($decoded['error'] ?? 'Fingerprint image conversion failed.')
                    : 'Fingerprint image conversion failed.'
            ];
            $this->afisProfileCache[$cacheKey] = $result;
            return $result;
        }

        $templateBinary = base64_decode((string)$decoded['templateBase64'], true);
        if ($templateBinary === false) {
            $result = ['success' => false, 'error' => 'Invalid fingerprint template returned by the conversion service.'];
            $this->afisProfileCache[$cacheKey] = $result;
            return $result;
        }

        $result = [
            'success' => true,
            'template_binary' => $templateBinary,
            'image_base64' => $this->normalizeFingerprintImage($decoded['image'] ?? $imageBase64),
            'quality' => intval($decoded['afisQuality'] ?? $decoded['quality'] ?? 90),
            'template_format' => $decoded['format'] ?? 'ISO'
        ];
        $this->afisProfileCache[$cacheKey] = $result;
        return $result;
    }

    public function prepareFingerprintPayloadFromRequest($data, $fileKey = 'fingerprint') {
        $template = '';
        $fingerprintImage = $data['fingerprint_image'] ?? null;
        $fingerprintFilename = $data['fingerprint_filename'] ?? null;
        $templateFormat = $data['template_format'] ?? 'ISO';
        $quality = intval($data['quality'] ?? 90);
        $sourceWasImage = false;

        if (!empty($_FILES[$fileKey]) && is_uploaded_file($_FILES[$fileKey]['tmp_name'])) {
            $template = file_get_contents($_FILES[$fileKey]['tmp_name']);
            $fileType = strtolower((string)($_FILES[$fileKey]['type'] ?? ''));
            $fileName = strtolower((string)($_FILES[$fileKey]['name'] ?? ''));
            $sourceWasImage = stripos($fileType, 'image/') === 0
                || preg_match('/\.(png|jpe?g|bmp|tiff?)$/', $fileName);

            if ((empty($fingerprintFilename) || trim((string)$fingerprintFilename) === '') && !empty($_FILES[$fileKey]['name'])) {
                $fingerprintFilename = $_FILES[$fileKey]['name'];
            }
        } elseif (!empty($data['fingerprint_data'])) {
            $rawFingerprintData = trim((string)$data['fingerprint_data']);
            $sourceWasImage = stripos($rawFingerprintData, 'data:image/') === 0;
            if ($sourceWasImage && strpos($rawFingerprintData, ',') !== false) {
                $parts = explode(',', $rawFingerprintData, 2);
                $rawFingerprintData = trim((string)($parts[1] ?? ''));
            }
            $decoded = base64_decode($rawFingerprintData, true);
            $template = ($decoded !== false) ? $decoded : (string)$data['fingerprint_data'];
        }

        $fingerprintImage = $this->normalizeFingerprintImage(is_string($fingerprintImage) ? $fingerprintImage : '');
        if ($fingerprintImage === '' && $template !== '' && $this->looksLikeImageBinary($template)) {
            $fingerprintImage = base64_encode($template);
            $sourceWasImage = true;
        }

        if ($fingerprintImage !== '' && ($sourceWasImage || $this->looksLikeImageBinary($template))) {
            $profile = $this->buildAfisProfileFromImage($fingerprintImage);
            if (empty($profile['success'])) {
                return $profile;
            }

            $template = $profile['template_binary'];
            $fingerprintImage = $profile['image_base64'] ?? $fingerprintImage;
            $templateFormat = $profile['template_format'] ?? 'ISO';
            $quality = intval($profile['quality'] ?? $quality);
        }

        return [
            'success' => true,
            'template' => $template,
            'fingerprint_image' => $fingerprintImage !== '' ? $fingerprintImage : null,
            'fingerprint_filename' => is_string($fingerprintFilename) ? trim($fingerprintFilename) : null,
            'template_format' => $templateFormat,
            'quality' => $quality
        ];
    }

    private function sanitizeFingerprintForViewer($fingerprintRow, $viewerRole, $canDelete = false) {
        $role = strtolower((string)$viewerRole);
        $isBiometricManager = in_array($role, ['admin', 'super_admin'], true);
        if (!$isBiometricManager) {
            return null;
        }

        return [
            'id' => intval($fingerprintRow['id'] ?? 0),
            'finger_position' => $fingerprintRow['finger_position'] ?? 'UNSPECIFIED',
            'template_format' => $fingerprintRow['template_format'] ?? 'ISO',
            'quality_score' => intval($fingerprintRow['quality_score'] ?? 0),
            'captured_at' => $fingerprintRow['captured_at'] ?? null,
            'is_active' => intval($fingerprintRow['is_active'] ?? 0),
            'fingerprint_filename' => $fingerprintRow['fingerprint_filename'] ?? null,
            'deactivated_at' => $fingerprintRow['deactivated_at'] ?? null,
            'deactivation_reason' => $fingerprintRow['deactivation_reason'] ?? null,
            'can_delete' => $canDelete && intval($fingerprintRow['is_active'] ?? 0) === 1
        ];
    }
    
    /**
     * Add a new criminal record with fingerprints
     */
    public function addCriminalRecord($name, $caseNumber, $fingerprints = [], $age = null, $sex = null) {
        if (!$this->db) {
            return [
                'success' => false,
                'error' => 'Database not available'
            ];
        }

        if (empty(trim((string)$name))) {
            return [
                'success' => false,
                'error' => 'Criminal name is required'
            ];
        }
        
        try {
            $reg = $this->db->registerCriminal($name, $age, $sex, $caseNumber);
            if (empty($reg['success'])) {
                return $reg;
            }
            $criminalId = intval($reg['criminal_id']);
            
            $result = [
                'success' => true,
                'criminal_id' => $criminalId,
                'criminal_name' => $name,
                'case_number' => $caseNumber,
                'fingerprints_stored' => 0,
                'fingerprints' => [],
                'fingerprint_errors' => []
            ];
            
            // Store each fingerprint
            foreach ($fingerprints as $finger => $data) {
                if (isset($data['template'])) {
                    $storeResult = $this->db->storeCriminalFingerprint(
                        $criminalId,
                        $finger,
                        $data['template'],
                        isset($data['format']) ? $data['format'] : 'ISO',
                        isset($data['quality']) ? $data['quality'] : 0,
                        isset($data['image']) ? $data['image'] : null,
                        isset($data['filename']) ? $data['filename'] : null
                    );
                    
                    if ($storeResult['success']) {
                        $result['fingerprints_stored']++;
                        $result['fingerprints'][] = [
                            'finger' => $finger,
                            'status' => 'stored'
                        ];
                    } else {
                        $result['fingerprint_errors'][] = [
                            'finger' => $finger,
                            'error' => $storeResult['error'] ?? 'Fingerprint storage failed',
                            'code' => $storeResult['code'] ?? null,
                            'duplicate' => $storeResult['duplicate'] ?? null
                        ];
                    }
                }
            }
            
            return $result;
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage()
            ];
        }
    }
    
    /**
     * Get criminal by ID with fingerprints
     */
    public function getCriminalRecord($criminalId, $viewerRole = 'admin') {
        $record = $this->db->getCriminalRecords($criminalId);
        $role = strtolower((string)$viewerRole);
        $isSuperAdmin = $role === 'super_admin';
        $isBiometricManager = in_array($role, ['super_admin', 'admin'], true);
        $canDelete = in_array($role, ['super_admin', 'admin'], true);
        $rawFingerprints = $isBiometricManager ? $this->db->getCriminalFingerprints($criminalId, $isSuperAdmin) : [];
        $fingerprints = [];
        foreach ($rawFingerprints as $row) {
            $sanitized = $this->sanitizeFingerprintForViewer($row, $role, $canDelete);
            if ($sanitized !== null) {
                $fingerprints[] = $sanitized;
            }
        }
        
        return [
            'success' => !empty($record),
            'criminal_id' => $criminalId,
            'record' => !empty($record) ? $record[0] : null,
            'fingerprints' => $fingerprints,
            'count' => $isBiometricManager ? count($fingerprints) : intval($record[0]['fingerprint_count'] ?? 0),
            'biometric_access' => $isBiometricManager ? 'managed' : 'restricted',
            'permissions' => [
                'can_view_biometric_metadata' => $isBiometricManager,
                'can_delete_fingerprint' => $canDelete
            ]
        ];
    }

    public function deleteCriminalFingerprintTemplate($fingerprintId, $reason = null) {
        return $this->db->deactivateCriminalFingerprint($fingerprintId, $reason);
    }

    public function deleteCriminalRecord($criminalId, $reason = null) {
        return $this->db->deactivateCriminalRecord($criminalId, $reason);
    }

    public function updateCriminalRecord($criminalId, $name, $caseNumber, $fingerprints = [], $age = null, $sex = null) {
        if (!$this->db) {
            return [
                'success' => false,
                'error' => 'Database not available'
            ];
        }

        if (intval($criminalId) <= 0) {
            return [
                'success' => false,
                'error' => 'Valid criminal ID is required.'
            ];
        }

        if (empty(trim((string)$name))) {
            return [
                'success' => false,
                'error' => 'Criminal name is required'
            ];
        }

        try {
            $update = $this->db->updateCriminalRecord($criminalId, $name, $age, $sex, $caseNumber);
            if (empty($update['success'])) {
                return $update;
            }

            $result = [
                'success' => true,
                'criminal_id' => intval($criminalId),
                'criminal_name' => $name,
                'case_number' => $caseNumber,
                'fingerprints_stored' => 0,
                'fingerprints' => [],
                'fingerprint_errors' => []
            ];

            foreach ($fingerprints as $finger => $data) {
                if (!isset($data['template'])) {
                    continue;
                }

                $storeResult = $this->db->storeCriminalFingerprint(
                    intval($criminalId),
                    $finger,
                    $data['template'],
                    isset($data['format']) ? $data['format'] : 'ISO',
                    isset($data['quality']) ? $data['quality'] : 0,
                    isset($data['image']) ? $data['image'] : null,
                    isset($data['filename']) ? $data['filename'] : null
                );

                if (!empty($storeResult['success'])) {
                    $result['fingerprints_stored']++;
                    $result['fingerprints'][] = [
                        'finger' => $finger,
                        'status' => 'stored'
                    ];
                } else {
                    $result['fingerprint_errors'][] = [
                        'finger' => $finger,
                        'error' => $storeResult['error'] ?? 'Fingerprint storage failed',
                        'code' => $storeResult['code'] ?? null,
                        'duplicate' => $storeResult['duplicate'] ?? null
                    ];
                }
            }

            return $result;
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage()
            ];
        }
    }
    
    /**
     * Search criminal database for fingerprint match
     */
    public function searchCriminalDatabase($probeTemplate, $finger = 'index_right') {
        $allCriminals = $this->db->getCriminalFingerprints();
        
        // Filter by finger position
        $sameFinger = array_filter($allCriminals, function($fp) use ($finger) {
            return $fp['finger_position'] === $finger;
        });
        
        if (empty($sameFinger)) {
            return [
                'success' => true,
                'matches' => [],
                'message' => 'No criminal records found with matching finger position'
            ];
        }
        
        // Match against all criminal fingerprints with same finger
        $matches = [];
        foreach ($sameFinger as $criminalFp) {
            $matchResult = $this->matcher->matchTemplates(
                $probeTemplate,
                $criminalFp['template'],
                $criminalFp['template_format']
            );
            
            if ($matchResult['success']) {
                $matchData = [
                    'criminal_fp_id' => $criminalFp['id'],
                    'score' => $matchResult['score'],
                    'match' => $matchResult['match'],
                    'finger' => $criminalFp['finger_position']
                ];
                
                $matches[] = $matchData;
            }
        }
        
        // Sort by score descending
        usort($matches, function($a, $b) {
            return $b['score'] - $a['score'];
        });
        
        return [
            'success' => true,
            'matches' => $matches,
            'total_matches' => count($matches),
            'positive_matches' => count(array_filter($matches, function($m) { return $m['match']; }))
        ];
    }
    
    /**
     * Get Bozorth3 status
     */
    public function getMatcherStatus() {
        return $this->matcher->getStatus();
    }
    
    /**
     * Get all criminals (for admin/testing)
     */
    public function getAllCriminals() {
        return $this->db->getCriminalRecords();
    }
    
    /**
     * Set PDO connection
     */
    public function setConnection($pdo) {
        $this->db->setConnection($pdo);
    }
}

// API Endpoint Usage (execute only when this file is requested directly)
if (realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__) {
header('Content-Type: application/json');

$auth = new MinutiaeAuth();

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $action = $_GET['action'] ?? 'search';
    $criminalInfo = new CriminalInfo();
    
    switch ($action) {
        case 'add':
            $auth->requireRole(['admin', 'super_admin'], 'register_criminal_record', 'criminal');
            // Add criminal record with fingerprints
            $contentType = $_SERVER['CONTENT_TYPE'] ?? '';
            if (stripos($contentType, 'multipart/form-data') !== false || stripos($contentType, 'application/x-www-form-urlencoded') !== false) {
                $data = $_POST;
            } else {
                $data = json_decode(file_get_contents('php://input'), true) ?? [];
            }

            $fingerprints = [];
            $fingerPosition = $data['finger_position'] ?? 'RIGHT_INDEX';
            $fingerprintPayload = $criminalInfo->prepareFingerprintPayloadFromRequest($data, 'fingerprint');
            if (empty($fingerprintPayload['success'])) {
                $auth->sendJson($fingerprintPayload, 422);
            }

            $template = $fingerprintPayload['template'] ?? '';
            if (!empty($template)) {
                $db = new FingerprintDB();
                $duplicate = $db->findCriminalFingerprintDuplicate($template, $fingerprintPayload['fingerprint_image'] ?? null, null, false);
                if (!empty($duplicate)) {
                    $auth->sendJson([
                        'success' => false,
                        'error' => 'Fingerprint already exists in another criminal profile. Upload a different fingerprint image/template.',
                        'code' => 'DUPLICATE_FINGERPRINT',
                        'duplicate' => $duplicate
                    ], 409);
                }
            }

            if (!empty($template)) {
                $fingerprints[$fingerPosition] = [
                    'template' => $template,
                    'format' => $fingerprintPayload['template_format'] ?? ($data['template_format'] ?? 'ISO'),
                    'quality' => intval($fingerprintPayload['quality'] ?? ($data['quality'] ?? 90)),
                    'image' => $fingerprintPayload['fingerprint_image'] ?? null,
                    'filename' => $fingerprintPayload['fingerprint_filename'] ?? null
                ];
            }

            $result = $criminalInfo->addCriminalRecord(
                $data['name'] ?? '',
                $data['case_number'] ?? '',
                $fingerprints,
                $data['age'] ?? null,
                $data['sex'] ?? null
            );
            echo json_encode($result);
            break;

        case 'update':
            $user = $auth->requireRole(['admin', 'super_admin'], 'update_criminal_record', 'criminal');
            $contentType = $_SERVER['CONTENT_TYPE'] ?? '';
            if (stripos($contentType, 'multipart/form-data') !== false || stripos($contentType, 'application/x-www-form-urlencoded') !== false) {
                $data = $_POST;
            } else {
                $data = json_decode(file_get_contents('php://input'), true) ?? [];
            }

            $criminalId = intval($data['criminal_id'] ?? 0);
            if ($criminalId <= 0) {
                $auth->sendJson([
                    'success' => false,
                    'error' => 'Valid criminal_id is required.'
                ], 422);
            }

            $fingerprints = [];
            $fingerPosition = $data['finger_position'] ?? 'RIGHT_INDEX';
            $fingerprintPayload = $criminalInfo->prepareFingerprintPayloadFromRequest($data, 'fingerprint');
            if (empty($fingerprintPayload['success'])) {
                $auth->sendJson($fingerprintPayload, 422);
            }

            $template = $fingerprintPayload['template'] ?? '';
            if (!empty($template)) {
                $db = new FingerprintDB();
                $duplicate = $db->findCriminalFingerprintDuplicate($template, $fingerprintPayload['fingerprint_image'] ?? null, $criminalId, false);
                if (!empty($duplicate)) {
                    $auth->sendJson([
                        'success' => false,
                        'error' => 'Fingerprint already exists in another criminal profile. Upload a different fingerprint image/template.',
                        'code' => 'DUPLICATE_FINGERPRINT',
                        'duplicate' => $duplicate
                    ], 409);
                }

                $fingerprints[$fingerPosition] = [
                    'template' => $template,
                    'format' => $fingerprintPayload['template_format'] ?? ($data['template_format'] ?? 'ISO'),
                    'quality' => intval($fingerprintPayload['quality'] ?? ($data['quality'] ?? 90)),
                    'image' => $fingerprintPayload['fingerprint_image'] ?? null,
                    'filename' => $fingerprintPayload['fingerprint_filename'] ?? null
                ];
            }

            $result = $criminalInfo->updateCriminalRecord(
                $criminalId,
                $data['name'] ?? '',
                $data['case_number'] ?? '',
                $fingerprints,
                $data['age'] ?? null,
                $data['sex'] ?? null
            );

            if (empty($result['success'])) {
                $status = ($result['code'] ?? '') === 'NOT_FOUND' ? 404 : 422;
                $auth->sendJson($result, $status);
            }

            $auth->logAction(
                'save_criminal_record_update',
                'criminal',
                $criminalId,
                [
                    'requested_by' => $user['username'] ?? null,
                    'requested_role' => $user['role'] ?? null,
                    'criminal_name' => $result['criminal_name'] ?? ($data['name'] ?? null),
                    'case_number' => $result['case_number'] ?? ($data['case_number'] ?? null),
                    'fingerprints_stored' => intval($result['fingerprints_stored'] ?? 0),
                    'fingerprint_errors' => $result['fingerprint_errors'] ?? []
                ]
            );

            echo json_encode($result);
            break;

        case 'delete_fingerprint':
            $contentType = $_SERVER['CONTENT_TYPE'] ?? '';
            if (stripos($contentType, 'multipart/form-data') !== false || stripos($contentType, 'application/x-www-form-urlencoded') !== false) {
                $data = $_POST;
            } else {
                $data = json_decode(file_get_contents('php://input'), true) ?? [];
            }

            $fingerprintId = intval($data['fingerprint_id'] ?? 0);
            if ($fingerprintId <= 0) {
                $auth->sendJson([
                    'success' => false,
                    'error' => 'Valid fingerprint_id is required.'
                ], 422);
            }

            $user = $auth->requireRole(
                ['admin', 'super_admin'],
                'request_delete_criminal_fingerprint_template',
                'criminal_fingerprint',
                $fingerprintId
            );

            $reason = trim((string)($data['reason'] ?? ''));
            $result = $criminalInfo->deleteCriminalFingerprintTemplate($fingerprintId, $reason);
            if (empty($result['success'])) {
                $status = ($result['code'] ?? '') === 'NOT_FOUND' ? 404 : 422;
                $auth->sendJson($result, $status);
            }

            $auth->logAction(
                'delete_criminal_fingerprint_template',
                'criminal_fingerprint',
                $fingerprintId,
                [
                    'requested_by' => $user['username'] ?? null,
                    'requested_role' => $user['role'] ?? null,
                    'criminal_id' => $result['criminal_id'] ?? null,
                    'finger_position' => $result['finger_position'] ?? null,
                    'fingerprint_filename' => $result['fingerprint_filename'] ?? null,
                    'already_deleted' => !empty($result['already_deleted']),
                    'reason' => $reason !== '' ? $reason : null
                ]
            );

            echo json_encode($result);
            break;

        case 'delete_record':
            $contentType = $_SERVER['CONTENT_TYPE'] ?? '';
            if (stripos($contentType, 'multipart/form-data') !== false || stripos($contentType, 'application/x-www-form-urlencoded') !== false) {
                $data = $_POST;
            } else {
                $data = json_decode(file_get_contents('php://input'), true) ?? [];
            }

            $criminalId = intval($data['criminal_id'] ?? 0);
            if ($criminalId <= 0) {
                $auth->sendJson([
                    'success' => false,
                    'error' => 'Valid criminal_id is required.'
                ], 422);
            }

            $user = $auth->requireRole(
                ['admin', 'super_admin'],
                'request_delete_criminal_record',
                'criminal',
                $criminalId
            );

            $reason = trim((string)($data['reason'] ?? ''));
            $result = $criminalInfo->deleteCriminalRecord($criminalId, $reason);
            if (empty($result['success'])) {
                $status = ($result['code'] ?? '') === 'NOT_FOUND' ? 404 : 422;
                $auth->sendJson($result, $status);
            }

            $auth->logAction(
                'delete_criminal_record',
                'criminal',
                $criminalId,
                [
                    'requested_by' => $user['username'] ?? null,
                    'requested_role' => $user['role'] ?? null,
                    'criminal_name' => $result['criminal_name'] ?? null,
                    'already_deleted' => !empty($result['already_deleted']),
                    'reason' => $reason !== '' ? $reason : null
                ]
            );

            echo json_encode($result);
            break;
            
        case 'search':
            // Search for matching criminal fingerprints
            $auth->requireRole(['admin', 'super_admin'], 'search_criminal_biometrics', 'criminal');
            $data = json_decode(file_get_contents('php://input'), true);
            $result = $criminalInfo->searchCriminalDatabase(
                $data['template'] ?? '',
                $data['finger'] ?? 'index_right'
            );
            echo json_encode($result);
            break;
            
        case 'get':
            // Get criminal record by ID
            $user = $auth->requireRole(['admin', 'super_admin', 'officer'], 'view_criminal_record', 'criminal', $_GET['id'] ?? null);
            $criminalId = $_GET['id'] ?? 0;
            $result = $criminalInfo->getCriminalRecord($criminalId, $user['role']);
            echo json_encode($result);
            break;
            
        case 'status':
            // Get system status
            $auth->requireRole(['admin', 'super_admin'], 'view_criminal_matcher_status', 'system');
            $result = [
                'matcher_status' => $criminalInfo->getMatcherStatus(),
                'timestamp' => date('Y-m-d H:i:s')
            ];
            echo json_encode($result);
            break;
            
        default:
            echo json_encode(['error' => 'Unknown action: ' . $action]);
    }
} else if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $criminalInfo = new CriminalInfo();
    $action = $_GET['action'] ?? 'list';
    
    switch ($action) {
        case 'list':
            $auth->requireRole(['admin', 'super_admin', 'officer'], 'list_criminal_records', 'criminal');
            $result = ['criminals' => $criminalInfo->getAllCriminals()];
            echo json_encode($result);
            break;
            
        case 'status':
            $auth->requireRole(['admin', 'super_admin'], 'view_criminal_matcher_status', 'system');
            $result = $criminalInfo->getMatcherStatus();
            echo json_encode($result);
            break;

        case 'get':
            // Get criminal record by ID
            $user = $auth->requireRole(['admin', 'super_admin', 'officer'], 'view_criminal_record', 'criminal', $_GET['id'] ?? null);
            $criminalId = $_GET['id'] ?? 0;
            $result = $criminalInfo->getCriminalRecord($criminalId, $user['role']);
            echo json_encode($result);
            break;
            
        default:
            echo json_encode(['error' => 'Unknown action: ' . $action]);
    }
}
}
?>
