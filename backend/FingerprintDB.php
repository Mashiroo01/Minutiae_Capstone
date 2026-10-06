<?php
/**
 * Fingerprint Database Handler
 * Manages storage and retrieval of fingerprint data
 */

class FingerprintDB {
    
    private $db;
    private $config;
    
    public function __construct($pdo = null) {
        $configPath = __DIR__ . '/config.php';
        $this->config = file_exists($configPath) ? require $configPath : [];
        $this->db = $pdo ?: $this->createDefaultConnection();
        if ($this->db) {
            $this->initializeTables();
        }
    }

    /**
     * Auto-create PDO from config.php when no connection is injected.
     */
    private function createDefaultConnection() {
        $configPath = __DIR__ . '/config.php';
        if (!file_exists($configPath)) {
            return null;
        }

        try {
            $config = require $configPath;
            if (!isset($config['database'])) {
                return null;
            }

            $db = $config['database'];
            $host = $db['host'] ?? 'localhost';
            $port = intval($db['port'] ?? 3306);
            $database = $db['database'] ?? 'minutiae';
            $charset = $db['charset'] ?? 'utf8mb4';
            $user = $db['user'] ?? 'root';
            $password = $db['password'] ?? '';

            $options = [
                PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC
            ];

            // Connect server-level first so DB can be created automatically.
            $serverDsn = sprintf('mysql:host=%s;port=%d;charset=%s', $host, $port, $charset);
            $pdo = new PDO($serverDsn, $user, $password, $options);
            $pdo->exec("CREATE DATABASE IF NOT EXISTS `" . str_replace('`', '', $database) . "` CHARACTER SET $charset");

            $dbDsn = sprintf('mysql:host=%s;port=%d;dbname=%s;charset=%s', $host, $port, $database, $charset);
            return new PDO($dbDsn, $user, $password, $options);
        } catch (Exception $e) {
            error_log('PDO auto-connect failed: ' . $e->getMessage());
            return null;
        }
    }
    
    /**
     * Initialize database tables if using PDO
     */
    public function initializeTables() {
        if (!$this->db) return false;
        
        try {
            $schema = $this->getManagedSchemaDefinitions();
            $this->ensureManagedSchema($schema);

            $this->addColumnIfMissing('applicants', 'privacy_consent_given', "TINYINT(1) NOT NULL DEFAULT 0");
            $this->addColumnIfMissing('applicants', 'privacy_consent_at', "TIMESTAMP NULL DEFAULT NULL");
            $this->addColumnIfMissing('applicants', 'privacy_notice_version', "VARCHAR(50) DEFAULT NULL");
            $this->addColumnIfMissing('applicants', 'fingerprint_verification_status', "VARCHAR(50) NOT NULL DEFAULT 'NOT_STARTED'");
            $this->addColumnIfMissing('applicants', 'last_updated_at', "TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP");
            $this->addColumnIfMissing('criminal_records', 'is_active', "TINYINT(1) NOT NULL DEFAULT 1");
            $this->addColumnIfMissing('criminal_records', 'deleted_at', "TIMESTAMP NULL DEFAULT NULL");
            $this->addColumnIfMissing('criminal_records', 'deletion_reason', "TEXT DEFAULT NULL");

            $this->addColumnIfMissing('fingerprint_matches', 'review_status', "VARCHAR(50) NOT NULL DEFAULT 'CLEAR'");
            $this->addColumnIfMissing('fingerprint_matches', 'review_outcome', "VARCHAR(50) DEFAULT NULL");
            $this->addColumnIfMissing('fingerprint_matches', 'review_notes', "TEXT DEFAULT NULL");
            $this->addColumnIfMissing('fingerprint_matches', 'reviewed_by', "INT NULL");
            $this->addColumnIfMissing('fingerprint_matches', 'reviewed_at', "TIMESTAMP NULL DEFAULT NULL");
            $this->addColumnIfMissing('fingerprint_matches', 'disclosure_level', "VARCHAR(20) NOT NULL DEFAULT 'RESTRICTED'");
            $this->addColumnIfMissing('criminal_fingerprints', 'fingerprint_image', "LONGTEXT DEFAULT NULL");
            $this->addColumnIfMissing('criminal_fingerprints', 'fingerprint_filename', "VARCHAR(255) DEFAULT NULL");
            $this->addColumnIfMissing('criminal_fingerprints', 'template_hash', "VARCHAR(64) DEFAULT NULL");
            $this->addColumnIfMissing('criminal_fingerprints', 'image_hash', "VARCHAR(64) DEFAULT NULL");
            $this->addColumnIfMissing('criminal_fingerprints', 'is_active', "TINYINT(1) NOT NULL DEFAULT 1");
            $this->addColumnIfMissing('criminal_fingerprints', 'superseded_by', "INT NULL");
            $this->addColumnIfMissing('criminal_fingerprints', 'deactivated_at', "TIMESTAMP NULL DEFAULT NULL");
            $this->addColumnIfMissing('criminal_fingerprints', 'deactivation_reason', "TEXT DEFAULT NULL");
            $this->addColumnIfMissing('applicant_fingerprints', 'fingerprint_image', "LONGTEXT DEFAULT NULL");
            $this->backfillCriminalActiveFlags();
            $this->backfillCriminalFingerprintHashes();

            $this->seedDefaultAdminUsers();
            
            return true;
        } catch (PDOException $e) {
            error_log("Database initialization error: " . $e->getMessage());
            return false;
        }
    }

