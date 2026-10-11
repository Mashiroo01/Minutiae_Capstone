<?php
/**
 * Criminal Records API with Bozorth3 Integration
 * Main handler for criminal fingerprint records and matching operations
 */

require_once 'Bozorth3Matcher.php';
require_once 'FingerprintDB.php';
require_once 'criminal_info.php';
require_once 'auth.php';

class CriminalRecord {
    
    private $db;
    private $matcher;
    private $criminalInfo;
    
    public function __construct($pdo = null) {
        $this->db = new FingerprintDB($pdo);
        $this->matcher = new Bozorth3Matcher();
        $this->criminalInfo = new CriminalInfo($pdo);
    }
    
    /**
     * Initialize the system with database tables
     */
    public function initialize() {
        return $this->db->initializeTables();
    }
    
    /**
     * Register a new criminal record with fingerprints
     */
    public function registerCriminal($name, $caseNumber, $fingerprints = []) {
        if (empty($name)) {
            return ['success' => false, 'error' => 'Name required'];
        }
        
        return $this->criminalInfo->addCriminalRecord($name, $caseNumber, $fingerprints);
    }
    
    /**
     * Get criminal record
     */
    public function getCriminal($criminalId, $viewerRole = 'admin') {
        return $this->criminalInfo->getCriminalRecord($criminalId, $viewerRole);
    }
    
    /**
     * Search criminal database
     */
    public function searchDatabase($probeTemplate, $finger = 'index_right') {
        return $this->criminalInfo->searchCriminalDatabase($probeTemplate, $finger);
    }
    
    /**
     * Get system status
     */
    public function getSystemStatus() {
        $bozorth3 = $this->matcher->getStatus();
        $database = $this->db->testConnection();
        $fingerprintService = (bool)($bozorth3['service_status']['connected'] ?? false);
        $scannerAvailable = (bool)($bozorth3['scanner_status']['available'] ?? false);
        $bozorth3Ready = (bool)($bozorth3['installed'] ?? false);
        $databaseConnected = (bool)($database['connected'] ?? false);
        $criticalServicesReady = $databaseConnected && $fingerprintService && $bozorth3Ready;

        return [
            'system_name' => 'Minutiae - Fingerprint Matching System',
            'version' => '1.0.0',
            'overall_status' => $criticalServicesReady && $scannerAvailable
                ? 'operational'
                : ($databaseConnected ? 'degraded' : 'offline'),
            'bozorth3_status' => $bozorth3,
            'database_status' => $database,
            'services' => [
                'web_api' => [
                    'ready' => true,
                    'label' => 'Web API',
                    'message' => 'Admin API is responding.'
                ],
                'database' => [
                    'ready' => $databaseConnected,
                    'label' => 'MariaDB',
                    'message' => $database['message'] ?? 'Database status unavailable.'
                ],
                'fingerprint_service' => [
                    'ready' => $fingerprintService,
                    'label' => 'Fingerprint Service',
                    'message' => $bozorth3['service_status']['message'] ?? 'Fingerprint service status unavailable.'
                ],
                'scanner' => [
                    'ready' => $scannerAvailable,
                    'label' => 'ZKTeco Scanner',
                    'message' => $scannerAvailable
                        ? 'ZKTeco ZK9500 is connected and ready.'
                        : 'ZKTeco ZK9500 is not available. Check USB, FPSensor driver, and SDK access.'
                ]
            ],
            'timestamp' => date('Y-m-d H:i:s')
        ];
    }
    
    /**
     * Get database statistics
     */
    public function getStatistics() {
        $criminals = $this->db->getCriminalRecords();
        $applicants = $this->db->getApplicants();
        return [
            'total_criminals' => count($criminals),
            'total_applicants' => count($applicants),
            'timestamp' => date('Y-m-d H:i:s')
        ];
    }
    
    /**
     * Set database connection
     */
    public function setConnection($pdo) {
        $this->db->setConnection($pdo);
        $this->criminalInfo->setConnection($pdo);
    }
}

// REST API Handler
header('Content-Type: application/json');
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

// Handle CORS preflight
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

$criminalRecord = new CriminalRecord();
$auth = new MinutiaeAuth();

try {
    if ($_SERVER['REQUEST_METHOD'] === 'POST') {
        $action = $_GET['action'] ?? 'register';
        $data = json_decode(file_get_contents('php://input'), true);
        
        switch ($action) {
            case 'init':
                // Initialize database
                $auth->requireRole(['super_admin'], 'initialize_system', 'system');
                $initialized = $criminalRecord->initialize();
                echo json_encode([
                    'success' => $initialized,
                    'message' => $initialized ? 'System initialized' : 'Initialization failed'
                ]);
                break;
                
            case 'register':
                // Register new criminal with fingerprints
                $auth->requireRole(['admin', 'super_admin'], 'register_criminal_record', 'criminal');
                $result = $criminalRecord->registerCriminal(
                    $data['name'] ?? '',
                    $data['case_number'] ?? '',
                    $data['fingerprints'] ?? []
                );
                echo json_encode($result);
                break;
                
            case 'search':
                // Search database for matches
                $auth->requireRole(['admin', 'super_admin'], 'search_criminal_biometrics', 'criminal');
                $result = $criminalRecord->searchDatabase(
                    $data['template'] ?? '',
                    $data['finger'] ?? 'index_right'
                );
                echo json_encode($result);
                break;
                
            default:
                http_response_code(400);
                echo json_encode(['error' => 'Unknown action: ' . $action]);
        }
        
    } else if ($_SERVER['REQUEST_METHOD'] === 'GET') {
        $action = $_GET['action'] ?? 'status';
        
        switch ($action) {
            case 'status':
                // Get system status
                $auth->requireRole(['admin', 'super_admin'], 'view_system_status', 'system');
                $result = $criminalRecord->getSystemStatus();
                echo json_encode($result);
                break;
                
            case 'stats':
                // Get database statistics
                $auth->requireRole(['admin', 'super_admin'], 'view_dashboard_stats', 'system');
                $result = $criminalRecord->getStatistics();
                echo json_encode($result);
                break;
                
            case 'get':
                // Get criminal record
                $user = $auth->requireRole(['admin', 'super_admin'], 'view_criminal_record', 'criminal', $_GET['id'] ?? null);
                $criminalId = $_GET['id'] ?? 0;
                $result = $criminalRecord->getCriminal($criminalId, $user['role']);
                echo json_encode($result);
                break;
                
            default:
                http_response_code(400);
                echo json_encode(['error' => 'Unknown action: ' . $action]);
        }
        
    } else {
        http_response_code(405);
        echo json_encode(['error' => 'Method not allowed']);
    }
    
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode([
        'success' => false,
        'error' => $e->getMessage(),
        'timestamp' => date('Y-m-d H:i:s')
    ]);
}
?>
