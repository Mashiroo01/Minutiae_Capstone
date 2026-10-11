<?php
/**
 * Applicant Fingerprint Management and Verification
 * Handles applicant fingerprint submission and background check matching
 */

require_once 'Bozorth3Matcher.php';
require_once 'FingerprintDB.php';
require_once 'auth.php';

class ApplicantInfo {
    
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
    
    /**
     * Submit fingerprints for a new applicant
     */
    public function submitApplicant($name, $email, $fingerprints = [], $privacyConsent = []) {
        if (empty($name)) {
            return [
                'success' => false,
                'error' => 'Name is required'
            ];
        }
        
        try {
            $age = isset($fingerprints['_meta']['age']) ? intval($fingerprints['_meta']['age']) : 0;
            $sex = isset($fingerprints['_meta']['sex']) ? $fingerprints['_meta']['sex'] : 'U';
            $reg = $this->db->registerApplicant($name, $age, $sex, $email, $privacyConsent);
            if (empty($reg['success'])) {
                return $reg;
            }
            $applicantId = intval($reg['applicant_id']);

            $result = [
                'success' => true,
                'applicant_name' => $name,
                'applicant_email' => $email,
                'fingerprints_submitted' => 0,
                'fingerprints' => [],
                'applicant_id' => $applicantId
            ];
            
            // Store each fingerprint
            foreach ($fingerprints as $finger => $data) {
                if ($finger === '_meta') {
                    continue;
                }
                if (isset($data['template'])) {
                    $storeResult = $this->db->storeApplicantFingerprint(
                        $applicantId,
                        $finger,
                        $data['template'],
                        isset($data['format']) ? $data['format'] : 'ISO',
                        isset($data['quality']) ? $data['quality'] : 0,
                        isset($data['image']) ? $data['image'] : null
                    );
                    
                    if ($storeResult['success']) {
                        $result['fingerprints_submitted']++;
                        $result['fingerprints'][] = [
                            'finger' => $finger,
                            'status' => 'submitted',
                            'quality' => isset($data['quality']) ? $data['quality'] : 0
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
     * Check for demographic match (HIT) - First step of two-step verification
     * Searches for criminals with same name, age, and sex
     */
    public function checkDemographicMatch($name, $age, $sex) {
        $demographicMatch = $this->db->searchCriminalByDemographics($name, $age, $sex);
        
        return [
            'success' => $demographicMatch['success'],
            'demographic_hits' => $demographicMatch['hits'],
            'hit_count' => $demographicMatch['hit_count'] ?? 0,
            'has_match' => ($demographicMatch['hit_count'] ?? 0) > 0
        ];
    }

    public function createApplicantScreeningRecord($name, $age, $sex, $email = null, $privacyConsent = []) {
        $registered = $this->db->registerApplicant($name, $age, $sex, $email, $privacyConsent);
        if (empty($registered['success'])) {
            return $registered;
        }

        $applicantId = intval($registered['applicant_id']);
        $demographic = $this->checkDemographicMatch($name, $age, $sex);
        $nextStatus = !empty($demographic['has_match']) ? 'PENDING_FINGERPRINT' : 'APPROVED';
        $this->db->updateApplicantStatus($applicantId, $nextStatus);
        $this->db->updateApplicantFingerprintStatus(
            $applicantId,
            !empty($demographic['has_match']) ? 'REQUIRED' : 'NOT_REQUIRED',
            !empty($demographic['has_match'])
                ? 'Demographic hit detected. Fingerprint verification required.'
                : 'No demographic hit detected. Fingerprint verification not required.'
        );

        return [
            'success' => true,
            'applicant_id' => $applicantId,
            'demographic_hit' => !empty($demographic['has_match']),
            'has_match' => !empty($demographic['has_match']),
            'hit_count' => intval($demographic['hit_count'] ?? 0),
            'clearance_status' => $nextStatus
        ];
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
            return trim($parts[1] ?? '');
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

        if (strncmp($value, "BM", 2) === 0) {
            return true;
        }

        if (strncmp($value, "II*\x00", 4) === 0 || strncmp($value, "MM\x00*", 4) === 0) {
            return true;
        }

        return false;
    }

    private function imageBase64FromTemplateBlob($templateBlob) {
        if (!$this->looksLikeImageBinary($templateBlob)) {
            return '';
        }

        return base64_encode($templateBlob);
    }

    private function buildAfisProfileFromImage($imageBase64) {
        $imageBase64 = $this->normalizeFingerprintImage($imageBase64);
        if ($imageBase64 === '') {
            return ['success' => false, 'error' => 'Missing image'];
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
            $result = ['success' => false, 'error' => 'AFIS image conversion unavailable'];
            $this->afisProfileCache[$cacheKey] = $result;
            return $result;
        }

        $decoded = json_decode($response, true);
        if (empty($decoded['success']) || empty($decoded['templateBase64'])) {
            $result = [
                'success' => false,
                'error' => is_array($decoded) ? ($decoded['error'] ?? 'AFIS image conversion failed') : 'AFIS image conversion failed'
            ];
            $this->afisProfileCache[$cacheKey] = $result;
            return $result;
        }

        $templateBinary = base64_decode((string)$decoded['templateBase64'], true);
        if ($templateBinary === false) {
            $result = ['success' => false, 'error' => 'Invalid AFIS template response'];
            $this->afisProfileCache[$cacheKey] = $result;
            return $result;
        }

        $result = [
            'success' => true,
            'template_binary' => $templateBinary,
            'image_base64' => $this->normalizeFingerprintImage($decoded['image'] ?? $imageBase64)
        ];
        $this->afisProfileCache[$cacheKey] = $result;
        return $result;
    }

    private function compareFingerprintImagesViaAfis($probeImage, $candidateImage, $threshold = null, $requireBozorth3 = false, $probeInfo = [], $referenceInfo = []) {
        $probeImage = $this->normalizeFingerprintImage($probeImage);
        $candidateImage = $this->normalizeFingerprintImage($candidateImage);

        if ($probeImage === '' || $candidateImage === '') {
            return ['success' => false, 'error' => 'Missing fingerprint image'];
        }

        $payload = [
            'probeImage' => $probeImage,
            'referenceImage' => $candidateImage,
            'probeInfo' => is_array($probeInfo) ? $probeInfo : [],
            'referenceInfo' => is_array($referenceInfo) ? $referenceInfo : []
        ];
        $context = stream_context_create([
            'http' => [
                'method' => 'POST',
                'header' => "Content-Type: application/json\r\n",
                'content' => json_encode($payload),
                'timeout' => 12,
                'ignore_errors' => true
            ]
        ]);

        $response = @file_get_contents($this->afisBaseUrl . '/afis/compare-all', false, $context);
        if ($response === false) {
            return ['success' => false, 'error' => 'Academic comparison service unavailable'];
        }

        $decoded = json_decode($response, true);
        if (empty($decoded['success'])) {
            return [
                'success' => false,
                'error' => is_array($decoded) ? ($decoded['error'] ?? 'Academic comparison failed') : 'Academic comparison failed'
            ];
        }

        $primaryMatcher = null;
        foreach (($decoded['matchers'] ?? []) as $matcherResult) {
            if (in_array(($matcherResult['algorithm'] ?? ''), ['Modified Bozorth3', 'Bozorth3'], true)) {
                $primaryMatcher = $matcherResult;
                break;
            }
        }

        if (!is_array($primaryMatcher) || ($requireBozorth3 && ($primaryMatcher['status'] ?? '') !== 'ok')) {
            return [
                'success' => false,
                'error' => $primaryMatcher['error'] ?? 'Modified Bozorth3 did not return an available primary result.',
                'comparison_result' => $decoded
            ];
        }

        $rawScore = is_numeric($primaryMatcher['rawScore'] ?? null)
            ? floatval($primaryMatcher['rawScore'])
            : (is_numeric($primaryMatcher['score'] ?? null) ? floatval($primaryMatcher['score']) : null);
        $matchPercentage = is_numeric($primaryMatcher['normalizedMatchPercentage'] ?? null)
            ? floatval($primaryMatcher['normalizedMatchPercentage'])
            : null;
        $legacyScore = $matchPercentage !== null ? $matchPercentage : $rawScore;

        return [
            'success' => true,
            'score' => $legacyScore,
            'raw_score' => $rawScore,
            'match_percentage' => $matchPercentage,
            'match' => strtoupper((string)($primaryMatcher['result'] ?? '')) === 'MATCH',
            'source' => 'academic_compare_all',
            'algorithm' => 'Modified Bozorth3',
            'threshold' => is_numeric($primaryMatcher['threshold'] ?? null) ? floatval($primaryMatcher['threshold']) : null,
            'final_result' => $decoded['finalResult']['decision'] ?? null,
            'requires_manual_review' => ($decoded['finalResult']['decision'] ?? 'REVIEW REQUIRED') === 'REVIEW REQUIRED',
            'comparison_result' => $decoded
        ];
    }

    public function matchProbeToCriminalFingerprint($probeTemplate, $probeImage, $criminalFingerprint, $format = 'ISO', $threshold = null, $strictAfisBozorth = false, $probeInfo = []) {
        $storedTemplate = (string)($criminalFingerprint['template'] ?? '');
        $probeTemplate = (string)$probeTemplate;
        $strictMode = !empty($strictAfisBozorth);

        if (!$strictMode && $probeTemplate !== '' && $storedTemplate !== '' && hash_equals($storedTemplate, $probeTemplate)) {
            return [
                'success' => true,
                'score' => 100,
                'match' => true,
                'source' => 'template_exact'
            ];
        }

        $candidateImage = $criminalFingerprint['fingerprint_image'] ?? '';
        $normalizedProbeImage = $this->normalizeFingerprintImage($probeImage);
        $normalizedCandidateImage = $this->normalizeFingerprintImage($candidateImage);

        if ($normalizedProbeImage === '' && $probeTemplate !== '') {
            $normalizedProbeImage = $this->imageBase64FromTemplateBlob($probeTemplate);
        }

        if ($normalizedCandidateImage === '' && $storedTemplate !== '') {
            $normalizedCandidateImage = $this->imageBase64FromTemplateBlob($storedTemplate);
        }

        if ($normalizedProbeImage !== '' && $this->looksLikeImageBinary($probeTemplate)) {
            $probeProfile = $this->buildAfisProfileFromImage($normalizedProbeImage);
            if (!empty($probeProfile['success']) && !empty($probeProfile['template_binary'])) {
                $probeTemplate = $probeProfile['template_binary'];
                $normalizedProbeImage = $probeProfile['image_base64'] ?? $normalizedProbeImage;
            }
        }

        if ($normalizedCandidateImage !== '' && $this->looksLikeImageBinary($storedTemplate)) {
            $candidateProfile = $this->buildAfisProfileFromImage($normalizedCandidateImage);
            if (!empty($candidateProfile['success']) && !empty($candidateProfile['template_binary'])) {
                $storedTemplate = $candidateProfile['template_binary'];
                $normalizedCandidateImage = $candidateProfile['image_base64'] ?? $normalizedCandidateImage;
            }
        }

        if (!$strictMode && $probeTemplate !== '' && $storedTemplate !== '' && hash_equals($storedTemplate, $probeTemplate)) {
            return [
                'success' => true,
                'score' => 100,
                'match' => true,
                'source' => 'template_exact_after_afis'
            ];
        }

        if (!$strictMode && $normalizedProbeImage !== '' && $normalizedCandidateImage !== '' && hash_equals($normalizedCandidateImage, $normalizedProbeImage)) {
            return [
                'success' => true,
                'score' => 100,
                'match' => true,
                'source' => 'image_exact'
            ];
        }

        if ($strictMode) {
            if ($normalizedProbeImage === '' || $normalizedCandidateImage === '') {
                return [
                    'success' => false,
                    'error' => 'Strict AFIS comparison requires probe and candidate fingerprint images.'
                ];
            }

            return $this->compareFingerprintImagesViaAfis(
                $normalizedProbeImage,
                $normalizedCandidateImage,
                $threshold,
                true,
                $probeInfo,
                [
                    'fingerprintId' => isset($criminalFingerprint['id']) ? 'criminal-fingerprint-' . intval($criminalFingerprint['id']) : null,
                    'fingerPosition' => $criminalFingerprint['finger_position'] ?? 'UNSPECIFIED',
                    'fileName' => $criminalFingerprint['fingerprint_filename'] ?? null
                ]
            );
        }

        if ($normalizedProbeImage !== '' && $normalizedCandidateImage !== '') {
            $imageResult = $this->compareFingerprintImagesViaAfis(
                $normalizedProbeImage,
                $normalizedCandidateImage,
                $threshold,
                $strictAfisBozorth,
                $probeInfo,
                [
                    'fingerprintId' => isset($criminalFingerprint['id']) ? 'criminal-fingerprint-' . intval($criminalFingerprint['id']) : null,
                    'fingerPosition' => $criminalFingerprint['finger_position'] ?? 'UNSPECIFIED',
                    'fileName' => $criminalFingerprint['fingerprint_filename'] ?? null
                ]
            );
            if (!empty($imageResult['success'])) {
                return $imageResult;
            }
        }

        $templateResult = $this->matcher->matchTemplates(
            $probeTemplate,
            $storedTemplate,
            $criminalFingerprint['template_format'] ?? $format
        );

        if (empty($templateResult['success'])) {
            return ['success' => false, 'error' => $templateResult['error'] ?? 'Template compare failed'];
        }

        return [
            'success' => true,
            'score' => intval($templateResult['score'] ?? 0),
            'match' => !empty($templateResult['match']),
            'source' => 'template_compare'
        ];
    }
    
    /**
     * Perform police clearance background check - Two-step verification
     * Step 1: Check demographic match (name, age, sex) - HIT check
     * Step 2: If HIT found, perform fingerprint matching
     */
    public function performBackgroundCheck($applicantId, $name = null, $age = null, $sex = null) {
        // If demographics provided, do demographic check first (HIT check)
        if ($name !== null && $age !== null && $sex !== null) {
            $demographicCheck = $this->checkDemographicMatch($name, $age, $sex);
            
            if (!$demographicCheck['has_match']) {
                // No demographic match - clearance approved
                $this->db->updateApplicantStatus($applicantId, 'APPROVED');
                
                return [
                    'success' => true,
                    'applicant_id' => $applicantId,
                    'clearance_process' => 'STEP_1_DEMOGRAPHIC_CHECK',
                    'demographic_check' => $demographicCheck,
                    'has_demographic_hit' => false,
                    'overall_risk' => 'low',
                    'recommendation' => 'APPROVE',
                    'message' => 'No matching criminal records found. Clearance APPROVED.',
                    'checked_at' => date('Y-m-d H:i:s')
                ];
            }
            
            // Demographic HIT found - proceed to fingerprint matching
            $fingerprint_results = [];
            $critical_matches = [];
            
            foreach ($demographicCheck['demographic_hits'] as $criminalRecord) {
                $criminalId = $criminalRecord['id'];
                
                // Get applicant fingerprints
                $applicantFps = $this->db->getApplicantFingerprints($applicantId);
                
                if (empty($applicantFps)) {
                    return [
                        'success' => true,
                        'applicant_id' => $applicantId,
                        'clearance_process' => 'STEP_1_DEMOGRAPHIC_CHECK',
                        'demographic_check' => $demographicCheck,
                        'has_demographic_hit' => true,
                        'overall_risk' => 'high',
                        'recommendation' => 'REJECT',
                        'message' => 'Demographic match found but applicant has no fingerprints. Clearance REJECTED.',
                        'checked_at' => date('Y-m-d H:i:s')
                    ];
                }
                
                // Get criminal fingerprints
                $criminalFps = $this->db->getCriminalFingerprints($criminalId);
                
                // Match fingerprints
                foreach ($applicantFps as $appFp) {
                    foreach ($criminalFps as $crimFp) {
                        if ($appFp['finger_position'] === $crimFp['finger_position']) {
                            $matchResult = $this->matchProbeToCriminalFingerprint(
                                $appFp['template'],
                                $appFp['fingerprint_image'] ?? null,
                                $crimFp,
                                $crimFp['template_format'] ?? 'ISO',
                                $this->matcher->getMatchThreshold()
                            );
                            
                            if ($matchResult['success']) {
                                $match = [
                                    'criminal_id' => $criminalId,
                                    'criminal_name' => $criminalRecord['name'],
                                    'criminal_case' => $criminalRecord['case_number'] ?? 'N/A',
                                    'applicant_finger' => $appFp['finger_position'],
                                    'score' => $matchResult['score'],
                                    'is_match' => $matchResult['match'],
                                    'matched_at' => date('Y-m-d H:i:s')
                                ];
                                
                                $fingerprint_results[] = $match;
                                
                                // Record in database
                                $this->db->recordMatchResult(
                                    $applicantId,
                                    $criminalId,
                                    $appFp['finger_position'],
                                    $matchResult['score'],
                                    $matchResult['match']
                                );
                                
                                if ($matchResult['match']) {
                                    $critical_matches[] = $match;
                                }
                            }
                        }
                    }
                }
            }
            
            // Determine final recommendation
            $has_fingerprint_match = count($critical_matches) > 0;
            $overall_risk = $has_fingerprint_match ? 'high' : 'low';
            $recommendation = $has_fingerprint_match ? 'REJECT' : 'APPROVE';
            
            if ($has_fingerprint_match) {
                $this->db->updateApplicantStatus($applicantId, 'REJECTED');
            } else {
                $this->db->updateApplicantStatus($applicantId, 'APPROVED');
            }
            
            return [
                'success' => true,
                'applicant_id' => $applicantId,
                'clearance_process' => 'TWO_STEP_VERIFICATION',
                'step_1_demographic_check' => [
                    'has_hit' => true,
                    'hits_found' => count($demographicCheck['demographic_hits']),
                    'matching_criminals' => $demographicCheck['demographic_hits']
                ],
                'step_2_fingerprint_check' => [
                    'total_comparisons' => count($fingerprint_results),
                    'fingerprint_matches' => count($critical_matches),
                    'match_details' => $fingerprint_results
                ],
                'overall_risk' => $overall_risk,
                'recommendation' => $recommendation,
                'message' => $has_fingerprint_match 
                    ? 'FINGERPRINT MATCH DETECTED! Clearance REJECTED.'
                    : 'Demographic hit found but no fingerprint match. Clearance APPROVED.',
                'checked_at' => date('Y-m-d H:i:s')
            ];
        }
        
        // If no demographics provided, do old-style full fingerprint check
        $applicantFps = $this->db->getApplicantFingerprints($applicantId);
        
        if (empty($applicantFps)) {
            return [
                'success' => false,
                'error' => 'No fingerprints found for applicant',
                'applicant_id' => $applicantId
            ];
        }
        
        $criminalDb = $this->db->getCriminalFingerprints();
        
        if (empty($criminalDb)) {
            return [
                'success' => true,
                'applicant_id' => $applicantId,
                'message' => 'No criminal records to compare against',
                'match_results' => [],
                'overall_risk' => 'low'
            ];
        }
        
        $allMatches = [];
        $criticalMatches = [];
        
        // Check each applicant fingerprint against criminal database
        foreach ($applicantFps as $appFp) {
            $sameFinger = array_filter($criminalDb, function($cf) use ($appFp) {
                return $cf['finger_position'] === $appFp['finger_position'];
            });
            
            foreach ($sameFinger as $criminalFp) {
                $matchResult = $this->matchProbeToCriminalFingerprint(
                    $appFp['template'],
                    $appFp['fingerprint_image'] ?? null,
                    $criminalFp,
                    $criminalFp['template_format'] ?? 'ISO',
                    $this->matcher->getMatchThreshold(),
                    false
                );
                
                if ($matchResult['success']) {
                    $match = [
                        'applicant_finger' => $appFp['finger_position'],
                        'criminal_id' => $criminalFp['id'],
                        'score' => $matchResult['score'],
                        'is_match' => $matchResult['match'],
                        'matched_at' => date('Y-m-d H:i:s')
                    ];
                    
                    $allMatches[] = $match;
                    
                    $this->db->recordMatchResult(
                        $applicantId,
                        $criminalFp['id'],
                        $appFp['finger_position'],
                        $matchResult['score'],
                        $matchResult['match']
                    );
                    
                    if ($matchResult['match']) {
                        $criticalMatches[] = $match;
                    }
                }
            }
        }
        
        usort($allMatches, function($a, $b) {
            return $b['score'] - $a['score'];
        });
        
        $overallRisk = 'low';
        if (count($criticalMatches) > 0) {
            $overallRisk = 'high';
        } elseif (count($allMatches) > 0 && max(array_column($allMatches, 'score')) >= 30) {
            $overallRisk = 'medium';
        }
        
        return [
            'success' => true,
            'applicant_id' => $applicantId,
            'background_check_completed' => true,
            'total_comparisons' => count($allMatches),
            'positive_matches' => count($criticalMatches),
            'match_results' => $allMatches,
            'critical_matches' => $criticalMatches,
            'overall_risk' => $overallRisk,
            'recommendation' => $overallRisk === 'high' ? 'REJECT' : 'APPROVE',
            'checked_at' => date('Y-m-d H:i:s')
        ];
    }
    
    /**
     * Get applicant details
     */
    public function getApplicantRecord($applicantId, $viewerRole = 'admin') {
        $record = $this->db->getApplicantById($applicantId);
        if (!$record) {
            return [
                'success' => false,
                'error' => 'Applicant record not found.'
            ];
        }

        $isSuperAdmin = $viewerRole === 'super_admin';
        if (!$isSuperAdmin) {
            $record['email'] = null;
            $record['privacy_notice_version'] = null;
            $record['privacy_consent_at'] = null;
        }
        $fingerprints = $isSuperAdmin ? $this->db->getApplicantFingerprints($applicantId) : [];
        $matchHistory = $this->db->getMatchHistory($applicantId, $isSuperAdmin);
        $fingerprintNotifications = $isSuperAdmin
            ? array_values(array_filter($matchHistory, function ($match) {
                return strtoupper(trim((string)($match['notification_final_result'] ?? ''))) === 'MATCH'
                    && strtolower(trim((string)($match['notification_status'] ?? 'none'))) !== 'none'
                    && trim((string)($match['comparison_id'] ?? '')) !== '';
            }))
            : [];
        $reviewSummary = $this->db->getApplicantReviewSummary($applicantId);
        $updateLogs = $this->db->getApplicationUpdateLogs($applicantId, $viewerRole);

        return [
            'success' => true,
            'applicant_id' => $applicantId,
            'record' => $record,
            'fingerprints' => $fingerprints,
            'fingerprints_count' => intval($record['fingerprint_count'] ?? count($fingerprints)),
            'match_history' => $matchHistory,
            'matches_count' => count($matchHistory),
            'fingerprint_notifications' => $fingerprintNotifications,
            'fingerprint_notifications_count' => count($fingerprintNotifications),
            'update_logs' => $updateLogs,
            'update_logs_count' => count($updateLogs),
            'biometric_access' => $isSuperAdmin ? 'full' : 'restricted',
            'review_summary' => $reviewSummary,
            'review_actions' => [
                'can_review' => $isSuperAdmin,
                'requires_review' => intval($reviewSummary['pending_reviews'] ?? 0) > 0
            ]
        ];
    }

    public function reviewApplicantMatch($applicantId, $decision, $notes, $reviewedBy) {
        return $this->db->updateMatchReview($applicantId, $decision, $notes, $reviewedBy);
    }
    
    /**
     * Get all applicants
     */
    public function getAllApplicants() {
        return $this->db->getApplicants();
    }

    public function getApplicationHistory($filters = [], $viewerRole = 'admin') {
        return $this->db->getApplicationHistory($filters, $viewerRole);
    }

    public function getPendingMatchAlerts($limit = 10) {
        return $this->db->getPendingMatchAlerts($limit);
    }

    public function getComparisonHistory($limit = 50) {
        return $this->db->getComparisonHistory($limit);
    }

    public function getFingerprintMatchNotifications($state = 'active', $limit = 20) {
        return $this->db->getFingerprintMatchNotifications($state, $limit);
    }

    public function updateFingerprintMatchNotificationStatus($notificationId, $status) {
        return $this->db->updateFingerprintMatchNotificationStatus($notificationId, $status);
    }

    public function getComparisonResultByComparisonId($comparisonId) {
        return $this->db->getComparisonResultByComparisonId($comparisonId);
    }

    /**
     * Get applicant counters for dashboard.
     */
    public function getApplicantStats() {
        return $this->db->getApplicantStatusStats();
    }
    
    /**
     * Get Bozorth3 matcher status
     */
    public function getMatcherStatus() {
        return $this->matcher->getStatus();
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
    $action = $_GET['action'] ?? ($_SERVER['REQUEST_METHOD'] === 'GET' ? 'list' : 'submit');
    $applicantInfo = new ApplicantInfo();

    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        switch ($action) {
            case 'submit':
                $auth->requireRole(['admin', 'super_admin'], 'submit_applicant_record', 'applicant');
                $data = json_decode(file_get_contents('php://input'), true) ?? [];
                $auth->requirePrivacyConsent($data);

                $fingerprints = $data['fingerprints'] ?? [];
                $fingerprints['_meta'] = [
                    'age' => $data['age'] ?? 0,
                    'sex' => $data['sex'] ?? 'U'
                ];

                $result = $applicantInfo->submitApplicant(
                    $data['name'] ?? 'Unknown',
                    $data['email'] ?? '',
                    $fingerprints,
                    [
                        'accepted' => true,
                        'consented_at' => $data['consent_timestamp'] ?? date('Y-m-d H:i:s'),
                        'version' => $data['privacy_notice_version'] ?? $auth->getPrivacyNoticeVersion()
                    ]
                );
                echo json_encode($result);
                break;

            case 'check':
                $auth->requireRole(['admin', 'super_admin'], 'check_applicant_demographics', 'applicant');
                $data = json_decode(file_get_contents('php://input'), true) ?? [];
                $auth->requirePrivacyConsent($data);

                $result = $applicantInfo->createApplicantScreeningRecord(
                    $data['name'] ?? null,
                    $data['age'] ?? null,
                    $data['sex'] ?? null,
                    $data['email'] ?? null,
                    [
                        'accepted' => true,
                        'consented_at' => $data['consent_timestamp'] ?? date('Y-m-d H:i:s'),
                        'version' => $data['privacy_notice_version'] ?? $auth->getPrivacyNoticeVersion()
                    ]
                );

                if (empty($result['success'])) {
                    $auth->sendJson($result, 422);
                }

                echo json_encode([
                    'success' => true,
                    'applicant_id' => $result['applicant_id'],
                    'demographic_hit' => $result['demographic_hit'],
                    'has_match' => $result['has_match'],
                    'hit_count' => $result['hit_count'],
                    'clearance_status' => $result['clearance_status']
                ]);
                break;

            case 'match':
                $auth->requireRole(['admin', 'super_admin'], 'match_applicant_fingerprint', 'applicant');
                $contentType = $_SERVER['CONTENT_TYPE'] ?? '';
                if (stripos($contentType, 'multipart/form-data') !== false || stripos($contentType, 'application/x-www-form-urlencoded') !== false) {
                    $data = $_POST;
                } else {
                    $data = json_decode(file_get_contents('php://input'), true) ?? [];
                }

                $auth->requirePrivacyConsent($data);

                $applicantId = intval($data['applicant_id'] ?? 0);
                $format = $data['template_format'] ?? 'ISO';
                $probeImage = trim((string)($data['fingerprint_image'] ?? ''));
                $db = new FingerprintDB();

                $probeTemplate = '';
                if (!empty($_FILES['fingerprint_template']) && is_uploaded_file($_FILES['fingerprint_template']['tmp_name'])) {
                    $probeTemplate = file_get_contents($_FILES['fingerprint_template']['tmp_name']);
                    if ($probeImage === '' && !empty($_FILES['fingerprint_template']['type']) && stripos($_FILES['fingerprint_template']['type'], 'image/') === 0) {
                        $probeImage = base64_encode($probeTemplate);
                    }
                } elseif (!empty($data['fingerprint_data'])) {
                    $rawFingerprintData = trim((string)$data['fingerprint_data']);
                    if (stripos($rawFingerprintData, 'data:image/') === 0 && strpos($rawFingerprintData, ',') !== false) {
                        $parts = explode(',', $rawFingerprintData, 2);
                        $rawFingerprintData = trim((string)($parts[1] ?? ''));
                    }
                    $decoded = base64_decode($rawFingerprintData, true);
                    $probeTemplate = ($decoded !== false) ? $decoded : $data['fingerprint_data'];
                }

                if ($applicantId <= 0) {
                    $auth->sendJson([
                        'success' => false,
                        'error' => 'Applicant record is required before fingerprint matching.'
                    ], 422);
                }

                $applicantRecord = $db->getApplicantById($applicantId);
                if (empty($applicantRecord)) {
                    $auth->sendJson([
                        'success' => false,
                        'error' => 'Applicant record not found. Please run demographic screening again.'
                    ], 404);
                }

                $name = $applicantRecord['name'] ?? null;
                $age = $applicantRecord['age'] ?? null;
                $sex = $applicantRecord['sex'] ?? null;

                if ($name === null || $age === null || $sex === null) {
                    $auth->sendJson([
                        'success' => false,
                        'error' => 'Applicant demographic profile is incomplete. Please submit demographic screening again.'
                    ], 422);
                }

                $clearanceStatus = strtoupper((string)($applicantRecord['clearance_status'] ?? ''));
                $fingerprintStatus = strtoupper((string)($applicantRecord['fingerprint_verification_status'] ?? ''));
                $fingerprintAllowed = in_array($clearanceStatus, ['PENDING_FINGERPRINT', 'PENDING'], true)
                    || in_array($clearanceStatus, ['UNDER_REVIEW'], true)
                    || in_array($fingerprintStatus, ['REQUIRED', 'SUBMITTED', 'POTENTIAL_MATCH'], true);

                if (!$fingerprintAllowed) {
                    $auth->sendJson([
                        'success' => false,
                        'error' => 'Fingerprint matching is not available for this applicant state. Please start a new demographic screening.'
                    ], 409);
                }

                if (empty($probeTemplate)) {
                    $auth->sendJson([
                        'success' => false,
                        'error' => 'Missing applicant fingerprint template'
                    ], 422);
                }

                $matcher = new Bozorth3Matcher();
                $db->storeApplicantFingerprint($applicantId, 'UNSPECIFIED', $probeTemplate, $format, intval($data['quality'] ?? 90), $probeImage);
                $db->supersedePendingMatches($applicantId, 'Superseded by a new fingerprint verification attempt.');

                $demographic = $applicantInfo->checkDemographicMatch($name, $age, $sex);
                if (empty($demographic['has_match'])) {
                    $db->supersedePendingMatches($applicantId, 'Automatically cleared because demographic screening has no active hit.');
                    $db->updateApplicantStatus($applicantId, 'APPROVED');
                    $db->updateApplicantFingerprintStatus($applicantId, 'NOT_REQUIRED', 'Fingerprint verification skipped because no demographic hit remained.');
                    echo json_encode([
                        'success' => true,
                        'applicant_id' => $applicantId,
                        'is_match' => false,
                        'match_score' => 0,
                        'demographic_basis' => 'stored_applicant_record',
                        'clearance_status' => 'APPROVED',
                        'message' => 'No demographic hit. Applicant approved.'
                    ]);
                    break;
                }

                $demographicHitIds = array_values(array_unique(array_map(function ($hit) {
                    return intval($hit['id'] ?? 0);
                }, $demographic['demographic_hits'] ?? [])));
                $globalAssociations = $db->findCriminalFingerprintAssociations($probeTemplate, $probeImage, true);
                $activeAssociationIds = [];
                foreach ($globalAssociations as $assoc) {
                    if (!empty($assoc['active_association'])) {
                        $activeAssociationIds[] = intval($assoc['criminal_id'] ?? 0);
                    }
                }
                $activeAssociationIds = array_values(array_unique(array_filter($activeAssociationIds, function ($id) {
                    return intval($id) > 0;
                })));

                if (count($activeAssociationIds) > 1) {
                    $db->updateApplicantStatus($applicantId, 'UNDER_REVIEW');
                    $db->updateApplicantFingerprintStatus(
                        $applicantId,
                        'POTENTIAL_MATCH',
                        'Duplicate fingerprint ownership detected across multiple active criminal identities. Routed for integrity review.'
                    );

                    echo json_encode([
                        'success' => true,
                        'applicant_id' => $applicantId,
                        'is_match' => false,
                        'requires_manual_review' => true,
                        'identity_integrity_conflict' => true,
                        'comparison_pipeline' => 'shared academic compare-all pipeline',
                        'clearance_status' => 'UNDER_REVIEW',
                        'public_status_label' => 'Processing...',
                        'message' => 'Fingerprint ownership conflict detected. The application is under integrity review.'
                    ]);
                    break;
                }

                if (count($activeAssociationIds) === 1 && !in_array($activeAssociationIds[0], $demographicHitIds, true)) {
                    $db->supersedePendingMatches($applicantId, 'Probe fingerprint belongs to a different enrolled criminal identity than the demographic hit candidate.');
                    $db->updateApplicantStatus($applicantId, 'APPROVED');
                    $db->updateApplicantFingerprintStatus(
                        $applicantId,
                        'NO_MATCH',
                        'Fingerprint association mismatch detected: probe belongs to a different enrolled identity.'
                    );

                    echo json_encode([
                        'success' => true,
                        'applicant_id' => $applicantId,
                        'is_match' => false,
                        'match_score' => 0,
                        'raw_match_score' => 0,
                        'identity_association_mismatch' => true,
                        'matched_criminal_id' => intval($activeAssociationIds[0]),
                        'demographic_basis' => 'stored_applicant_record',
                        'comparison_pipeline' => 'shared academic compare-all pipeline',
                        'clearance_status' => 'APPROVED',
                        'message' => 'No fingerprint match found for the screened identity. The biometric template is linked to a different enrolled record.'
                    ]);
                    break;
                }

                $bestScore = 0;
                $bestPositiveScore = 0;
                $bestRawScore = null;
                $bestComparisonRank = null;
                $bestComparisonResult = null;
                $positiveMatches = 0;
                $reviewRequiredComparisons = 0;
                $successfulComparisons = 0;
                $createdNotifications = [];
                $persistenceErrors = [];
                $threshold = max(80, intval($matcher->getMatchThreshold()));
                $comparisonErrors = [];
                $integrityConflicts = [];
                foreach ($demographic['demographic_hits'] as $hit) {
                    $criminalId = $hit['id'];
                    $criminalFps = $db->getCriminalFingerprints($criminalId);
                    foreach ($criminalFps as $crimFp) {
                        $duplicateCriminalFp = $db->findCriminalFingerprintDuplicate(
                            (string)($crimFp['template'] ?? ''),
                            $crimFp['fingerprint_image'] ?? null,
                            intval($criminalId),
                            false
                        );
                        if (!empty($duplicateCriminalFp)) {
                            $integrityConflicts[] = [
                                'criminal_id' => intval($criminalId),
                                'finger_position' => $crimFp['finger_position'] ?? 'UNSPECIFIED'
                            ];
                            continue;
                        }

                        $matched = $applicantInfo->matchProbeToCriminalFingerprint(
                            $probeTemplate,
                            $probeImage,
                            $crimFp,
                            $crimFp['template_format'] ?? $format,
                            $threshold,
                            true,
                            [
                                'fingerprintId' => 'applicant-' . $applicantId,
                                'fingerPosition' => 'UNSPECIFIED',
                                'fileName' => 'dashboard-applicant-capture'
                            ]
                        );

                        if (empty($matched['success'])) {
                            $comparisonErrors[] = $matched['error'] ?? 'Fingerprint comparison failed';
                            continue;
                        }

                        $successfulComparisons++;
                        $score = intval($matched['score'] ?? 0);
                        $isPositive = !empty($matched['match']);
                        $requiresComparisonReview = !empty($matched['requires_manual_review']);
                        $comparisonResult = is_array($matched['comparison_result'] ?? null)
                            ? $matched['comparison_result']
                            : null;
                        $comparisonRank = is_numeric($matched['match_percentage'] ?? null)
                            ? floatval($matched['match_percentage'])
                            : (is_numeric($matched['raw_score'] ?? null) ? floatval($matched['raw_score']) : null);
                        $recordedComparison = $db->recordMatchResult(
                            $applicantId,
                            $criminalId,
                            $crimFp['finger_position'],
                            $score,
                            $isPositive,
                            ($isPositive || $requiresComparisonReview) ? 'PENDING_REVIEW' : 'CLEAR',
                            ($isPositive || $requiresComparisonReview) ? 'RESTRICTED' : 'STANDARD',
                            $comparisonResult
                        );
                        if (empty($recordedComparison['success'])) {
                            $persistenceErrors[] = $recordedComparison['error'] ?? 'Unknown comparison persistence error.';
                        }
                        if (is_array($recordedComparison['notification'] ?? null)) {
                            $createdNotifications[] = $recordedComparison['notification'];
                        }

                        if ($comparisonResult !== null && ($bestComparisonRank === null || ($comparisonRank !== null && $comparisonRank >= $bestComparisonRank))) {
                            $bestComparisonRank = $comparisonRank;
                            $bestComparisonResult = $comparisonResult;
                            $bestRawScore = is_numeric($matched['raw_score'] ?? null)
                                ? floatval($matched['raw_score'])
                                : null;
                        }

                        if ($score >= $bestScore) {
                            $bestScore = $score;
                        }
                        if ($isPositive) {
                            $positiveMatches++;
                            if ($score >= $bestPositiveScore) {
                                $bestPositiveScore = $score;
                            }
                        }
                        if ($requiresComparisonReview) {
                            $reviewRequiredComparisons++;
                        }
                    }
                }

                if (!empty($persistenceErrors)) {
                    $auth->sendJson([
                        'success' => false,
                        'error' => 'Fingerprint comparison completed but its result could not be persisted.',
                        'details' => $persistenceErrors[0]
                    ], 500);
                }

                if ($successfulComparisons === 0 && !empty($integrityConflicts) && empty($comparisonErrors)) {
                    $db->updateApplicantStatus($applicantId, 'UNDER_REVIEW');
                    $db->updateApplicantFingerprintStatus(
                        $applicantId,
                        'POTENTIAL_MATCH',
                        'Duplicate criminal biometric templates detected. Routed for manual super admin review.'
                    );
                    echo json_encode([
                        'success' => true,
                        'applicant_id' => $applicantId,
                        'is_match' => true,
                        'requires_manual_review' => true,
                        'comparison_pipeline' => 'shared academic compare-all pipeline',
                        'comparison_result' => $bestComparisonResult,
                        'clearance_status' => 'UNDER_REVIEW',
                        'public_status_label' => 'Processing...',
                        'message' => 'The biometric database reported duplicate criminal templates. The application is now under super admin review.'
                    ]);
                    break;
                }

                if ($successfulComparisons === 0 && !empty($comparisonErrors)) {
                    $auth->sendJson([
                        'success' => false,
                        'error' => 'AFIS minutiae extraction is available, but Modified Bozorth3 comparison is not ready.',
                        'details' => $comparisonErrors[0],
                        'comparison_pipeline' => 'shared academic compare-all pipeline'
                    ], 503);
                }

                $isMatch = $positiveMatches > 0;
                $bestNotification = null;
                $bestComparisonId = is_array($bestComparisonResult)
                    ? trim((string)($bestComparisonResult['comparisonId'] ?? ''))
                    : '';
                foreach ($createdNotifications as $createdNotification) {
                    if ($bestNotification === null || ($bestComparisonId !== '' && ($createdNotification['comparisonId'] ?? '') === $bestComparisonId)) {
                        $bestNotification = $createdNotification;
                    }
                    if ($bestComparisonId !== '' && ($createdNotification['comparisonId'] ?? '') === $bestComparisonId) {
                        break;
                    }
                }

                if ($isMatch) {
                    $db->updateApplicantStatus($applicantId, 'UNDER_REVIEW');
                    $db->updateApplicantFingerprintStatus($applicantId, 'POTENTIAL_MATCH', 'Potential fingerprint match detected and routed for manual review.');
                    echo json_encode([
                        'success' => true,
                        'applicant_id' => $applicantId,
                        'is_match' => true,
                        'match_score' => max(0, min(100, intval($bestPositiveScore))),
                        'raw_match_score' => $bestRawScore,
                        'best_score' => $bestScore,
                        'requires_manual_review' => true,
                        'demographic_basis' => 'stored_applicant_record',
                        'comparison_pipeline' => 'shared academic compare-all pipeline',
                        'comparison_result' => $bestComparisonResult,
                        'notification' => $bestNotification,
                        'notifications' => $createdNotifications,
                        'clearance_status' => 'UNDER_REVIEW',
                        'public_status_label' => 'Processing...',
                        'message' => 'A potential biometric match was detected. The application is now under review by an authorized super admin.'
                    ]);
                    break;
                }

                if ($reviewRequiredComparisons > 0) {
                    $db->updateApplicantStatus($applicantId, 'UNDER_REVIEW');
                    $db->updateApplicantFingerprintStatus($applicantId, 'POTENTIAL_MATCH', 'The primary matcher returned a review-required result.');
                    echo json_encode([
                        'success' => true,
                        'applicant_id' => $applicantId,
                        'is_match' => false,
                        'match_score' => $bestScore,
                        'raw_match_score' => $bestRawScore,
                        'best_score' => $bestScore,
                        'requires_manual_review' => true,
                        'demographic_basis' => 'stored_applicant_record',
                        'comparison_pipeline' => 'shared academic compare-all pipeline',
                        'comparison_result' => $bestComparisonResult,
                        'clearance_status' => 'UNDER_REVIEW',
                        'public_status_label' => 'Processing...',
                        'message' => 'The fingerprint comparison requires authorized human review before interpretation.'
                    ]);
                    break;
                }

                $db->supersedePendingMatches($applicantId, 'Automatically cleared after fingerprint verification returned no match.');
                $db->updateApplicantStatus($applicantId, 'APPROVED');
                $db->updateApplicantFingerprintStatus($applicantId, 'NO_MATCH', 'Fingerprint verification completed with no matching record.');
                echo json_encode([
                    'success' => true,
                    'applicant_id' => $applicantId,
                    'is_match' => false,
                    'match_score' => $bestScore,
                    'raw_match_score' => $bestRawScore,
                    'best_score' => $bestScore,
                    'threshold' => $threshold,
                    'demographic_basis' => 'stored_applicant_record',
                    'comparison_pipeline' => 'shared academic compare-all pipeline',
                    'comparison_result' => $bestComparisonResult,
                    'clearance_status' => 'APPROVED',
                    'message' => 'No fingerprint match found. Applicant approved.'
                ]);
                break;

            case 'get':
                $user = $auth->requireRole(['admin', 'super_admin'], 'view_applicant_record', 'applicant');
                $data = json_decode(file_get_contents('php://input'), true) ?? [];
                $applicantId = intval($data['applicant_id'] ?? 0);
                $result = $applicantInfo->getApplicantRecord($applicantId, $user['role']);
                echo json_encode($result);
                break;

            case 'review':
                $user = $auth->requireRole(['super_admin'], 'review_fingerprint_match', 'applicant');
                $data = json_decode(file_get_contents('php://input'), true) ?? [];
                $applicantId = intval($data['applicant_id'] ?? 0);
                $decision = $data['decision'] ?? '';
                $notes = trim((string)($data['notes'] ?? ''));
                $result = $applicantInfo->reviewApplicantMatch($applicantId, $decision, $notes, $user['id']);
                echo json_encode($result);
                break;

            case 'notification_status':
                $auth->requireRole(['admin', 'super_admin'], 'update_fingerprint_notification', 'applicant');
                $data = json_decode(file_get_contents('php://input'), true) ?? [];
                $result = $applicantInfo->updateFingerprintMatchNotificationStatus(
                    intval($data['notification_id'] ?? 0),
                    $data['status'] ?? ''
                );
                if (empty($result['success'])) {
                    $auth->sendJson($result, 422);
                }
                echo json_encode($result);
                break;

            default:
                $auth->sendJson(['error' => 'Unknown action: ' . $action], 400);
        }
    } else if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        switch ($action) {
            case 'list':
            case 'history':
                $user = $auth->requireRole(['admin', 'super_admin'], 'list_applicant_history', 'applicant');
                $filters = [
                    'search' => $_GET['search'] ?? '',
                    'status' => $_GET['status'] ?? '',
                    'fingerprint_status' => $_GET['fingerprint_status'] ?? '',
                    'date_from' => $_GET['date_from'] ?? '',
                    'date_to' => $_GET['date_to'] ?? ''
                ];
                echo json_encode([
                    'applicants' => $applicantInfo->getApplicationHistory($filters, $user['role']),
                    'filters' => $filters
                ]);
                break;

            case 'stats':
                $auth->requireRole(['admin', 'super_admin'], 'view_applicant_stats', 'applicant');
                echo json_encode($applicantInfo->getApplicantStats());
                break;

            case 'alerts':
                $auth->requireRole(['super_admin'], 'view_pending_match_alerts', 'applicant');
                $limit = intval($_GET['limit'] ?? 10);
                $alerts = $applicantInfo->getPendingMatchAlerts($limit);
                echo json_encode([
                    'alerts' => $alerts,
                    'count' => count($alerts),
                    'latest_match_at' => !empty($alerts) ? ($alerts[0]['latest_match_at'] ?? null) : null
                ]);
                break;

            case 'comparisons':
                $auth->requireRole(['admin', 'super_admin'], 'view_fingerprint_comparison_results', 'applicant');
                $limit = intval($_GET['limit'] ?? 50);
                $comparisons = $applicantInfo->getComparisonHistory($limit);
                echo json_encode([
                    'comparisons' => $comparisons,
                    'count' => count($comparisons),
                    'latest_comparison_id' => !empty($comparisons) ? ($comparisons[0]['comparison_id'] ?? null) : null,
                    'latest_matched_at' => !empty($comparisons) ? ($comparisons[0]['matched_at'] ?? null) : null
                ]);
                break;

            case 'notifications':
                $auth->requireRole(['admin', 'super_admin'], 'view_fingerprint_notifications', 'applicant');
                $state = $_GET['state'] ?? 'active';
                $limit = intval($_GET['limit'] ?? 20);
                $notifications = $applicantInfo->getFingerprintMatchNotifications($state, $limit);
                echo json_encode([
                    'notifications' => $notifications,
                    'count' => count($notifications),
                    'unread_count' => count(array_filter($notifications, function ($notification) {
                        return ($notification['status'] ?? '') === 'unread';
                    }))
                ]);
                break;

            case 'comparison':
                $auth->requireRole(['admin', 'super_admin'], 'view_fingerprint_comparison_result', 'applicant');
                $comparisonId = trim((string)($_GET['comparison_id'] ?? ''));
                if ($comparisonId === '') {
                    $auth->sendJson(['error' => 'Comparison ID is required.'], 422);
                }
                $comparison = $applicantInfo->getComparisonResultByComparisonId($comparisonId);
                if ($comparison === null) {
                    $auth->sendJson(['error' => 'Fingerprint comparison result not found.'], 404);
                }
                echo json_encode(['comparison' => $comparison]);
                break;

            case 'status':
                $auth->requireRole(['admin', 'super_admin'], 'view_matcher_status', 'system');
                echo json_encode($applicantInfo->getMatcherStatus());
                break;

            default:
                $auth->sendJson(['error' => 'Unknown action: ' . $action], 400);
        }
    }
}
?>
