<?php
/**
 * Bozorth3 Fingerprint Matching Engine
 * Wrapper for NIST Bozorth3 algorithm integration
 * 
 * Installation:
 * 1. Download NIST NBIS tools: https://www.nist.gov/services-resources/software/nist-biometric-image-software-nbis
 * 2. Extract and compile bozorth3 executable
 * 3. Set BOZORTH3_PATH below to the executable location
 */

class Bozorth3Matcher {
    
    // Path to bozorth3 executable - update this path after installation
    private $bozorth3Path = 'C:\\bozorth3\\bozorth3.exe';
    private $resolvedPath = null;
    private $cygwinBash = 'C:\\cygwin64\\bin\\bash.exe';
    private $afisBaseUrl = 'http://localhost:9000';
    private $statusFetcher = null;
    
    // Confidence threshold for match (0-100, where higher = stricter)
    private $matchThreshold = 80;
    
    // Temporary directory for template files
    private $tempDir = 'C:\\xampp\\htdocs\\Minutiae\\temp\\';
    
    /**
     * Initialize matcher
     */
    public function __construct($bozorth3Path = null, $statusFetcher = null, $afisBaseUrl = null) {
        $this->statusFetcher = $statusFetcher;
        $cfg = null;
        $configPath = __DIR__ . '/config.php';
        if (file_exists($configPath)) {
            $cfg = require $configPath;
        }

        if ($bozorth3Path) {
            $this->bozorth3Path = $bozorth3Path;
        } else {
            if (is_array($cfg)) {
                if (!empty($cfg['bozorth3']['path'])) {
                    $this->bozorth3Path = $cfg['bozorth3']['path'];
                }
                if (!empty($cfg['bozorth3']['cygwin_bash'])) {
                    $this->cygwinBash = $cfg['bozorth3']['cygwin_bash'];
                }
                if (isset($cfg['bozorth3']['match_threshold'])) {
                    $this->setMatchThreshold(intval($cfg['bozorth3']['match_threshold']));
                }
                if (!empty($cfg['bozorth3']['temp_dir'])) {
                    $this->tempDir = rtrim($cfg['bozorth3']['temp_dir'], "\\/") . DIRECTORY_SEPARATOR;
                }
            }
        }
        $configuredAfisUrl = is_array($cfg) ? ($cfg['services']['fingerprint_service_url'] ?? null) : null;
        $this->afisBaseUrl = rtrim((string)($afisBaseUrl ?: $configuredAfisUrl ?: 'http://localhost:9000'), '/');
        $envBash = getenv('CYGWIN_BASH');
        if (!empty($envBash)) {
            $this->cygwinBash = $envBash;
        }
        $envThreshold = getenv('BOZORTH3_MATCH_THRESHOLD');
        if ($envThreshold !== false && $envThreshold !== '') {
            $this->setMatchThreshold(intval($envThreshold));
        }
        $this->resolvedPath = $this->resolveBozorth3Path();
        
        // Create temp directory if it doesn't exist, and fall back to the OS temp
        // folder if the configured directory is blocked by Windows ACLs.
        if (!is_dir($this->tempDir)) {
            @mkdir($this->tempDir, 0755, true);
        }
        if (!is_dir($this->tempDir) || !is_writable($this->tempDir)) {
            $this->tempDir = rtrim(sys_get_temp_dir(), "\\/") . DIRECTORY_SEPARATOR . 'Minutiae' . DIRECTORY_SEPARATOR . 'work' . DIRECTORY_SEPARATOR;
            if (!is_dir($this->tempDir)) {
                @mkdir($this->tempDir, 0755, true);
            }
        }
    }
    
    /**
     * Check if Bozorth3 is available
     */
    public function isAvailable() {
        return !empty($this->resolvedPath);
    }
    
    /**
     * Get bozorth3 installation status
     */
    public function getStatus() {
        $serviceStatus = $this->getFingerprintServiceStatus();
        if ($serviceStatus !== null) {
            return $serviceStatus;
        }

        $available = $this->isAvailable();
        return [
            'installed' => $available,
            'ready' => $available,
            'path' => $this->resolvedPath ?: $this->bozorth3Path,
            'cygwin_bash' => $this->cygwinBash,
            'source' => 'php_runtime',
            'message' => $available
                ? 'Modified Bozorth3 is ready in the PHP runtime.'
                : 'The fingerprint service is offline, so its Modified Bozorth3 installation could not be verified.',
            'service_status' => [
                'connected' => false,
                'url' => $this->afisBaseUrl,
                'message' => 'Fingerprint service is unreachable.'
            ],
            'scanner_status' => [
                'available' => false,
                'provider' => 'unknown',
                'capture_command_configured' => false,
                'simulation_allowed' => false
            ],
            'matcher_status' => []
        ];
    }