    private function getManagedSchemaDefinitions() {
        return [
            'admin_users' => "
                CREATE TABLE IF NOT EXISTS admin_users (
                    id INT PRIMARY KEY AUTO_INCREMENT,
                    username VARCHAR(100) NOT NULL UNIQUE,
                    password_hash VARCHAR(255) NOT NULL,
                    role VARCHAR(50) NOT NULL DEFAULT 'admin',
                    full_name VARCHAR(255) DEFAULT NULL,
                    is_active TINYINT(1) NOT NULL DEFAULT 1,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_login TIMESTAMP NULL DEFAULT NULL
                )
            ",
            'criminal_records' => "
                CREATE TABLE IF NOT EXISTS criminal_records (
                    id INT PRIMARY KEY AUTO_INCREMENT,
                    name VARCHAR(255) NOT NULL,
                    age INT,
                    sex VARCHAR(10),
                    case_number VARCHAR(100),
                    is_active TINYINT(1) NOT NULL DEFAULT 1,
                    deleted_at TIMESTAMP NULL DEFAULT NULL,
                    deletion_reason TEXT DEFAULT NULL,
                    record_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_name (name),
                    INDEX idx_active (is_active),
                    INDEX idx_demographics (name, age, sex)
                )
            ",
            'applicants' => "
                CREATE TABLE IF NOT EXISTS applicants (
                    id INT PRIMARY KEY AUTO_INCREMENT,
                    name VARCHAR(255) NOT NULL,
                    age INT,
                    sex VARCHAR(10),
                    email VARCHAR(255),
                    clearance_status VARCHAR(50) DEFAULT 'PENDING',
                    fingerprint_verification_status VARCHAR(50) DEFAULT 'NOT_STARTED',
                    submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    last_updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                    INDEX idx_name (name),
                    INDEX idx_demographics (name, age, sex)
                )
            ",
            'audit_logs' => "
                CREATE TABLE IF NOT EXISTS audit_logs (
                    id INT PRIMARY KEY AUTO_INCREMENT,
                    user_id INT NULL,
                    username VARCHAR(100) DEFAULT NULL,
                    role VARCHAR(50) DEFAULT NULL,
                    action VARCHAR(120) NOT NULL,
                    target_type VARCHAR(120) DEFAULT NULL,
                    target_id VARCHAR(120) DEFAULT NULL,
                    details LONGTEXT DEFAULT NULL,
                    ip_address VARCHAR(64) DEFAULT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_action_created_at (action, created_at),
                    INDEX idx_user_created_at (user_id, created_at)
                )
            ",
            'application_update_logs' => "
                CREATE TABLE IF NOT EXISTS application_update_logs (
                    id INT PRIMARY KEY AUTO_INCREMENT,
                    applicant_id INT NOT NULL,
                    change_type VARCHAR(120) NOT NULL,
                    note TEXT DEFAULT NULL,
                    previous_status VARCHAR(50) DEFAULT NULL,
                    new_status VARCHAR(50) DEFAULT NULL,
                    previous_fingerprint_status VARCHAR(50) DEFAULT NULL,
                    new_fingerprint_status VARCHAR(50) DEFAULT NULL,
                    actor_user_id INT DEFAULT NULL,
                    actor_name VARCHAR(120) DEFAULT NULL,
                    actor_role VARCHAR(50) DEFAULT NULL,
                    metadata LONGTEXT DEFAULT NULL,
                    changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    INDEX idx_applicant_changed_at (applicant_id, changed_at),
                    FOREIGN KEY (applicant_id) REFERENCES applicants(id)
                )
            ",
            'criminal_fingerprints' => "
                CREATE TABLE IF NOT EXISTS criminal_fingerprints (
                    id INT PRIMARY KEY AUTO_INCREMENT,
                    criminal_id INT NOT NULL,
                    finger_position VARCHAR(50) NOT NULL,
                    template LONGBLOB NOT NULL,
                    template_format VARCHAR(20) DEFAULT 'ISO',
                    fingerprint_image LONGTEXT DEFAULT NULL,
                    fingerprint_filename VARCHAR(255) DEFAULT NULL,
                    template_hash VARCHAR(64) DEFAULT NULL,
                    image_hash VARCHAR(64) DEFAULT NULL,
                    is_active TINYINT(1) NOT NULL DEFAULT 1,
                    superseded_by INT NULL,
                    deactivated_at TIMESTAMP NULL DEFAULT NULL,
                    deactivation_reason TEXT DEFAULT NULL,
                    quality_score INT DEFAULT 0,
                    captured_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE KEY unique_finger (criminal_id, finger_position),
                    INDEX idx_template_hash (template_hash),
                    INDEX idx_image_hash (image_hash),
                    INDEX idx_criminal_active (criminal_id, is_active),
                    FOREIGN KEY (criminal_id) REFERENCES criminal_records(id)
                )
            ",
            'applicant_fingerprints' => "
                CREATE TABLE IF NOT EXISTS applicant_fingerprints (
                    id INT PRIMARY KEY AUTO_INCREMENT,
                    applicant_id INT NOT NULL,
                    finger_position VARCHAR(50) NOT NULL,
                    template LONGBLOB NOT NULL,
                    template_format VARCHAR(20) DEFAULT 'ISO',
                    fingerprint_image LONGTEXT DEFAULT NULL,
                    quality_score INT DEFAULT 0,
                    submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE KEY unique_finger (applicant_id, finger_position),
                    FOREIGN KEY (applicant_id) REFERENCES applicants(id)
                )
            ",
            'fingerprint_matches' => "
                CREATE TABLE IF NOT EXISTS fingerprint_matches (
                    id INT PRIMARY KEY AUTO_INCREMENT,
                    applicant_id INT,
                    criminal_id INT,
                    finger_matched VARCHAR(50),
                    match_score INT NOT NULL,
                    is_match BOOLEAN DEFAULT FALSE,
                    matched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (applicant_id) REFERENCES applicants(id),
                    FOREIGN KEY (criminal_id) REFERENCES criminal_records(id)
                )
            "
        ];
    }

    private function ensureManagedSchema($schema) {
        try {
            $this->createAndValidateManagedTables($schema);
        } catch (PDOException $e) {
            if (!$this->isRecoverableTableError($e)) {
                throw $e;
            }

            error_log('Managed schema recovery started: ' . $e->getMessage());
            $this->rebuildManagedSchema($schema);
            $this->createAndValidateManagedTables($schema);
        }
    }

    private function createAndValidateManagedTables($schema) {
        foreach ($schema as $tableName => $createSql) {
            $this->db->exec($createSql);
            $this->assertTableUsable($tableName);
        }
    }

    private function rebuildManagedSchema($schema) {
        $dropOrder = [
            'fingerprint_matches',
            'applicant_fingerprints',
            'criminal_fingerprints',
            'application_update_logs',
            'audit_logs',
            'admin_users',
            'applicants',
            'criminal_records'
        ];

        $this->db->exec('SET FOREIGN_KEY_CHECKS = 0');

        try {
            foreach ($dropOrder as $tableName) {
                $this->db->exec('DROP TABLE IF EXISTS ' . $this->quoteIdentifier($tableName));
            }

            foreach ($schema as $tableName => $createSql) {
                $this->db->exec($createSql);
                $this->assertTableUsable($tableName);
            }
        } finally {
            $this->db->exec('SET FOREIGN_KEY_CHECKS = 1');
        }
    }

    private function assertTableUsable($tableName) {
        $quotedTable = $this->quoteIdentifier($tableName);
        $this->db->query("SELECT 1 FROM {$quotedTable} LIMIT 1");
    }

    private function isRecoverableTableError(PDOException $exception) {
        $message = strtolower((string)$exception->getMessage());
        $code = strtoupper((string)$exception->getCode());

        if ($code === '42S02') {
            return true;
        }

        return strpos($message, "doesn't exist in engine") !== false
            || strpos($message, 'base table or view not found') !== false
            || strpos($message, 'tablespace for table') !== false
            || strpos($message, 'discard the tablespace before import') !== false
            || strpos($message, 'failed to open the referenced table') !== false
            || strpos($message, 'cannot add foreign key constraint') !== false
            || strpos($message, 'table') !== false && strpos($message, 'missing') !== false;
    }

    private function quoteIdentifier($identifier) {
        return '`' . str_replace('`', '``', (string)$identifier) . '`';
    }

    private function addColumnIfMissing($table, $column, $definition) {
        if ($this->columnExists($table, $column)) {
            return;
        }

        $this->db->exec(sprintf(
            "ALTER TABLE %s ADD COLUMN %s %s",
            $table,
            $column,
            $definition
        ));
    }

