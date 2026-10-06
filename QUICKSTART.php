<?php
/**
 * QUICK START EXAMPLE
 * 
 * This file demonstrates how to use the Minutiae system
 * with the Bozorth3 fingerprint matching engine.
 */

require_once 'backend/Bozorth3Matcher.php';
require_once 'backend/FingerprintDB.php';
require_once 'backend/criminal_record.php';

// =====================================================
// EXAMPLE 1: Check System Status
// =====================================================

echo "=== System Status Check ===\n";

$criminalRecord = new CriminalRecord();
$status = $criminalRecord->getSystemStatus();

echo "System: " . $status['system_name'] . "\n";
echo "Bozorth3 Installed: " . ($status['bozorth3_status']['installed'] ? 'YES' : 'NO') . "\n";
echo "Database Connected: " . ($status['database_status']['connected'] ?? false ? 'YES' : 'NO') . "\n";

// =====================================================
// EXAMPLE 2: Initialize Database
// =====================================================

echo "\n=== Initializing Database ===\n";

// Create PDO connection (adjust credentials as needed)
try {
    $pdo = new PDO(
        'mysql:host=localhost',
        'root',
        '',
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
    );
    
    // Create database
    $pdo->exec("CREATE DATABASE IF NOT EXISTS minutiae");
    $pdo->exec("USE minutiae");
    
    echo "Database created/selected.\n";
    
    $criminalRecord->setConnection($pdo);
    $initialized = $criminalRecord->initialize();
    
    if ($initialized) {
        echo "Database tables initialized successfully.\n";
    }
    
} catch (PDOException $e) {
    echo "Database setup skipped: " . $e->getMessage() . "\n";
    echo "Note: Fingerprint operations (without DB) will still work.\n";
}

// =====================================================
// EXAMPLE 3: Check Bozorth3 Installation
// =====================================================

echo "\n=== Bozorth3 Installation Status ===\n";

$matcher = new Bozorth3Matcher();
$mathcerStatus = $matcher->getStatus();

echo "Path: " . $mathcerStatus['path'] . "\n";
echo "Installed: " . ($mathcerStatus['installed'] ? 'YES' : 'NO') . "\n";
echo "Message: " . $mathcerStatus['message'] . "\n";

if (!$mathcerStatus['installed']) {
    echo "\n*** INSTALLATION REQUIRED ***\n";
    echo "To use fingerprint matching, install NIST NBIS:\n";
    echo "1. Download from: https://www.nist.gov/services-resources/software/nist-biometric-image-software-nbis\n";
    echo "2. Extract and compile bozorth3\n";
    echo "3. Copy bozorth3.exe to the path above\n";
    echo "4. Update config.php with the correct path\n";
}

// =====================================================
// EXAMPLE 4: Register Criminal with Fingerprints (Simulated)
// =====================================================

echo "\n=== Example: Register Criminal ===\n";
echo "In production, you would:\n";
echo "1. Capture criminal fingerprints using a scanner\n";
echo "2. Extract minutiae templates (ISO format)\n";
echo "3. Submit via API:\n";
echo "\n";

$exampleCriminal = [
    'name' => 'John Doe',
    'case_number' => 'CASE-2024-001',
    'fingerprints' => [
        'index_right' => [
            'template' => 'binary_template_data_here',
            'format' => 'ISO',
            'quality' => 85
        ],
        'middle_right' => [
            'template' => 'binary_template_data_here',
            'format' => 'ISO',
            'quality' => 80
        ]
    ]
];