    private function getFingerprintServiceStatus() {
        $url = $this->afisBaseUrl . '/debug/config';
        try {
            if (is_callable($this->statusFetcher)) {
                $raw = call_user_func($this->statusFetcher, $url);
            } else {
                $context = stream_context_create([
                    'http' => [
                        'method' => 'GET',
                        'timeout' => 2,
                        'ignore_errors' => true
                    ]
                ]);
                $raw = @file_get_contents($url, false, $context);
            }
        } catch (Throwable $e) {
            return null;
        }

        if (!is_string($raw) || trim($raw) === '') {
            return null;
        }
        $payload = json_decode($raw, true);
        $matcher = $payload['afis']['academicMatchers'] ?? null;
        if (!is_array($matcher) || !array_key_exists('bozorth3Ready', $matcher)) {
            return null;
        }

        $ready = (bool)$matcher['bozorth3Ready'];
        $scanner = is_array($payload['scanner'] ?? null) ? $payload['scanner'] : [];
        return [
            'installed' => $ready,
            'ready' => $ready,
            'path' => $matcher['bozorth3Path'] ?? $this->bozorth3Path,
            'cygwin_bash' => $matcher['cygwinBashPath'] ?? $this->cygwinBash,
            'source' => 'fingerprint_service',
            'message' => $ready
                ? 'Modified Bozorth3 is ready in the fingerprint service.'
                : 'Modified Bozorth3 is not available in the fingerprint service.',
            'service_status' => [
                'connected' => true,
                'url' => $this->afisBaseUrl,
                'message' => 'Fingerprint service is online.'
            ],
            'scanner_status' => [
                'available' => (bool)($scanner['available'] ?? false),
                'provider' => $scanner['provider'] ?? 'unknown',
                'capture_command_configured' => (bool)($scanner['captureCommandConfigured'] ?? false),
                'simulation_allowed' => (bool)($scanner['simulationAllowed'] ?? false)
            ],
            'matcher_status' => [
                'mindtct' => (bool)($matcher['mindtctReady'] ?? false),
                'sourceafis' => (bool)($matcher['sourceAfisReady'] ?? false),
                'openafis' => (bool)($matcher['openAfisReady'] ?? false),
                'mcc' => (bool)($matcher['mccReady'] ?? false),
                'jiang' => (bool)($matcher['jiangReady'] ?? false)
            ]
        ];
    }
    