    private function columnExists($table, $column) {
        $stmt = $this->db->prepare("
            SELECT COUNT(*) AS total
            FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = ?
              AND COLUMN_NAME = ?
        ");
        $stmt->execute([$table, $column]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return intval($row['total'] ?? 0) > 0;
    }

    private function seedDefaultAdminUsers() {
        $accounts = $this->config['security']['admin_accounts'] ?? [];
        if (empty($accounts)) {
            return;
        }

        foreach ($accounts as $account) {
            $username = trim((string)($account['username'] ?? ''));
            $password = (string)($account['password'] ?? '');
            if ($username === '' || $password === '') {
                continue;
            }

            $existing = $this->getAdminUserByUsername($username);
            if ($existing) {
                continue;
            }

            $stmt = $this->db->prepare("
                INSERT INTO admin_users (username, password_hash, role, full_name, is_active)
                VALUES (?, ?, ?, ?, 1)
            ");
            $stmt->execute([
                $username,
                password_hash($password, PASSWORD_DEFAULT),
                $account['role'] ?? 'admin',
                $account['full_name'] ?? null
            ]);
        }
    }

    private function normalizeFingerprintImageValue($value) {
        if (!is_string($value)) {
            return null;
        }

        $value = trim($value);
        if ($value === '') {
            return null;
        }

        if (stripos($value, 'data:image/') === 0 && strpos($value, ',') !== false) {
            $parts = explode(',', $value, 2);
            $value = trim((string)($parts[1] ?? ''));
        }

        return $value === '' ? null : $value;
    }

    private function normalizeFingerprintFilename($value) {
        if (!is_string($value)) {
            return null;
        }

        $value = trim($value);
        if ($value === '') {
            return null;
        }

        $value = str_replace("\0", '', $value);
        $value = str_replace('\\', '/', $value);
        $parts = explode('/', $value);
        $filename = trim((string)end($parts));
        if ($filename === '') {
            return null;
        }

        return substr($filename, 0, 255);
    }

    private function hashFingerprintTemplate($template) {
        if (!is_string($template) || $template === '') {
            return null;
        }

        return hash('sha256', $template);
    }

    private function hashFingerprintImage($imageValue) {
        $normalized = $this->normalizeFingerprintImageValue($imageValue);
        if ($normalized === null) {
            return null;
        }

        return hash('sha256', $normalized);
    }

    private function backfillCriminalActiveFlags() {
        if (!$this->db) {
            return;
        }

        try {
            $this->db->exec("
                UPDATE criminal_records
                SET is_active = 1
                WHERE (is_active IS NULL OR is_active = 0)
                  AND deleted_at IS NULL
            ");
            $this->db->exec("
                UPDATE criminal_fingerprints
                SET is_active = 1
                WHERE (is_active IS NULL OR is_active = 0)
                  AND deactivated_at IS NULL
            ");
        } catch (PDOException $e) {
            error_log('Criminal active-flag backfill failed: ' . $e->getMessage());
        }
    }

    private function backfillCriminalFingerprintHashes() {
        if (!$this->db) {
            return;
        }

        try {
            $rows = $this->db->query("
                SELECT id, template, fingerprint_image, template_hash, image_hash
                FROM criminal_fingerprints
            ")->fetchAll(PDO::FETCH_ASSOC);

            $updateStmt = $this->db->prepare("
                UPDATE criminal_fingerprints
                SET template_hash = ?, image_hash = ?
                WHERE id = ?
            ");

            foreach ($rows as $row) {
                $currentTemplateHash = trim((string)($row['template_hash'] ?? ''));
                $currentImageHash = trim((string)($row['image_hash'] ?? ''));
                if ($currentTemplateHash !== '' && ($currentImageHash !== '' || $row['fingerprint_image'] === null || trim((string)$row['fingerprint_image']) === '')) {
                    continue;
                }

                $templateHash = $this->hashFingerprintTemplate((string)($row['template'] ?? ''));
                $imageHash = $this->hashFingerprintImage($row['fingerprint_image'] ?? null);
                $updateStmt->execute([$templateHash, $imageHash, intval($row['id'])]);
            }
        } catch (PDOException $e) {
            error_log("Criminal fingerprint hash backfill failed: " . $e->getMessage());
        }
    }

    public function findCriminalFingerprintDuplicate($template, $fingerprintImage = null, $excludeCriminalId = null, $includeInactive = false) {
        if (!$this->db || !is_string($template) || $template === '') {
            return null;
        }

        $templateHash = $this->hashFingerprintTemplate($template);
        $imageHash = $this->hashFingerprintImage($fingerprintImage);

        try {
            $signatureConditions = ["cf.template_hash = ?"];
            $params = [$templateHash];
            if ($imageHash !== null) {
                $signatureConditions[] = "cf.image_hash = ?";
                $params[] = $imageHash;
            }

            $whereSql = '(' . implode(' OR ', $signatureConditions) . ')';
            if (!$includeInactive) {
                $whereSql .= " AND cf.is_active = 1 AND cr.is_active = 1";
            }
            if ($excludeCriminalId !== null) {
                $whereSql .= " AND cf.criminal_id <> ?";
                $params[] = intval($excludeCriminalId);
            }

            $stmt = $this->db->prepare("
                SELECT
                    cf.id,
                    cf.criminal_id,
                    cf.finger_position,
                    cf.template,
                    cf.fingerprint_image,
                    cr.name AS criminal_name
                FROM criminal_fingerprints cf
                INNER JOIN criminal_records cr ON cr.id = cf.criminal_id
                WHERE {$whereSql}
                ORDER BY cf.id DESC
            ");
            $stmt->execute($params);
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            if (empty($rows)) {
                $fallbackWhere = "
                    (
                        cf.template_hash IS NULL
                        OR cf.template_hash = ''
                        OR (cf.fingerprint_image IS NOT NULL AND cf.fingerprint_image <> '' AND (cf.image_hash IS NULL OR cf.image_hash = ''))
                    )
                ";
                if (!$includeInactive) {
                    $fallbackWhere .= " AND cf.is_active = 1 AND cr.is_active = 1";
                }
                $fallbackStmt = $this->db->query("
                    SELECT
                        cf.id,
                        cf.criminal_id,
                        cf.finger_position,
                        cf.template,
                        cf.fingerprint_image,
                        cr.name AS criminal_name
                    FROM criminal_fingerprints cf
                    INNER JOIN criminal_records cr ON cr.id = cf.criminal_id
                    WHERE {$fallbackWhere}
                    ORDER BY cf.id DESC
                ");
                $rows = $fallbackStmt->fetchAll(PDO::FETCH_ASSOC);
            }

            foreach ($rows as $row) {
                $candidateCriminalId = intval($row['criminal_id'] ?? 0);
                if ($excludeCriminalId !== null && $candidateCriminalId === intval($excludeCriminalId)) {
                    continue;
                }

                $candidateTemplate = (string)($row['template'] ?? '');
                $candidateImage = $row['fingerprint_image'] ?? null;
                $candidateTemplateHash = $this->hashFingerprintTemplate($candidateTemplate);
                $candidateImageHash = $this->hashFingerprintImage($candidateImage);

                $templateExact = $templateHash !== null
                    && $candidateTemplateHash !== null
                    && hash_equals($templateHash, $candidateTemplateHash);
                $imageExact = $imageHash !== null
                    && $candidateImageHash !== null
                    && hash_equals($imageHash, $candidateImageHash);

                if (!$templateExact && !$imageExact) {
                    continue;
                }

                return [
                    'fingerprint_id' => intval($row['id'] ?? 0),
                    'criminal_id' => $candidateCriminalId,
                    'criminal_name' => $row['criminal_name'] ?? 'Unknown',
                    'finger_position' => $row['finger_position'] ?? 'UNSPECIFIED',
                    'match_basis' => $templateExact ? 'template_hash' : 'image_hash'
                ];
            }
        } catch (PDOException $e) {
            error_log("Duplicate fingerprint lookup failed: " . $e->getMessage());
        }

        return null;
    }

    public function findCriminalFingerprintAssociations($template, $fingerprintImage = null, $includeInactive = true) {
        if (!$this->db || !is_string($template) || $template === '') {
            return [];
        }

        $templateHash = $this->hashFingerprintTemplate($template);
        $imageHash = $this->hashFingerprintImage($fingerprintImage);
        if ($templateHash === null && $imageHash === null) {
            return [];
        }

        try {
            $conditions = [];
            $params = [];
            if ($templateHash !== null) {
                $conditions[] = "cf.template_hash = ?";
                $params[] = $templateHash;
            }
            if ($imageHash !== null) {
                $conditions[] = "cf.image_hash = ?";
                $params[] = $imageHash;
            }
            if (empty($conditions)) {
                return [];
            }

            $where = '(' . implode(' OR ', $conditions) . ')';
            if (!$includeInactive) {
                $where .= " AND cf.is_active = 1 AND cr.is_active = 1";
            }

            $stmt = $this->db->prepare("
                SELECT
                    cf.id,
                    cf.criminal_id,
                    cf.finger_position,
                    cf.template_hash,
                    cf.image_hash,
                    cf.is_active,
                    cr.name AS criminal_name,
                    cr.is_active AS criminal_is_active
                FROM criminal_fingerprints cf
                INNER JOIN criminal_records cr ON cr.id = cf.criminal_id
                WHERE {$where}
                ORDER BY cf.is_active DESC, cf.id DESC
            ");
            $stmt->execute($params);
            $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

            $associations = [];
            foreach ($rows as $row) {
                $criminalId = intval($row['criminal_id'] ?? 0);
                if ($criminalId <= 0) {
                    continue;
                }

                $fingerprintActive = intval($row['is_active'] ?? 0) === 1;
                $criminalActive = intval($row['criminal_is_active'] ?? 1) === 1;
                $associations[] = [
                    'fingerprint_id' => intval($row['id'] ?? 0),
                    'criminal_id' => $criminalId,
                    'criminal_name' => $row['criminal_name'] ?? 'Unknown',
                    'finger_position' => $row['finger_position'] ?? 'UNSPECIFIED',
                    'fingerprint_active' => $fingerprintActive,
                    'criminal_active' => $criminalActive,
                    'active_association' => $fingerprintActive && $criminalActive
                ];
            }

            return $associations;
        } catch (PDOException $e) {
            error_log("Fingerprint association lookup failed: " . $e->getMessage());
            return [];
        }
    }

    public function resolveActiveCriminalFingerprintDuplicates($reasonPrefix = 'Duplicate criminal fingerprint deactivated during integrity cleanup.') {
        if (!$this->db) {
            return [
                'success' => false,
                'error' => 'Database connection not available'
            ];
        }

        try {
            $rows = $this->db->query("
                SELECT id, criminal_id, template_hash, image_hash, captured_at
                FROM criminal_fingerprints
                WHERE is_active = 1
                ORDER BY id ASC
            ")->fetchAll(PDO::FETCH_ASSOC);

            $groups = [];
            foreach ($rows as $row) {
                $templateHash = trim((string)($row['template_hash'] ?? ''));
                $imageHash = trim((string)($row['image_hash'] ?? ''));
                if ($templateHash !== '') {
                    $groups['t:' . $templateHash][] = $row;
                }
                if ($imageHash !== '') {
                    $groups['i:' . $imageHash][] = $row;
                }
            }

            $deactivateStmt = $this->db->prepare("
                UPDATE criminal_fingerprints
                SET is_active = 0,
                    superseded_by = ?,
                    deactivated_at = NOW(),
                    deactivation_reason = ?
                WHERE id = ?
                  AND is_active = 1
            ");

            $deactivatedIds = [];
            $setsResolved = 0;

            foreach ($groups as $signature => $groupRows) {
                if (count($groupRows) < 2) {
                    continue;
                }

                $criminalIds = [];
                foreach ($groupRows as $row) {
                    $criminalIds[intval($row['criminal_id'])] = true;
                }
                if (count($criminalIds) < 2) {
                    continue;
                }

                usort($groupRows, function ($a, $b) {
                    return intval($a['id']) <=> intval($b['id']);
                });
                $keeper = $groupRows[0];
                $keeperId = intval($keeper['id']);
                $reason = $reasonPrefix . ' Signature: ' . $signature . '. Keeper fingerprint ID: ' . $keeperId . '.';

                $setChanged = false;
                foreach (array_slice($groupRows, 1) as $row) {
                    $rowId = intval($row['id']);
                    if (isset($deactivatedIds[$rowId])) {
                        continue;
                    }

                    $deactivateStmt->execute([$keeperId, $reason, $rowId]);
                    if (intval($deactivateStmt->rowCount()) > 0) {
                        $deactivatedIds[$rowId] = true;
                        $setChanged = true;
                    }
                }

                if ($setChanged) {
                    $setsResolved++;
                }
            }

            return [
                'success' => true,
                'deactivated_count' => count($deactivatedIds),
                'resolved_sets' => $setsResolved
            ];
        } catch (PDOException $e) {
            return [
                'success' => false,
                'error' => 'Database error: ' . $e->getMessage()
            ];
        }
    }
    
    /**
     * Store criminal fingerprint
     */
    public function storeCriminalFingerprint($criminalId, $finger, $template, $format = 'ISO', $quality = 0, $fingerprintImage = null, $fingerprintFilename = null) {
        if (!$this->db) {
            return [
                'success' => false,
                'error' => 'Database connection not available'
            ];
        }
        
        try {
            // Only active criminal biometric assignments should block a new enrollment.
            $duplicate = $this->findCriminalFingerprintDuplicate($template, $fingerprintImage, $criminalId, false);
            if (!empty($duplicate)) {
                return [
                    'success' => false,
                    'error' => 'Duplicate fingerprint detected. This biometric record already exists under another criminal profile.',
                    'code' => 'DUPLICATE_FINGERPRINT',
                    'duplicate' => $duplicate
                ];
            }

            $normalizedImage = $this->normalizeFingerprintImageValue($fingerprintImage);
            $normalizedFilename = $this->normalizeFingerprintFilename($fingerprintFilename);
            $templateHash = $this->hashFingerprintTemplate($template);
            $imageHash = $this->hashFingerprintImage($normalizedImage);

            $stmt = $this->db->prepare("
                INSERT INTO criminal_fingerprints 
                (criminal_id, finger_position, template, template_format, fingerprint_image, fingerprint_filename, template_hash, image_hash, quality_score)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE 
                    template = VALUES(template),
                    fingerprint_image = VALUES(fingerprint_image),
                    fingerprint_filename = VALUES(fingerprint_filename),
                    template_hash = VALUES(template_hash),
                    image_hash = VALUES(image_hash),
                    is_active = 1,
                    superseded_by = NULL,
                    deactivated_at = NULL,
                    deactivation_reason = NULL,
                    quality_score = VALUES(quality_score)
            ");
            
            $stmt->execute([$criminalId, $finger, $template, $format, $normalizedImage, $normalizedFilename, $templateHash, $imageHash, $quality]);
            
            return [
                'success' => true,
                'message' => 'Criminal fingerprint stored',
                'record_id' => $this->db->lastInsertId()
            ];
        } catch (PDOException $e) {
            return [
                'success' => false,
                'error' => 'Database error: ' . $e->getMessage()
            ];
        }
    }
    
    /**
     * Store applicant fingerprint
     */
    public function storeApplicantFingerprint($applicantId, $finger, $template, $format = 'ISO', $quality = 0, $fingerprintImage = null) {
        if (!$this->db) {
            return [
                'success' => false,
                'error' => 'Database connection not available'
            ];
        }
        
        try {
            $stmt = $this->db->prepare("
                INSERT INTO applicant_fingerprints 
                (applicant_id, finger_position, template, template_format, fingerprint_image, quality_score)
                VALUES (?, ?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE 
                    template = VALUES(template),
                    fingerprint_image = VALUES(fingerprint_image),
                    quality_score = VALUES(quality_score)
            ");
            
            $stmt->execute([$applicantId, $finger, $template, $format, $fingerprintImage, $quality]);

            $existing = $this->getApplicantById($applicantId);
            $statusStmt = $this->db->prepare("
                UPDATE applicants
                SET fingerprint_verification_status = 'SUBMITTED'
                WHERE id = ?
            ");
            $statusStmt->execute([intval($applicantId)]);
            $this->logApplicationUpdate(
                intval($applicantId),
                'FINGERPRINT_CAPTURED',
                'Applicant fingerprint captured or uploaded.',
                $existing['clearance_status'] ?? null,
                $existing['clearance_status'] ?? null,
                $existing['fingerprint_verification_status'] ?? null,
                'SUBMITTED',
                null,
                'system',
                'system',
                ['finger_position' => $finger, 'template_format' => $format]
            );
            
            return [
                'success' => true,
                'message' => 'Applicant fingerprint stored',
                'record_id' => $this->db->lastInsertId()
            ];
        } catch (PDOException $e) {
            return [
                'success' => false,
                'error' => 'Database error: ' . $e->getMessage()
            ];
        }
    }
    
    /**
     * Get all criminal fingerprints
     */
    public function getCriminalFingerprints($criminalId = null, $includeInactive = false) {
        if (!$this->db) return [];
        
        try {
            $activeFilter = $includeInactive ? '' : ' AND is_active = 1';
            if ($criminalId) {
                $stmt = $this->db->prepare(
                    "SELECT * FROM criminal_fingerprints WHERE criminal_id = ?" . $activeFilter . " ORDER BY finger_position"
                );
                $stmt->execute([$criminalId]);
            } else {
                $where = $includeInactive ? '' : ' WHERE is_active = 1';
                $stmt = $this->db->query("SELECT * FROM criminal_fingerprints" . $where . " ORDER BY criminal_id, finger_position");
            }
            
            return $stmt->fetchAll(PDO::FETCH_ASSOC);
        } catch (PDOException $e) {
            error_log("Query error: " . $e->getMessage());
            return [];
        }
    }

    /**
     * Get criminal demographic records with fingerprint counts (for admin listing).
     */
    public function getCriminalRecords($criminalId = null, $includeInactive = false) {
        if (!$this->db) return [];

        try {
            $sql = "
                SELECT
                    cr.id,
                    cr.name,
                    cr.age,
                    cr.sex,
                    cr.case_number,
                    cr.is_active,
                    cr.deleted_at,
                    cr.deletion_reason,
                    cr.record_date,
                    COUNT(cf.id) AS fingerprint_count
                FROM criminal_records cr
                LEFT JOIN criminal_fingerprints cf ON cr.id = cf.criminal_id AND cf.is_active = 1
            ";
            $conditions = [];
            $params = [];

            if (!$includeInactive) {
                $conditions[] = "cr.is_active = 1";
            }

            if ($criminalId !== null) {
                $conditions[] = "cr.id = ?";
                $params[] = intval($criminalId);
            }

            if (!empty($conditions)) {
                $sql .= " WHERE " . implode(" AND ", $conditions);
            }

            if ($criminalId !== null) {
                $sql .= " GROUP BY cr.id ORDER BY cr.record_date DESC";
                $stmt = $this->db->prepare($sql);
                $stmt->execute($params);
                return $stmt->fetchAll(PDO::FETCH_ASSOC);
            }

            $sql .= " GROUP BY cr.id ORDER BY cr.record_date DESC";
            $stmt = $this->db->query($sql);
            return $stmt->fetchAll(PDO::FETCH_ASSOC);
        } catch (PDOException $e) {
            error_log("Query error: " . $e->getMessage());
            return [];
        }
    }
    
    /**
     * Search for criminals by demographics (name, age, sex)
     * Used for initial HIT check before fingerprint matching
     */
    public function searchCriminalByDemographics($name, $age = null, $sex = null) {
        if (!$this->db) {
            return [
                'success' => false,
                'hits' => []
            ];
        }
        
        try {
            $query = "SELECT cr.*, COUNT(cf.id) as fingerprint_count 
                      FROM criminal_records cr 
                      LEFT JOIN criminal_fingerprints cf ON cr.id = cf.criminal_id ";
            $params = [];
            $conditions = [];
            
            // Always search by name (case-insensitive)
            $conditions[] = "cr.is_active = 1";
            $conditions[] = "LOWER(cr.name) = LOWER(?)";
            $params[] = trim($name);
            
            // Add age if provided
            if ($age !== null) {
                $conditions[] = "cr.age = ?";
                $params[] = intval($age);
            }
            
            // Add sex if provided
            if ($sex !== null) {
                $conditions[] = "cr.sex = ?";
                $params[] = strtoupper(substr($sex, 0, 1)); // M or F
            }
            
            $query .= "WHERE " . implode(" AND ", $conditions);
            $query .= " GROUP BY cr.id ORDER BY cr.record_date DESC";
            
            $stmt = $this->db->prepare($query);
            $stmt->execute($params);
            $results = $stmt->fetchAll(PDO::FETCH_ASSOC);
            
            return [
                'success' => true,
                'hits' => $results,
                'hit_count' => count($results)
            ];
        } catch (PDOException $e) {
            error_log("Query error: " . $e->getMessage());
            return [
                'success' => false,
                'error' => $e->getMessage(),
                'hits' => []
            ];
        }
    }
    
    /**
     * Register a new criminal record with demographics
     */
    public function registerCriminal($name, $age, $sex, $caseNumber = null) {
        if (!$this->db) {
            return [
                'success' => false,
                'error' => 'Database connection not available'
            ];
        }
        
        try {
            $stmt = $this->db->prepare("
                INSERT INTO criminal_records (name, age, sex, case_number)
                VALUES (?, ?, ?, ?)
            ");
            
            $stmt->execute([
                $name,
                intval($age),
                strtoupper(substr($sex, 0, 1)),
                $caseNumber
            ]);
            
            return [
                'success' => true,
                'message' => 'Criminal record created',
                'criminal_id' => $this->db->lastInsertId()
            ];
        } catch (PDOException $e) {
            return [
                'success' => false,
                'error' => 'Database error: ' . $e->getMessage()
            ];
        }
    }
    
    /**
     * Register a new applicant with demographics
     */
    public function registerApplicant($name, $age, $sex, $email = null, $privacyConsent = []) {
        if (!$this->db) {
            return [
                'success' => false,
                'error' => 'Database connection not available'
            ];
        }
        
        try {
            $stmt = $this->db->prepare("
                INSERT INTO applicants (
                    name,
                    age,
                    sex,
                    email,
                    clearance_status,
                    fingerprint_verification_status,
                    privacy_consent_given,
                    privacy_consent_at,
                    privacy_notice_version
                )
                VALUES (?, ?, ?, ?, 'PENDING', 'NOT_STARTED', ?, ?, ?)
            ");
            
            $stmt->execute([
                $name,
                intval($age),
                strtoupper(substr($sex, 0, 1)),
                $email,
                !empty($privacyConsent['accepted']) ? 1 : 0,
                !empty($privacyConsent['accepted']) ? ($privacyConsent['consented_at'] ?? date('Y-m-d H:i:s')) : null,
                $privacyConsent['version'] ?? null
            ]);
            
            $applicantId = intval($this->db->lastInsertId());
            $this->logApplicationUpdate(
                $applicantId,
                'APPLICATION_SUBMITTED',
                'Application submitted and stored in application history.',
                null,
                'PENDING',
                null,
                'NOT_STARTED',
                null,
                'system',
                'system',
                [
                    'privacy_notice_version' => $privacyConsent['version'] ?? null,
                    'privacy_consent_given' => !empty($privacyConsent['accepted'])
                ]
            );

            return [
                'success' => true,
                'message' => 'Applicant registered',
                'applicant_id' => $applicantId
            ];
        } catch (PDOException $e) {
            return [
                'success' => false,
                'error' => 'Database error: ' . $e->getMessage()
            ];
        }
    }
    
    /**
     * Update applicant clearance status
     */
    public function updateApplicantStatus($applicantId, $status) {
        if (!$this->db) {
            return [
                'success' => false,
                'error' => 'Database connection not available'
            ];
        }
        
        try {
            $existing = $this->getApplicantById($applicantId);
            $stmt = $this->db->prepare("
                UPDATE applicants SET clearance_status = ? WHERE id = ?
            ");
            
            $stmt->execute([$status, $applicantId]);

            $this->logApplicationUpdate(
                intval($applicantId),
                'STATUS_UPDATED',
                'Application status updated.',
                $existing['clearance_status'] ?? null,
                $status,
                $existing['fingerprint_verification_status'] ?? null,
                $existing['fingerprint_verification_status'] ?? null
            );
            
            return [
                'success' => true,
                'message' => 'Applicant status updated',
                'status' => $status
            ];
        } catch (PDOException $e) {
            return [
                'success' => false,
                'error' => 'Database error: ' . $e->getMessage()
            ];
        }
    }

    public function deactivateCriminalFingerprint($fingerprintId, $reason = null) {
        if (!$this->db) {
            return [
                'success' => false,
                'error' => 'Database connection not available'
            ];
        }

        try {
            $id = intval($fingerprintId);
            if ($id <= 0) {
                return [
                    'success' => false,
                    'error' => 'Invalid fingerprint ID.',
                    'code' => 'INVALID_FINGERPRINT_ID'
                ];
            }

            $selectStmt = $this->db->prepare("
                SELECT id, criminal_id, finger_position, fingerprint_filename, is_active
                FROM criminal_fingerprints
                WHERE id = ?
                LIMIT 1
            ");
            $selectStmt->execute([$id]);
            $row = $selectStmt->fetch(PDO::FETCH_ASSOC);

            if (!$row) {
                return [
                    'success' => false,
                    'error' => 'Fingerprint template not found.',
                    'code' => 'NOT_FOUND'
                ];
            }

            if (intval($row['is_active'] ?? 0) !== 1) {
                return [
                    'success' => true,
                    'already_deleted' => true,
                    'fingerprint_id' => intval($row['id']),
                    'criminal_id' => intval($row['criminal_id']),
                    'finger_position' => $row['finger_position'] ?? 'UNSPECIFIED',
                    'fingerprint_filename' => $row['fingerprint_filename'] ?? null
                ];
            }

            $deleteReason = trim((string)$reason);
            if ($deleteReason === '') {
                $deleteReason = 'Fingerprint template removed by authorized user.';
            }

            $updateStmt = $this->db->prepare("
                UPDATE criminal_fingerprints
                SET
                    is_active = 0,
                    superseded_by = NULL,
                    deactivated_at = NOW(),
                    deactivation_reason = ?
                WHERE id = ?
            ");
            $updateStmt->execute([$deleteReason, $id]);

            return [
                'success' => true,
                'fingerprint_id' => intval($row['id']),
                'criminal_id' => intval($row['criminal_id']),
                'finger_position' => $row['finger_position'] ?? 'UNSPECIFIED',
                'fingerprint_filename' => $row['fingerprint_filename'] ?? null
            ];
        } catch (PDOException $e) {
            return [
                'success' => false,
                'error' => 'Database error: ' . $e->getMessage()
            ];
        }
    }

    /**
     * Update an existing criminal demographic record.
     */
    public function updateCriminalRecord($criminalId, $name, $age, $sex, $caseNumber = null) {
        if (!$this->db) {
            return [
                'success' => false,
                'error' => 'Database connection not available'
            ];
        }

        try {
            $id = intval($criminalId);
            if ($id <= 0) {
                return [
                    'success' => false,
                    'error' => 'Invalid criminal ID.',
                    'code' => 'INVALID_CRIMINAL_ID'
                ];
            }

            $name = trim((string)$name);
            if ($name === '') {
                return [
                    'success' => false,
                    'error' => 'Criminal name is required.',
                    'code' => 'MISSING_NAME'
                ];
            }

            $selectStmt = $this->db->prepare("
                SELECT id, name, age, sex, case_number, is_active
                FROM criminal_records
                WHERE id = ?
                LIMIT 1
            ");
            $selectStmt->execute([$id]);
            $existing = $selectStmt->fetch(PDO::FETCH_ASSOC);

            if (!$existing) {
                return [
                    'success' => false,
                    'error' => 'Criminal record not found.',
                    'code' => 'NOT_FOUND'
                ];
            }

            $caseNumber = trim((string)$caseNumber);
            if ($caseNumber === '') {
                $caseNumber = null;
            }

            $stmt = $this->db->prepare("
                UPDATE criminal_records
                SET
                    name = ?,
                    age = ?,
                    sex = ?,
                    case_number = ?
                WHERE id = ?
            ");

            $stmt->execute([
                $name,
                intval($age),
                strtoupper(substr((string)$sex, 0, 1)),
                $caseNumber,
                $id
            ]);

            return [
                'success' => true,
                'message' => 'Criminal record updated',
                'criminal_id' => $id,
                'criminal_name' => $name,
                'previous_name' => $existing['name'] ?? null,
                'previous_case_number' => $existing['case_number'] ?? null
            ];
        } catch (PDOException $e) {
            return [
                'success' => false,
                'error' => 'Database error: ' . $e->getMessage()
            ];
        }
    }

    public function deactivateCriminalRecord($criminalId, $reason = null) {
        if (!$this->db) {
            return [
                'success' => false,
                'error' => 'Database connection not available'
            ];
        }

        try {
            $id = intval($criminalId);
            if ($id <= 0) {
                return [
                    'success' => false,
                    'error' => 'Invalid criminal ID.',
                    'code' => 'INVALID_CRIMINAL_ID'
                ];
            }

            $selectStmt = $this->db->prepare("
                SELECT id, name, is_active
                FROM criminal_records
                WHERE id = ?
                LIMIT 1
            ");
            $selectStmt->execute([$id]);
            $record = $selectStmt->fetch(PDO::FETCH_ASSOC);

            if (!$record) {
                return [
                    'success' => false,
                    'error' => 'Criminal record not found.',
                    'code' => 'NOT_FOUND'
                ];
            }

            if (intval($record['is_active'] ?? 0) !== 1) {
                return [
                    'success' => true,
                    'already_deleted' => true,
                    'criminal_id' => intval($record['id']),
                    'criminal_name' => $record['name'] ?? null
                ];
            }

            $deleteReason = trim((string)$reason);
            if ($deleteReason === '') {
                $deleteReason = 'Criminal record removed by authorized user.';
            }

            $fingerprintReason = 'Criminal record deactivated. ' . $deleteReason;

            $this->db->beginTransaction();

            $updateRecordStmt = $this->db->prepare("
                UPDATE criminal_records
                SET
                    is_active = 0,
                    deleted_at = NOW(),
                    deletion_reason = ?
                WHERE id = ?
            ");
            $updateRecordStmt->execute([$deleteReason, $id]);

            $updateFingerprintStmt = $this->db->prepare("
                UPDATE criminal_fingerprints
                SET
                    is_active = 0,
                    superseded_by = NULL,
                    deactivated_at = COALESCE(deactivated_at, NOW()),
                    deactivation_reason = CASE
                        WHEN deactivation_reason IS NULL OR deactivation_reason = '' THEN ?
                        ELSE CONCAT(deactivation_reason, ' | ', ?)
                    END
                WHERE criminal_id = ?
                  AND is_active = 1
            ");
            $updateFingerprintStmt->execute([$fingerprintReason, $fingerprintReason, $id]);

            $this->db->commit();

            return [
                'success' => true,
                'criminal_id' => intval($record['id']),
                'criminal_name' => $record['name'] ?? null
            ];
        } catch (PDOException $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }

            return [
                'success' => false,
                'error' => 'Database error: ' . $e->getMessage()
            ];
        }
    }

    public function getApplicantById($applicantId) {
        $records = $this->getApplicants($applicantId);
        return !empty($records) ? $records[0] : null;
    }
    
    /**
     * Get all applicant fingerprints
     */
    public function getApplicantFingerprints($applicantId = null) {
        if (!$this->db) return [];
        
        try {
            if ($applicantId) {
                $stmt = $this->db->prepare(
                    "SELECT * FROM applicant_fingerprints WHERE applicant_id = ? ORDER BY finger_position"
                );
                $stmt->execute([$applicantId]);
            } else {
                $stmt = $this->db->query("SELECT * FROM applicant_fingerprints ORDER BY applicant_id, finger_position");
            }
            
            return $stmt->fetchAll(PDO::FETCH_ASSOC);
        } catch (PDOException $e) {
            error_log("Query error: " . $e->getMessage());
            return [];
        }
    }

    /**
     * Get applicant demographic records with fingerprint counts (for admin listing).
     */
    public function getApplicants($applicantId = null) {
        if (!$this->db) return [];

        try {
            $sql = "
                SELECT
                    a.id,
                    a.name,
                    a.age,
                    a.sex,
                    a.email,
                    a.clearance_status,
                    a.fingerprint_verification_status,
                    a.privacy_consent_given,
                    a.privacy_consent_at,
                    a.privacy_notice_version,
                    a.submitted_at,
                    a.last_updated_at,
                    COUNT(af.id) AS fingerprint_count
                FROM applicants a
                LEFT JOIN applicant_fingerprints af ON a.id = af.applicant_id
            ";

            if ($applicantId !== null) {
                $sql .= " WHERE a.id = ? ";
                $sql .= " GROUP BY a.id ORDER BY a.submitted_at DESC";
                $stmt = $this->db->prepare($sql);
                $stmt->execute([intval($applicantId)]);
                return $stmt->fetchAll(PDO::FETCH_ASSOC);
            }

            $sql .= " GROUP BY a.id ORDER BY a.submitted_at DESC";
            $stmt = $this->db->query($sql);
            return $stmt->fetchAll(PDO::FETCH_ASSOC);
        } catch (PDOException $e) {
            error_log("Query error: " . $e->getMessage());
            return [];
        }
    }

    /**
     * Get applicant status counters for admin dashboard.
     */
    public function getApplicantStatusStats() {
        if (!$this->db) {
            return [
                'total' => 0,
                'approved' => 0,
                'rejected' => 0,
                'pending' => 0,
                'under_review' => 0,
                'flagged' => 0
            ];
        }

        try {
            $row = $this->db->query("
                SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN clearance_status = 'APPROVED' OR clearance_status = 'APPROVED_WITH_CAUTION' THEN 1 ELSE 0 END) AS approved,
                    SUM(CASE WHEN clearance_status = 'REJECTED' THEN 1 ELSE 0 END) AS rejected,
                    SUM(CASE WHEN clearance_status = 'PENDING' OR clearance_status = 'PENDING_FINGERPRINT' OR clearance_status IS NULL THEN 1 ELSE 0 END) AS pending,
                    SUM(CASE WHEN clearance_status = 'UNDER_REVIEW' THEN 1 ELSE 0 END) AS under_review,
                    SUM(CASE WHEN clearance_status = 'FLAGGED' THEN 1 ELSE 0 END) AS flagged
                FROM applicants
            ")->fetch(PDO::FETCH_ASSOC);

            return [
                'total' => intval($row['total'] ?? 0),
                'approved' => intval($row['approved'] ?? 0),
                'rejected' => intval($row['rejected'] ?? 0),
                'pending' => intval($row['pending'] ?? 0),
                'under_review' => intval($row['under_review'] ?? 0),
                'flagged' => intval($row['flagged'] ?? 0)
            ];
        } catch (PDOException $e) {
            error_log("Query error: " . $e->getMessage());
            return [
                'total' => 0,
                'approved' => 0,
                'rejected' => 0,
                'pending' => 0,
                'under_review' => 0,
                'flagged' => 0
            ];
        }
    }

    public function getApplicationHistory($filters = [], $viewerRole = 'admin') {
        if (!$this->db) {
            return [];
        }

        try {
            $sql = "
                SELECT
                    a.id,
                    a.name,
                    a.age,
                    a.sex,
                    a.clearance_status,
                    a.fingerprint_verification_status,
                    a.submitted_at,
                    a.last_updated_at,
                    COUNT(DISTINCT aul.id) AS update_count
            ";

            if ($viewerRole === 'super_admin') {
                $sql .= ",
                    a.email,
                    a.privacy_notice_version,
                    a.privacy_consent_at
                ";
            }

            $sql .= "
                FROM applicants a
                LEFT JOIN application_update_logs aul ON a.id = aul.applicant_id
            ";

            $conditions = [];
            $params = [];

            if (!empty($filters['search'])) {
                $conditions[] = "(a.name LIKE ? OR CAST(a.id AS CHAR) LIKE ?)";
                $search = '%' . trim((string)$filters['search']) . '%';
                $params[] = $search;
                $params[] = $search;
            }

            if (!empty($filters['status'])) {
                $conditions[] = "a.clearance_status = ?";
                $params[] = trim((string)$filters['status']);
            }

            if (!empty($filters['fingerprint_status'])) {
                $conditions[] = "a.fingerprint_verification_status = ?";
                $params[] = trim((string)$filters['fingerprint_status']);
            }

            if (!empty($filters['date_from'])) {
                $conditions[] = "DATE(a.submitted_at) >= ?";
                $params[] = trim((string)$filters['date_from']);
            }

            if (!empty($filters['date_to'])) {
                $conditions[] = "DATE(a.submitted_at) <= ?";
                $params[] = trim((string)$filters['date_to']);
            }

            if (!empty($conditions)) {
                $sql .= " WHERE " . implode(' AND ', $conditions);
            }

            $sql .= " GROUP BY a.id ORDER BY a.submitted_at DESC";
            $stmt = $this->db->prepare($sql);
            $stmt->execute($params);
            return $stmt->fetchAll(PDO::FETCH_ASSOC);
        } catch (PDOException $e) {
            error_log("Application history query error: " . $e->getMessage());
            return [];
        }
    }

    public function getApplicationUpdateLogs($applicantId, $viewerRole = 'admin') {
        if (!$this->db) {
            return [];
        }

        try {
            if ($viewerRole === 'super_admin') {
                $stmt = $this->db->prepare("
                    SELECT
                        id,
                        applicant_id,
                        change_type,
                        note,
                        previous_status,
                        new_status,
                        previous_fingerprint_status,
                        new_fingerprint_status,
                        actor_name,
                        actor_role,
                        metadata,
                        changed_at
                    FROM application_update_logs
                    WHERE applicant_id = ?
                    ORDER BY changed_at DESC, id DESC
                ");
            } else {
                $stmt = $this->db->prepare("
                    SELECT
                        id,
                        applicant_id,
                        change_type,
                        note,
                        new_status,
                        new_fingerprint_status,
                        actor_role,
                        changed_at
                    FROM application_update_logs
                    WHERE applicant_id = ?
                    ORDER BY changed_at DESC, id DESC
                ");
            }

            $stmt->execute([intval($applicantId)]);
            return $stmt->fetchAll(PDO::FETCH_ASSOC);
        } catch (PDOException $e) {
            error_log("Application update log query error: " . $e->getMessage());
            return [];
        }
    }

    public function updateApplicantFingerprintStatus($applicantId, $fingerprintStatus, $note = 'Fingerprint verification status updated.', $actorUserId = null, $actorName = 'system', $actorRole = 'system', $metadata = []) {
        if (!$this->db) {
            return [
                'success' => false,
                'error' => 'Database connection not available'
            ];
        }

        try {
            $existing = $this->getApplicantById($applicantId);
            $stmt = $this->db->prepare("
                UPDATE applicants
                SET fingerprint_verification_status = ?
                WHERE id = ?
            ");
            $stmt->execute([$fingerprintStatus, intval($applicantId)]);

            $this->logApplicationUpdate(
                intval($applicantId),
                'FINGERPRINT_STATUS_UPDATED',
                $note,
                $existing['clearance_status'] ?? null,
                $existing['clearance_status'] ?? null,
                $existing['fingerprint_verification_status'] ?? null,
                $fingerprintStatus,
                $actorUserId,
                $actorName,
                $actorRole,
                $metadata
            );

            return [
                'success' => true,
                'fingerprint_verification_status' => $fingerprintStatus
            ];
        } catch (PDOException $e) {
            return [
                'success' => false,
                'error' => 'Database error: ' . $e->getMessage()
            ];
        }
    }
    
    /**
     * Record a match result
     */
    public function recordMatchResult($applicantId, $criminalId, $finger, $score, $isMatch, $reviewStatus = null, $disclosureLevel = 'RESTRICTED') {
        if (!$this->db) {
            return [
                'success' => false,
                'error' => 'Database connection not available'
            ];
        }
        
        try {
            $stmt = $this->db->prepare("
                INSERT INTO fingerprint_matches 
                (applicant_id, criminal_id, finger_matched, match_score, is_match, review_status, disclosure_level)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            ");
            
            $stmt->execute([
                $applicantId,
                $criminalId,
                $finger,
                $score,
                $isMatch ? 1 : 0,
                $reviewStatus ?: ($isMatch ? 'PENDING_REVIEW' : 'CLEAR'),
                $disclosureLevel
            ]);
            
            return [
                'success' => true,
                'message' => 'Match result recorded',
                'record_id' => $this->db->lastInsertId()
            ];
        } catch (PDOException $e) {
            return [
                'success' => false,
                'error' => 'Database error: ' . $e->getMessage()
            ];
        }
    }

    public function supersedePendingMatches($applicantId, $note = 'Superseded by a newer fingerprint verification run.') {
        if (!$this->db) {
            return [
                'success' => false,
                'error' => 'Database connection not available'
            ];
        }

        try {
            $stmt = $this->db->prepare("
                UPDATE fingerprint_matches
                SET review_status = 'SUPERSEDED',
                    review_outcome = 'superseded',
                    review_notes = COALESCE(NULLIF(review_notes, ''), ?),
                    reviewed_at = NOW()
                WHERE applicant_id = ?
                  AND is_match = 1
                  AND review_status = 'PENDING_REVIEW'
            ");
            $stmt->execute([$note, intval($applicantId)]);

            return [
                'success' => true,
                'updated_rows' => intval($stmt->rowCount())
            ];
        } catch (PDOException $e) {
            return [
                'success' => false,
                'error' => 'Database error: ' . $e->getMessage()
            ];
        }
    }
    
    /**
     * Get match history for an applicant
     */
    public function getMatchHistory($applicantId, $includeSensitive = true) {
        if (!$this->db) return [];
        
        try {
            if ($includeSensitive) {
                $stmt = $this->db->prepare("
                    SELECT fm.*, cr.name AS criminal_name 
                    FROM fingerprint_matches fm
                    LEFT JOIN criminal_records cr ON fm.criminal_id = cr.id
                    WHERE fm.applicant_id = ?
                    ORDER BY fm.matched_at DESC
                ");
            } else {
                $stmt = $this->db->prepare("
                    SELECT
                        fm.id,
                        fm.applicant_id,
                        fm.review_status,
                        fm.review_outcome,
                        fm.matched_at,
                        fm.reviewed_at,
                        fm.is_match
                    FROM fingerprint_matches fm
                    WHERE fm.applicant_id = ?
                    ORDER BY fm.matched_at DESC
                ");
            }
            
            $stmt->execute([$applicantId]);
            return $stmt->fetchAll(PDO::FETCH_ASSOC);
        } catch (PDOException $e) {
            error_log("Query error: " . $e->getMessage());
            return [];
        }
    }

    public function updateMatchReview($applicantId, $decision, $notes, $reviewedBy) {
        if (!$this->db) {
            return [
                'success' => false,
                'error' => 'Database connection not available'
            ];
        }

        $statusMap = [
            'approve' => 'APPROVED',
            'reject' => 'REJECTED',
            'flag' => 'FLAGGED'
        ];
        $fingerprintStatusMap = [
            'approve' => 'MANUALLY_CLEARED',
            'reject' => 'CONFIRMED_MATCH',
            'flag' => 'FLAGGED_FOR_REVIEW'
        ];

        $reviewOutcome = strtolower(trim((string)$decision));
        if (!isset($statusMap[$reviewOutcome])) {
            return [
                'success' => false,
                'error' => 'Invalid review decision.'
            ];
        }

        try {
            $stmt = $this->db->prepare("
                UPDATE fingerprint_matches
                SET review_status = 'REVIEWED',
                    review_outcome = ?,
                    review_notes = ?,
                    reviewed_by = ?,
                    reviewed_at = NOW()
                WHERE applicant_id = ?
                  AND is_match = 1
                  AND review_status = 'PENDING_REVIEW'
            ");
            $stmt->execute([$reviewOutcome, $notes, $reviewedBy, $applicantId]);

            $this->updateApplicantStatus($applicantId, $statusMap[$reviewOutcome]);
            $reviewer = $this->getAdminUserById($reviewedBy);
            $this->updateApplicantFingerprintStatus(
                $applicantId,
                $fingerprintStatusMap[$reviewOutcome],
                $notes !== '' ? $notes : 'Manual fingerprint review completed.',
                $reviewedBy,
                $reviewer['username'] ?? 'super_admin',
                $reviewer['role'] ?? 'super_admin',
                ['review_outcome' => $reviewOutcome]
            );

            return [
                'success' => true,
                'message' => 'Match review saved.',
                'status' => $statusMap[$reviewOutcome]
            ];
        } catch (PDOException $e) {
            return [
                'success' => false,
                'error' => 'Database error: ' . $e->getMessage()
            ];
        }
    }

    public function getApplicantReviewSummary($applicantId) {
        if (!$this->db) {
            return [];
        }

        try {
            $stmt = $this->db->prepare("
                SELECT
                    COUNT(*) AS total_reviews,
                    SUM(CASE WHEN is_match = 1 THEN 1 ELSE 0 END) AS positive_matches,
                    SUM(CASE WHEN review_status = 'PENDING_REVIEW' THEN 1 ELSE 0 END) AS pending_reviews,
                    MAX(match_score) AS best_score
                FROM fingerprint_matches
                WHERE applicant_id = ?
            ");
            $stmt->execute([$applicantId]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC) ?: [];

            return [
                'total_reviews' => intval($row['total_reviews'] ?? 0),
                'positive_matches' => intval($row['positive_matches'] ?? 0),
                'pending_reviews' => intval($row['pending_reviews'] ?? 0),
                'best_score' => intval($row['best_score'] ?? 0)
            ];
        } catch (PDOException $e) {
            error_log("Query error: " . $e->getMessage());
            return [];
        }
    }

    public function getPendingMatchAlerts($limit = 10) {
        if (!$this->db) {
            return [];
        }

        try {
            $stmt = $this->db->prepare("
                SELECT
                    a.id AS applicant_id,
                    a.name,
                    a.clearance_status,
                    a.fingerprint_verification_status,
                    a.submitted_at,
                    MAX(fm.match_score) AS best_score,
                    MAX(fm.matched_at) AS latest_match_at,
                    COUNT(fm.id) AS pending_match_count
                FROM fingerprint_matches fm
                INNER JOIN applicants a ON a.id = fm.applicant_id
                WHERE fm.is_match = 1
                  AND fm.review_status = 'PENDING_REVIEW'
                GROUP BY a.id, a.name, a.clearance_status, a.fingerprint_verification_status, a.submitted_at
                ORDER BY latest_match_at DESC
                LIMIT ?
            ");
            $stmt->bindValue(1, max(1, intval($limit)), PDO::PARAM_INT);
            $stmt->execute();
            return $stmt->fetchAll(PDO::FETCH_ASSOC);
        } catch (PDOException $e) {
            error_log("Pending match alert query error: " . $e->getMessage());
            return [];
        }
    }

    public function logApplicationUpdate($applicantId, $changeType, $note = null, $previousStatus = null, $newStatus = null, $previousFingerprintStatus = null, $newFingerprintStatus = null, $actorUserId = null, $actorName = 'system', $actorRole = 'system', $metadata = []) {
        if (!$this->db || intval($applicantId) <= 0) {
            return false;
        }

        try {
            $stmt = $this->db->prepare("
                INSERT INTO application_update_logs (
                    applicant_id,
                    change_type,
                    note,
                    previous_status,
                    new_status,
                    previous_fingerprint_status,
                    new_fingerprint_status,
                    actor_user_id,
                    actor_name,
                    actor_role,
                    metadata
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ");

            return $stmt->execute([
                intval($applicantId),
                $changeType,
                $note,
                $previousStatus,
                $newStatus,
                $previousFingerprintStatus,
                $newFingerprintStatus,
                $actorUserId ? intval($actorUserId) : null,
                $actorName,
                $actorRole,
                !empty($metadata) ? json_encode($metadata) : null
            ]);
        } catch (PDOException $e) {
            error_log("Application update log insert error: " . $e->getMessage());
            return false;
        }
    }

    public function getAdminUserByUsername($username) {
        if (!$this->db) {
            return null;
        }

        try {
            $stmt = $this->db->prepare("SELECT * FROM admin_users WHERE username = ? LIMIT 1");
            $stmt->execute([trim((string)$username)]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            return $row ?: null;
        } catch (PDOException $e) {
            error_log("Admin user lookup failed by username: " . $e->getMessage());
            return null;
        }
    }

    public function getAdminUserById($id) {
        if (!$this->db) {
            return null;
        }

        try {
            $stmt = $this->db->prepare("SELECT * FROM admin_users WHERE id = ? LIMIT 1");
            $stmt->execute([intval($id)]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            return $row ?: null;
        } catch (PDOException $e) {
            error_log("Admin user lookup failed by id: " . $e->getMessage());
            return null;
        }
    }

    public function updateAdminLastLogin($id) {
        if (!$this->db) {
            return false;
        }

        try {
            $stmt = $this->db->prepare("UPDATE admin_users SET last_login = NOW() WHERE id = ?");
            return $stmt->execute([intval($id)]);
        } catch (PDOException $e) {
            error_log("Admin last login update failed: " . $e->getMessage());
            return false;
        }
    }

    public function insertAuditLog($userId, $username, $role, $action, $targetType = null, $targetId = null, $details = [], $ipAddress = null) {
        if (!$this->db) {
            return false;
        }

        try {
            $stmt = $this->db->prepare("
                INSERT INTO audit_logs (
                    user_id,
                    username,
                    role,
                    action,
                    target_type,
                    target_id,
                    details,
                    ip_address
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ");

            return $stmt->execute([
                $userId ? intval($userId) : null,
                $username,
                $role,
                $action,
                $targetType,
                $targetId !== null ? (string)$targetId : null,
                !empty($details) ? json_encode($details) : null,
                $ipAddress
            ]);
        } catch (PDOException $e) {
            error_log("Audit log error: " . $e->getMessage());
            return false;
        }
    }
    
    /**
     * Set PDO connection
     */
    public function setConnection($pdo) {
        $this->db = $pdo;
    }
    
    /**
     * Test database connection
     */
    public function testConnection() {
        if (!$this->db) {
            return ['connected' => false, 'error' => 'No PDO connection provided'];
        }
        
        try {
            $this->db->query("SELECT 1");
            return ['connected' => true, 'message' => 'Connected to database'];
        } catch (PDOException $e) {
            return ['connected' => false, 'error' => $e->getMessage()];
        }
    }
}
?>