echo json_encode($exampleCriminal, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n";

// =====================================================
// EXAMPLE 5: API Endpoints Reference
// =====================================================

echo "\n=== API Endpoints Reference ===\n\n";

$endpoints = [
    'System Status' => [
        'method' => 'GET',
        'endpoint' => '/backend/criminal_record.php?action=status',
        'description' => 'Get system and Bozorth3 status'
    ],
    'Initialize Database' => [
        'method' => 'POST',
        'endpoint' => '/backend/criminal_record.php?action=init',
        'description' => 'Create required database tables'
    ],
    'Register Criminal' => [
        'method' => 'POST',
        'endpoint' => '/backend/criminal_record.php?action=register',
        'description' => 'Register criminal with fingerprints'
    ],
    'Search Database' => [
        'method' => 'POST',
        'endpoint' => '/backend/criminal_record.php?action=search',
        'description' => 'Search for matching fingerprints'
    ],
    'Submit Applicant' => [
        'method' => 'POST',
        'endpoint' => '/backend/applicant_info.php?action=submit',
        'description' => 'Submit applicant fingerprints'
    ],
    'Background Check' => [
        'method' => 'POST',
        'endpoint' => '/backend/applicant_info.php?action=check',
        'description' => 'Perform background check'
    ],
    'Get Applicant Record' => [
        'method' => 'GET',
        'endpoint' => '/backend/applicant_info.php?action=get&id=<id>',
        'description' => 'Retrieve applicant details'
    ]
];

foreach ($endpoints as $name => $endpoint) {
    echo "[$name]\n";
    echo "  Method: {$endpoint['method']}\n";
    echo "  Endpoint: {$endpoint['endpoint']}\n";
    echo "  Description: {$endpoint['description']}\n\n";
}

// =====================================================
// EXAMPLE 6: Match Score Interpretation
// =====================================================

echo "=== Understanding Match Scores ===\n\n";

$scoreGuide = [
    ['score' => '≥ 40', 'level' => 'CRITICAL MATCH', 'action' => 'REJECT', 'confidence' => 'Very High'],
    ['score' => '30-39', 'level' => 'WARNING', 'action' => 'REVIEW', 'confidence' => 'Medium-High'],
    ['score' => '20-29', 'level' => 'LOW CONFIDENCE', 'action' => 'ACCEPT', 'confidence' => 'Low'],
    ['score' => '< 20', 'level' => 'NO MATCH', 'action' => 'APPROVE', 'confidence' => 'None']
];

printf("%-8s %-18s %-10s %-15s\n", "Score", "Level", "Action", "Confidence");
echo str_repeat("-", 51) . "\n";

foreach ($scoreGuide as $guide) {
    printf("%-8s %-18s %-10s %-15s\n", 
        $guide['score'], 
        $guide['level'], 
        $guide['action'],
        $guide['confidence']
    );
}

// =====================================================
// EXAMPLE 7: Configuration Summary
// =====================================================

echo "\n=== System Configuration ===\n\n";

$config = require 'backend/config.php';

echo "System Name: " . $config['system']['name'] . "\n";
echo "Version: " . $config['system']['version'] . "\n";
echo "Bozorth3 Path: " . $config['bozorth3']['path'] . "\n";
echo "Match Threshold: " . $config['bozorth3']['match_threshold'] . "\n";
echo "Template Format: " . $config['bozorth3']['template_format'] . "\n";
echo "Database Type: " . $config['database']['type'] . "\n";
echo "Database Host: " . $config['database']['host'] . "\n";

// =====================================================
// EXAMPLE 8: Next Steps
// =====================================================

echo "\n=== Next Steps ===\n\n";

echo "1. INSTALL BOZORTH3\n";
echo "   - Download NIST NBIS from official source\n";
echo "   - Compile or extract bozorth3 executable\n";
echo "   - Update path in config.php\n\n";

echo "2. CONFIGURE DATABASE\n";
echo "   - Ensure MySQL is running\n";
echo "   - Create database and initialize tables\n";
echo "   - Update credentials in config.php\n\n";

echo "3. INTEGRATE FINGERPRINT SCANNER\n";
echo "   - Use your scanner's SDK to capture prints\n";
echo "   - Extract ISO/ICS format templates\n";
echo "   - Submit via API endpoints\n\n";

echo "4. TEST THE SYSTEM\n";
echo "   - Start with known test fingerprints\n";
echo "   - Verify match scores are accurate\n";
echo "   - Adjust threshold if needed\n\n";

echo "5. DEPLOY TO PRODUCTION\n";
echo "   - Enable HTTPS\n";
echo "   - Implement authentication\n";
echo "   - Set up logging and monitoring\n";
echo "   - Regular backups\n\n";

echo "=== Setup Complete ===\n";
echo "For full documentation, see README.md\n";
?>