    /**
     * Match two fingerprint templates
     * 
     * @param string $template1 Binary fingerprint template 1
     * @param string $template2 Binary fingerprint template 2
     * @param string $format Template format (ISO, ICS, FMR, etc.)
     * @return array Match result with score and decision
     */
    public function matchTemplates($template1, $template2, $format = 'ISO') {
        // Bozorth3 expects XYT minutiae text. If templates are binary/ISO-style blobs,
        // use deterministic fallback scoring to avoid false zero scores.
        if (!$this->isXytTemplate($template1) || !$this->isXytTemplate($template2)) {
            $score = $this->fallbackScore($template1, $template2);
            return [
                'success' => true,
                'algorithm' => 'fallback',
                'error' => 'Non-XYT template detected. Using fallback matcher.',
                'match' => $score >= $this->matchThreshold,
                'score' => $score
            ];
        }

        if (!$this->isAvailable()) {
            $score = $this->fallbackScore($template1, $template2);
            return [
                'success' => true,
                'algorithm' => 'fallback',
                'error' => 'Bozorth3 not installed. Using fallback matcher.',
                'match' => $score >= $this->matchThreshold,
                'score' => $score
            ];
        }
        
        try {
            // Create temporary files for templates
            $file1 = $this->tempDir . 'template_' . uniqid() . '.dat';
            $file2 = $this->tempDir . 'template_' . uniqid() . '.dat';
            
            file_put_contents($file1, $template1);
            file_put_contents($file2, $template2);
            
            // Execute bozorth3 (native Windows binary or Cygwin/Linux path through bash)
            if ($this->isLinuxStylePath($this->resolvedPath) && is_file($this->cygwinBash)) {
                $cygFile1 = $this->toCygwinPath($file1);
                $cygFile2 = $this->toCygwinPath($file2);
                $bashCommand = $this->resolvedPath . ' ' . $cygFile1 . ' ' . $cygFile2;
                $cmd = escapeshellarg($this->cygwinBash) . ' -lc ' . escapeshellarg($bashCommand) . ' 2>&1';
            } else {
                $cmd = "\"{$this->resolvedPath}\" \"$file1\" \"$file2\" 2>&1";
            }
            $output = shell_exec($cmd);
            
            // Parse output
            $result = $this->parseOutput($output);
            
            // Determine match
            $result['match'] = $result['score'] >= $this->matchThreshold;
            
            // Cleanup
            @unlink($file1);
            @unlink($file2);
            
            $result['success'] = true;
            $result['algorithm'] = 'bozorth3';
            return $result;
            
        } catch (Exception $e) {
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'match' => false,
                'score' => 0
            ];
        }
    }
    
    /**
     * Search a fingerprint against a database of templates
     * 
     * @param string $probeTemplate Fingerprint template to search
     * @param array $databaseTemplates Array of templates from database
     * @return array Best matches found
     */
    public function searchDatabase($probeTemplate, $databaseTemplates) {
        if (!$this->isAvailable()) {
            return [
                'success' => false,
                'error' => 'Bozorth3 not installed',
                'matches' => []
            ];
        }
        
        $matches = [];
        
        foreach ($databaseTemplates as $record) {
            $result = $this->matchTemplates(
                $probeTemplate,
                $record['template'],
                isset($record['format']) ? $record['format'] : 'ISO'
            );
            
            if ($result['success'] && $result['match']) {
                $matches[] = [
                    'record_id' => $record['id'],
                    'name' => $record['name'] ?? 'Unknown',
                    'score' => $result['score'],
                    'finger' => $record['finger'] ?? 'Unknown'
                ];
            }
        }
        
        // Sort by score descending
        usort($matches, function($a, $b) {
            return $b['score'] - $a['score'];
        });
        
        return [
            'success' => true,
            'matches' => $matches,
            'total_matches' => count($matches)
        ];
    }
    
    /**
     * Parse bozorth3 command output
     */
    private function parseOutput($output) {
        $score = 0;
        $lines = explode("\n", $output);
        
        foreach ($lines as $line) {
            // Bozorth3 typically outputs the score as a number
            if (is_numeric(trim($line))) {
                $score = intval(trim($line));
                break;
            }
        }
        
        return [
            'score' => $score,
            'raw_output' => $output
        ];
    }
    
    /**
     * Set match threshold
     */
    public function setMatchThreshold($threshold) {
        $this->matchThreshold = max(0, min(100, $threshold));
    }
    
    /**
     * Get match threshold
     */
    public function getMatchThreshold() {
        return $this->matchThreshold;
    }

    /**
     * Fallback similarity score when bozorth3 is unavailable.
     * Returns 0-100 based on byte-level equality ratio.
     */
    private function fallbackScore($template1, $template2) {
        if ($template1 === $template2) {
            return 100;
        }

        $len1 = strlen($template1);
        $len2 = strlen($template2);
        $minLen = min($len1, $len2);
        if ($minLen <= 0) {
            return 0;
        }

        $same = 0;
        for ($i = 0; $i < $minLen; $i++) {
            if ($template1[$i] === $template2[$i]) {
                $same++;
            }
        }

        $ratio = $same / max($len1, $len2);
        return (int)round($ratio * 100);
    }

    /**
     * Resolve available bozorth3 executable from explicit path, env var, and PATH.
     */
    private function resolveBozorth3Path() {
        $candidates = [];
        $envPath = getenv('BOZORTH3_PATH');
        if (!empty($envPath)) {
            $candidates[] = $envPath;
        }
        if (!empty($this->bozorth3Path)) {
            $candidates[] = $this->bozorth3Path;
        }

        foreach ($candidates as $candidate) {
            if (is_file($candidate)) {
                return $candidate;
            }
            // Accept Linux-style path if it is executable via Cygwin bash.
            if ($this->isLinuxStylePath($candidate) && is_file($this->cygwinBash)) {
                $checkCmd = escapeshellarg($this->cygwinBash) . ' -lc ' . escapeshellarg('test -x ' . $candidate . ' && echo OK') . ' 2>&1';
                $check = @shell_exec($checkCmd);
                if (stripos((string)$check, 'OK') !== false) {
                    return $candidate;
                }
            }
        }

        $whereOutput = @shell_exec('where bozorth3 2>NUL');
        if (!empty($whereOutput)) {
            $line = trim(explode("\n", trim($whereOutput))[0]);
            if (!empty($line) && is_file($line)) {
                return $line;
            }
        }

        return null;
    }

    private function isXytTemplate($template) {
        if (!is_string($template) || $template === '') {
            return false;
        }

        $sample = trim(substr($template, 0, 512));
        if ($sample === '') {
            return false;
        }

        $lines = preg_split('/\r\n|\r|\n/', $sample);
        $checked = 0;
        foreach ($lines as $line) {
            $line = trim($line);
            if ($line === '') {
                continue;
            }
            $checked++;
            if (!preg_match('/^\d+\s+\d+\s+\d+$/', $line)) {
                return false;
            }
            if ($checked >= 3) {
                return true;
            }
        }

        return false;
    }

    private function isLinuxStylePath($path) {
        return is_string($path) && strlen($path) > 1 && $path[0] === '/';
    }

    private function toCygwinPath($windowsPath) {
        $normalized = str_replace('\\', '/', $windowsPath);
        if (preg_match('/^([A-Za-z]):\/(.*)$/', $normalized, $m)) {
            return '/' . strtolower($m[1]) . '/' . $m[2];
        }
        return $normalized;
    }
    
    /**
     * Store fingerprint template in database
     * This is a helper function - actual storage depends on your DB setup
     */
    public static function storeTemplate($personId, $finger, $template, $format = 'ISO') {
        // This will be used by actual storage methods in other files
        return [
            'person_id' => $personId,
            'finger' => $finger,
            'template' => $template,
            'format' => $format,
            'stored_at' => date('Y-m-d H:i:s')
        ];
    }
}
?>
