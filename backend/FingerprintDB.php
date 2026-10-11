<?php
/**
 * Fingerprint Database Handler
 * Manages storage and retrieval of fingerprint data
 */

class FingerprintDB {
    private const COMPARISON_INLINE_LIMIT = 262144;
    private const COMPARISON_CHUNK_SIZE = 262144;
    
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
            $this->addColumnIfMissing('fingerprint_matches', 'comparison_id', "VARCHAR(160) DEFAULT NULL");
            $this->addColumnIfMissing('fingerprint_matches', 'comparison_result', "LONGTEXT DEFAULT NULL");
            $this->addColumnIfMissing('fingerprint_matches', 'notification_status', "VARCHAR(20) NOT NULL DEFAULT 'none'");
            $this->addColumnIfMissing('fingerprint_matches', 'notification_final_result', "VARCHAR(30) DEFAULT NULL");
            $this->addColumnIfMissing('fingerprint_matches', 'notification_seen_at', "TIMESTAMP NULL DEFAULT NULL");
            $this->addColumnIfMissing('fingerprint_matches', 'notification_read_at', "TIMESTAMP NULL DEFAULT NULL");
            $this->addColumnIfMissing('criminal_fingerprints', 'fingerprint_image', "LONGTEXT DEFAULT NULL");
            $this->addColumnIfMissing('criminal_fingerprints', 'fingerprint_filename', "VARCHAR(255) DEFAULT NULL");
            $this->addColumnIfMissing('criminal_fingerprints', 'template_hash', "VARCHAR(64) DEFAULT NULL");
            $this->addColumnIfMissing('criminal_fingerprints', 'image_hash', "VARCHAR(64) DEFAULT NULL");
            $this->addColumnIfMissing('criminal_fingerprints', 'is_active', "TINYINT(1) NOT NULL DEFAULT 1");
            $this->addColumnIfMissing('criminal_fingerprints', 'superseded_by', "INT NULL");
            $this->addColumnIfMissing('criminal_fingerprints', 'deactivated_at', "TIMESTAMP NULL DEFAULT NULL");
            $this->addColumnIfMissing('criminal_fingerprints', 'deactivation_reason', "TEXT DEFAULT NULL");
            $this->addColumnIfMissing('applicant_fingerprints', 'fingerprint_image', "LONGTEXT DEFAULT NULL");
            $this->addColumnIfMissing('dataset_participants', 'criminal_record_id', "INT DEFAULT NULL");
            $this->addIndexIfMissing('dataset_participants', 'idx_dataset_criminal_record', ['criminal_record_id']);
            $this->addForeignKeyIfMissing(
                'dataset_participants',
                'fk_dataset_participant_criminal',
                'criminal_record_id',
                'criminal_records',
                'id'
            );
            $this->backfillCriminalActiveFlags();
            $this->backfillCriminalFingerprintHashes();
            $this->backfillDatasetCriminalLinks();

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
            'dataset_participants' => "
                CREATE TABLE IF NOT EXISTS dataset_participants (
                    id INT PRIMARY KEY AUTO_INCREMENT,
                    dataset_type VARCHAR(30) NOT NULL,
                    participant_number INT NOT NULL,
                    display_name VARCHAR(255) NOT NULL,
                    family_name VARCHAR(120) NOT NULL,
                    given_name VARCHAR(120) NOT NULL,
                    age INT DEFAULT NULL,
                    criminal_record_id INT DEFAULT NULL,
                    consent_given TINYINT(1) NOT NULL DEFAULT 0,
                    consented_at TIMESTAMP NULL DEFAULT NULL,
                    status VARCHAR(20) NOT NULL DEFAULT 'active',
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    completed_at TIMESTAMP NULL DEFAULT NULL,
                    UNIQUE KEY unique_dataset_participant (dataset_type, participant_number),
                    INDEX idx_dataset_participant_status (dataset_type, status, id),
                    INDEX idx_dataset_criminal_record (criminal_record_id),
                    FOREIGN KEY (criminal_record_id) REFERENCES criminal_records(id)
                )
            ",
            'dataset_fingerprint_samples' => "
                CREATE TABLE IF NOT EXISTS dataset_fingerprint_samples (
                    id INT PRIMARY KEY AUTO_INCREMENT,
                    participant_id INT NOT NULL,
                    dataset_type VARCHAR(30) NOT NULL,
                    filename VARCHAR(255) NOT NULL,
                    file_extension VARCHAR(12) NOT NULL,
                    finger_side VARCHAR(10) NOT NULL,
                    finger_name VARCHAR(20) NOT NULL,
                    finger_code VARCHAR(3) NOT NULL,
                    sample_number INT NOT NULL,
                    template LONGBLOB NOT NULL,
                    template_format VARCHAR(20) NOT NULL DEFAULT 'ISO',
                    original_image LONGTEXT NOT NULL,
                    image_format VARCHAR(20) NOT NULL DEFAULT 'png',
                    quality_score INT NOT NULL,
                    quality_label VARCHAR(20) NOT NULL,
                    scanner_source VARCHAR(255) DEFAULT NULL,
                    capture_hash CHAR(64) NOT NULL,
                    captured_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE KEY unique_dataset_filename (filename),
                    UNIQUE KEY unique_dataset_sample (dataset_type, finger_code, sample_number),
                    UNIQUE KEY unique_participant_capture (participant_id, finger_code, capture_hash),
                    INDEX idx_dataset_participant_finger (participant_id, finger_code, sample_number),
                    FOREIGN KEY (participant_id) REFERENCES dataset_participants(id)
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
                    comparison_id VARCHAR(160) DEFAULT NULL,
                    comparison_result LONGTEXT DEFAULT NULL,
                    notification_status VARCHAR(20) NOT NULL DEFAULT 'none',
                    notification_final_result VARCHAR(30) DEFAULT NULL,
                    notification_seen_at TIMESTAMP NULL DEFAULT NULL,
                    notification_read_at TIMESTAMP NULL DEFAULT NULL,
                    matched_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (applicant_id) REFERENCES applicants(id),
                    FOREIGN KEY (criminal_id) REFERENCES criminal_records(id)
                )
            ",
            'fingerprint_comparison_result_chunks' => "
                CREATE TABLE IF NOT EXISTS fingerprint_comparison_result_chunks (
                    match_id INT NOT NULL,
                    chunk_index INT NOT NULL,
                    payload MEDIUMBLOB NOT NULL,
                    PRIMARY KEY (match_id, chunk_index),
                    FOREIGN KEY (match_id) REFERENCES fingerprint_matches(id) ON DELETE CASCADE
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
            'fingerprint_comparison_result_chunks',
            'fingerprint_matches',
            'dataset_fingerprint_samples',
            'dataset_participants',
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

    private function addIndexIfMissing($table, $indexName, $columns) {
        $stmt = $this->db->prepare("
            SELECT COUNT(*) AS total
            FROM information_schema.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = ?
              AND INDEX_NAME = ?
        ");
        $stmt->execute([$table, $indexName]);
        if (intval($stmt->fetchColumn()) > 0) return;

        $quotedColumns = array_map([$this, 'quoteIdentifier'], $columns);
        $this->db->exec(sprintf(
            "ALTER TABLE %s ADD INDEX %s (%s)",
            $this->quoteIdentifier($table),
            $this->quoteIdentifier($indexName),
            implode(', ', $quotedColumns)
        ));
    }

    private function addForeignKeyIfMissing($table, $constraintName, $column, $referencedTable, $referencedColumn) {
        $stmt = $this->db->prepare("
            SELECT COUNT(*) AS total
            FROM information_schema.REFERENTIAL_CONSTRAINTS
            WHERE CONSTRAINT_SCHEMA = DATABASE()
              AND TABLE_NAME = ?
              AND CONSTRAINT_NAME = ?
        ");
        $stmt->execute([$table, $constraintName]);
        if (intval($stmt->fetchColumn()) > 0) return;

        $this->db->exec(sprintf(
            "ALTER TABLE %s ADD CONSTRAINT %s FOREIGN KEY (%s) REFERENCES %s (%s)",
            $this->quoteIdentifier($table),
            $this->quoteIdentifier($constraintName),
            $this->quoteIdentifier($column),
            $this->quoteIdentifier($referencedTable),
            $this->quoteIdentifier($referencedColumn)
        ));
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
    public static function normalizeDemographicName($name) {
        $value = strtolower(trim((string)$name));
        $value = preg_replace('/[^\p{L}\p{N}]+/u', ' ', $value);
        return trim(preg_replace('/\s+/u', ' ', (string)$value));
    }

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
            
            // Restrict the database query by stable demographic fields first.
            // Names are normalized in PHP so dashboard punctuation such as
            // "Family, First" cannot hide an equivalent stored record.
            $conditions[] = "cr.is_active = 1";
            
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
            $normalizedName = self::normalizeDemographicName($name);
            $results = array_values(array_filter($results, function($record) use ($normalizedName) {
                return self::normalizeDemographicName($record['name'] ?? '') === $normalizedName;
            }));
            
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
                !empty($privacyConsent['accepted'])
                    ? $this->normalizeDatabaseDateTime($privacyConsent['consented_at'] ?? null)
                    : null,
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
     * Convert browser ISO-8601 timestamps to the format accepted by MariaDB.
     * Existing database-formatted values are left unchanged for compatibility.
     */
    private function normalizeDatabaseDateTime($value) {
        $value = trim((string)$value);
        if ($value === '') {
            return gmdate('Y-m-d H:i:s');
        }

        if (preg_match('/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/', $value)) {
            return $value;
        }

        try {
            $timestamp = new DateTimeImmutable($value);
            return $timestamp
                ->setTimezone(new DateTimeZone('UTC'))
                ->format('Y-m-d H:i:s');
        } catch (Throwable $e) {
            return gmdate('Y-m-d H:i:s');
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
     * Return fingerprint metadata safe for JSON history views.
     * Binary templates and image payloads are intentionally excluded.
     */
    public function getApplicantFingerprintSummaries($applicantId = null) {
        if (!$this->db) return [];

        try {
            $sql = "
                SELECT
                    id,
                    applicant_id,
                    finger_position,
                    template_format,
                    quality_score,
                    submitted_at
                FROM applicant_fingerprints
            ";

            if ($applicantId !== null) {
                $sql .= " WHERE applicant_id = ? ORDER BY submitted_at DESC, id DESC";
                $stmt = $this->db->prepare($sql);
                $stmt->execute([intval($applicantId)]);
            } else {
                $sql .= " ORDER BY applicant_id, submitted_at DESC, id DESC";
                $stmt = $this->db->query($sql);
            }

            return $stmt->fetchAll(PDO::FETCH_ASSOC);
        } catch (PDOException $e) {
            error_log("Applicant fingerprint summary query error: " . $e->getMessage());
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
        $emptyStats = [
            'total' => 0,
            'approved' => 0,
            'rejected' => 0,
            'pending' => 0,
            'under_review' => 0,
            'flagged' => 0,
            'submitted_today' => 0,
            'submitted_last_7_days' => 0,
            'average_processing_hours' => 0.0,
            'approval_rate' => 0.0,
            'decision_rate' => 0.0,
            'fingerprint_completion_rate' => 0.0,
            'status_distribution' => [],
            'fingerprint_distribution' => [],
            'daily_trend' => [],
            'generated_at' => date('c')
        ];

        if (!$this->db) {
            return $emptyStats;
        }

        try {
            $row = $this->db->query("
                SELECT
                    COUNT(*) AS total,
                    SUM(CASE WHEN clearance_status = 'APPROVED' OR clearance_status = 'APPROVED_WITH_CAUTION' THEN 1 ELSE 0 END) AS approved,
                    SUM(CASE WHEN clearance_status = 'REJECTED' THEN 1 ELSE 0 END) AS rejected,
                    SUM(CASE WHEN clearance_status = 'PENDING' OR clearance_status = 'PENDING_FINGERPRINT' OR clearance_status IS NULL THEN 1 ELSE 0 END) AS pending,
                    SUM(CASE WHEN clearance_status = 'UNDER_REVIEW' THEN 1 ELSE 0 END) AS under_review,
                    SUM(CASE WHEN clearance_status = 'FLAGGED' THEN 1 ELSE 0 END) AS flagged,
                    SUM(CASE WHEN DATE(submitted_at) = CURDATE() THEN 1 ELSE 0 END) AS submitted_today,
                    SUM(CASE WHEN submitted_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY) THEN 1 ELSE 0 END) AS submitted_last_7_days,
                    SUM(CASE WHEN fingerprint_verification_status IN ('CONFIRMED_MATCH', 'CONFIRMED_NO_MATCH', 'NO_MATCH', 'CLEARED', 'MATCH') THEN 1 ELSE 0 END) AS fingerprint_completed,
                    ROUND(AVG(CASE
                        WHEN clearance_status IN ('APPROVED', 'APPROVED_WITH_CAUTION', 'REJECTED')
                            AND last_updated_at >= submitted_at
                        THEN TIMESTAMPDIFF(MINUTE, submitted_at, last_updated_at) / 60
                        ELSE NULL
                    END), 2) AS average_processing_hours
                FROM applicants
            ")->fetch(PDO::FETCH_ASSOC);

            $total = intval($row['total'] ?? 0);
            $approved = intval($row['approved'] ?? 0);
            $rejected = intval($row['rejected'] ?? 0);
            $pending = intval($row['pending'] ?? 0);
            $underReview = intval($row['under_review'] ?? 0);
            $flagged = intval($row['flagged'] ?? 0);
            $decided = $approved + $rejected;
            $fingerprintCompleted = intval($row['fingerprint_completed'] ?? 0);

            $fingerprintRows = $this->db->query("
                SELECT
                    COALESCE(NULLIF(fingerprint_verification_status, ''), 'NOT_STARTED') AS status,
                    COUNT(*) AS count
                FROM applicants
                GROUP BY fingerprint_verification_status
                ORDER BY count DESC, status ASC
            ")->fetchAll(PDO::FETCH_ASSOC);

            $trendRows = $this->db->query("
                SELECT
                    DATE_FORMAT(DATE(submitted_at), '%Y-%m-%d') AS date,
                    COUNT(*) AS total,
                    SUM(CASE WHEN clearance_status IN ('APPROVED', 'APPROVED_WITH_CAUTION') THEN 1 ELSE 0 END) AS approved,
                    SUM(CASE WHEN clearance_status = 'REJECTED' THEN 1 ELSE 0 END) AS rejected
                FROM applicants
                WHERE submitted_at >= DATE_SUB(CURDATE(), INTERVAL 13 DAY)
                GROUP BY DATE(submitted_at)
                ORDER BY DATE(submitted_at) ASC
            ")->fetchAll(PDO::FETCH_ASSOC);

            return [
                'total' => $total,
                'approved' => $approved,
                'rejected' => $rejected,
                'pending' => $pending,
                'under_review' => $underReview,
                'flagged' => $flagged,
                'submitted_today' => intval($row['submitted_today'] ?? 0),
                'submitted_last_7_days' => intval($row['submitted_last_7_days'] ?? 0),
                'average_processing_hours' => round(floatval($row['average_processing_hours'] ?? 0), 2),
                'approval_rate' => $decided > 0 ? round(($approved / $decided) * 100, 1) : 0.0,
                'decision_rate' => $total > 0 ? round(($decided / $total) * 100, 1) : 0.0,
                'fingerprint_completion_rate' => $total > 0 ? round(($fingerprintCompleted / $total) * 100, 1) : 0.0,
                'status_distribution' => [
                    ['key' => 'approved', 'label' => 'Approved', 'count' => $approved],
                    ['key' => 'rejected', 'label' => 'Rejected', 'count' => $rejected],
                    ['key' => 'pending', 'label' => 'Pending', 'count' => $pending],
                    ['key' => 'under_review', 'label' => 'Under Review', 'count' => $underReview],
                    ['key' => 'flagged', 'label' => 'Flagged', 'count' => $flagged]
                ],
                'fingerprint_distribution' => array_map(function ($item) {
                    return [
                        'status' => (string)($item['status'] ?? 'NOT_STARTED'),
                        'count' => intval($item['count'] ?? 0)
                    ];
                }, $fingerprintRows),
                'daily_trend' => array_map(function ($item) {
                    return [
                        'date' => (string)($item['date'] ?? ''),
                        'total' => intval($item['total'] ?? 0),
                        'approved' => intval($item['approved'] ?? 0),
                        'rejected' => intval($item['rejected'] ?? 0)
                    ];
                }, $trendRows),
                'generated_at' => date('c')
            ];
        } catch (PDOException $e) {
            error_log("Query error: " . $e->getMessage());
            return $emptyStats;
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
    public function recordMatchResult($applicantId, $criminalId, $finger, $score, $isMatch, $reviewStatus = null, $disclosureLevel = 'RESTRICTED', $comparisonResult = null) {
        if (!$this->db) {
            return [
                'success' => false,
                'error' => 'Database connection not available'
            ];
        }
        
        $ownsTransaction = false;
        try {
            if (method_exists($this->db, 'inTransaction') && !$this->db->inTransaction()) {
                $this->db->beginTransaction();
                $ownsTransaction = true;
            }

            $finalDecision = $this->normalizeComparisonDecision($comparisonResult);
            $notificationStatus = $finalDecision === 'MATCH' ? 'unread' : 'none';

            $comparisonId = is_array($comparisonResult)
                ? trim((string)($comparisonResult['comparisonId'] ?? $comparisonResult['traceId'] ?? ''))
                : '';
            $comparisonJson = is_array($comparisonResult)
                ? json_encode($comparisonResult, JSON_UNESCAPED_SLASHES)
                : null;
            if ($comparisonJson === false) {
                throw new RuntimeException('Fingerprint comparison result could not be encoded for persistence.');
            }

            $usesChunkStorage = is_string($comparisonJson)
                && strlen($comparisonJson) > self::COMPARISON_INLINE_LIMIT;
            $storedComparisonJson = $usesChunkStorage
                ? json_encode([
                    'storage' => 'fingerprint_comparison_result_chunks',
                    'schemaVersion' => $comparisonResult['schemaVersion'] ?? null,
                    'chunkCount' => intval(ceil(strlen($comparisonJson) / self::COMPARISON_CHUNK_SIZE))
                ], JSON_UNESCAPED_SLASHES)
                : $comparisonJson;

            $stmt = $this->db->prepare("
                INSERT INTO fingerprint_matches 
                (applicant_id, criminal_id, finger_matched, match_score, is_match, review_status, disclosure_level, comparison_id, comparison_result, notification_status, notification_final_result)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ");
            
            $stmt->execute([
                $applicantId,
                $criminalId,
                $finger,
                $score,
                $isMatch ? 1 : 0,
                $reviewStatus ?: ($isMatch ? 'PENDING_REVIEW' : 'CLEAR'),
                $disclosureLevel,
                $comparisonId !== '' ? $comparisonId : null,
                $storedComparisonJson,
                $notificationStatus,
                $finalDecision !== '' ? $finalDecision : null
            ]);

            $recordId = (string)$this->db->lastInsertId();
            if ($usesChunkStorage) {
                $this->storeComparisonResultChunks($recordId, $comparisonJson);
            }
            $notification = $notificationStatus === 'unread'
                ? $this->getFingerprintMatchNotificationById($recordId)
                : null;

            if ($ownsTransaction) {
                $this->db->commit();
            }

            if ($notification !== null) {
                error_log('[Backend] Notification saved');
                error_log('[Backend] Notification ID = ' . $notification['id']);
                error_log('[Backend] Comparison ID = ' . $notification['comparisonId']);
                error_log('[Backend] Result = ' . $notification['finalResult']);
                error_log('[Backend] Status = ' . $notification['status']);
            }
            
            return [
                'success' => true,
                'message' => 'Match result recorded',
                'record_id' => $recordId,
                'notification' => $notification,
                'comparison_storage' => $usesChunkStorage ? 'chunked' : 'inline'
            ];
        } catch (Throwable $e) {
            if ($ownsTransaction && method_exists($this->db, 'inTransaction') && $this->db->inTransaction()) {
                $this->db->rollBack();
            }
            error_log('[Backend] Match result persistence failed: ' . $e->getMessage());
            return [
                'success' => false,
                'error' => 'Database error: ' . $e->getMessage()
            ];
        }
    }

    private function storeComparisonResultChunks($matchId, $comparisonJson) {
        $stmt = $this->db->prepare("
            INSERT INTO fingerprint_comparison_result_chunks (match_id, chunk_index, payload)
            VALUES (?, ?, ?)
        ");
        $length = strlen($comparisonJson);
        $chunkIndex = 0;

        for ($offset = 0; $offset < $length; $offset += self::COMPARISON_CHUNK_SIZE) {
            $chunk = substr($comparisonJson, $offset, self::COMPARISON_CHUNK_SIZE);
            $stmt->bindValue(1, intval($matchId), PDO::PARAM_INT);
            $stmt->bindValue(2, $chunkIndex, PDO::PARAM_INT);
            $stmt->bindValue(3, $chunk, PDO::PARAM_LOB);
            $stmt->execute();
            $chunkIndex++;
        }
    }

    private function loadChunkedComparisonResult($matchId) {
        $stmt = $this->db->prepare("
            SELECT payload
            FROM fingerprint_comparison_result_chunks
            WHERE match_id = ?
            ORDER BY chunk_index ASC
        ");
        $stmt->execute([intval($matchId)]);
        $comparisonJson = '';
        while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
            $comparisonJson .= (string)($row['payload'] ?? '');
        }

        if ($comparisonJson === '') {
            return null;
        }

        $decoded = json_decode($comparisonJson, true);
        return is_array($decoded) ? $decoded : null;
    }

    private function normalizeComparisonDecision($comparisonResult) {
        if (!is_array($comparisonResult)) {
            return '';
        }

        return strtoupper(trim((string)($comparisonResult['finalResult']['decision'] ?? '')));
    }

    private function formatFingerprintMatchNotification($row) {
        if (!is_array($row) || empty($row)) {
            return null;
        }

        $status = strtolower(trim((string)($row['notification_status'] ?? 'none')));
        return [
            'id' => (string)($row['id'] ?? ''),
            'comparisonId' => (string)($row['comparison_id'] ?? ''),
            'type' => 'fingerprint_match',
            'status' => $status,
            'finalResult' => strtoupper(trim((string)($row['notification_final_result'] ?? ''))),
            'createdAt' => (string)($row['matched_at'] ?? ''),
            'viewed' => $status === 'read'
        ];
    }

    private function getFingerprintMatchNotificationById($notificationId) {
        if (!$this->db || intval($notificationId) <= 0) {
            return null;
        }

        $stmt = $this->db->prepare("
            SELECT id, comparison_id, notification_status, notification_final_result, matched_at
            FROM fingerprint_matches
            WHERE id = ?
              AND notification_status <> 'none'
            LIMIT 1
        ");
        $stmt->execute([intval($notificationId)]);
        return $this->formatFingerprintMatchNotification($stmt->fetch(PDO::FETCH_ASSOC));
    }

    public function getFingerprintMatchNotifications($state = 'active', $limit = 20) {
        if (!$this->db) {
            return [];
        }

        $normalizedState = strtolower(trim((string)$state));
        if ($normalizedState === 'unread') {
            $statusFilter = "notification_status = 'unread'";
        } elseif ($normalizedState === 'seen') {
            $statusFilter = "notification_status = 'seen'";
        } elseif ($normalizedState === 'read') {
            $statusFilter = "notification_status = 'read'";
        } elseif ($normalizedState === 'all') {
            $statusFilter = "notification_status <> 'none'";
        } else {
            $statusFilter = "notification_status IN ('unread', 'seen')";
        }

        try {
            $stmt = $this->db->prepare("
                SELECT id, comparison_id, notification_status, notification_final_result, matched_at
                FROM fingerprint_matches
                WHERE {$statusFilter}
                  AND notification_final_result = 'MATCH'
                ORDER BY matched_at DESC, id DESC
                LIMIT ?
            ");
            $stmt->bindValue(1, max(1, min(100, intval($limit))), PDO::PARAM_INT);
            $stmt->execute();
            return array_values(array_filter(array_map(
                function ($row) {
                    return $this->formatFingerprintMatchNotification($row);
                },
                $stmt->fetchAll(PDO::FETCH_ASSOC)
            )));
        } catch (PDOException $e) {
            error_log('Fingerprint notification query error: ' . $e->getMessage());
            return [];
        }
    }

    public function updateFingerprintMatchNotificationStatus($notificationId, $status) {
        if (!$this->db) {
            return ['success' => false, 'error' => 'Database connection not available'];
        }

        $notificationId = intval($notificationId);
        $status = strtolower(trim((string)$status));
        if ($notificationId <= 0 || !in_array($status, ['seen', 'read'], true)) {
            return ['success' => false, 'error' => 'Invalid notification update.'];
        }

        try {
            if ($status === 'seen') {
                $stmt = $this->db->prepare("
                    UPDATE fingerprint_matches
                    SET notification_status = CASE WHEN notification_status = 'unread' THEN 'seen' ELSE notification_status END,
                        notification_seen_at = CASE WHEN notification_status = 'unread' THEN COALESCE(notification_seen_at, CURRENT_TIMESTAMP) ELSE notification_seen_at END
                    WHERE id = ?
                      AND notification_status IN ('unread', 'seen')
                ");
            } else {
                $stmt = $this->db->prepare("
                    UPDATE fingerprint_matches
                    SET notification_status = 'read',
                        notification_seen_at = COALESCE(notification_seen_at, CURRENT_TIMESTAMP),
                        notification_read_at = COALESCE(notification_read_at, CURRENT_TIMESTAMP)
                    WHERE id = ?
                      AND notification_status IN ('unread', 'seen', 'read')
                ");
            }
            $stmt->execute([$notificationId]);
            $notification = $this->getFingerprintMatchNotificationById($notificationId);

            return [
                'success' => $notification !== null,
                'notification' => $notification,
                'updated_rows' => intval($stmt->rowCount())
            ];
        } catch (PDOException $e) {
            return ['success' => false, 'error' => 'Database error: ' . $e->getMessage()];
        }
    }

    public function getComparisonResultByComparisonId($comparisonId) {
        if (!$this->db) {
            return null;
        }

        $comparisonId = trim((string)$comparisonId);
        if ($comparisonId === '') {
            return null;
        }

        try {
            $stmt = $this->db->prepare("
                SELECT
                    fm.id,
                    fm.applicant_id,
                    fm.criminal_id,
                    fm.finger_matched,
                    fm.match_score,
                    fm.is_match,
                    fm.comparison_id,
                    fm.comparison_result,
                    fm.review_status,
                    fm.matched_at,
                    a.name AS applicant_name,
                    cr.name AS reference_name
                FROM fingerprint_matches fm
                LEFT JOIN applicants a ON a.id = fm.applicant_id
                LEFT JOIN criminal_records cr ON cr.id = fm.criminal_id
                WHERE fm.comparison_id = ?
                ORDER BY fm.id DESC
                LIMIT 1
            ");
            $stmt->execute([$comparisonId]);
            $rows = $this->decodeComparisonResultRows([$stmt->fetch(PDO::FETCH_ASSOC) ?: []]);
            return !empty($rows[0]) ? $rows[0] : null;
        } catch (PDOException $e) {
            error_log('Fingerprint comparison lookup error: ' . $e->getMessage());
            return null;
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
                    SELECT
                        fm.id,
                        fm.applicant_id,
                        fm.criminal_id,
                        fm.finger_matched,
                        fm.match_score,
                        fm.is_match,
                        fm.review_status,
                        fm.review_outcome,
                        fm.review_notes,
                        fm.reviewed_at,
                        fm.disclosure_level,
                        fm.comparison_id,
                        fm.notification_status,
                        fm.notification_final_result,
                        fm.notification_seen_at,
                        fm.notification_read_at,
                        fm.matched_at,
                        cr.name AS criminal_name
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
            // Application history is summary-only. The selected comparison is
            // loaded by comparison_id when the user opens its result. This
            // avoids decoding every stored fingerprint image for one modal.
            return $stmt->fetchAll(PDO::FETCH_ASSOC);
        } catch (PDOException $e) {
            error_log("Query error: " . $e->getMessage());
            return [];
        }
    }

    private function decodeComparisonResultRows($rows) {
        return array_map(function ($row) {
            if (!array_key_exists('comparison_result', $row)) {
                return $row;
            }

            $decoded = null;
            if (is_string($row['comparison_result']) && trim($row['comparison_result']) !== '') {
                $candidate = json_decode($row['comparison_result'], true);
                $decoded = is_array($candidate) ? $candidate : null;
                if (($decoded['storage'] ?? '') === 'fingerprint_comparison_result_chunks') {
                    $decoded = $this->loadChunkedComparisonResult($row['id'] ?? 0);
                }
            }
            $row['comparison_result'] = $decoded;
            return $row;
        }, is_array($rows) ? $rows : []);
    }

    public function getComparisonHistory($limit = 50) {
        if (!$this->db) {
            return [];
        }

        try {
            $stmt = $this->db->prepare("
                SELECT
                    fm.id,
                    fm.applicant_id,
                    fm.criminal_id,
                    fm.finger_matched,
                    fm.match_score,
                    fm.is_match,
                    fm.comparison_id,
                    fm.review_status,
                    fm.notification_final_result,
                    fm.matched_at,
                    a.name AS applicant_name,
                    cr.name AS reference_name
                FROM fingerprint_matches fm
                LEFT JOIN applicants a ON a.id = fm.applicant_id
                LEFT JOIN criminal_records cr ON cr.id = fm.criminal_id
                WHERE fm.comparison_id IS NOT NULL
                  AND fm.comparison_id <> ''
                ORDER BY fm.matched_at DESC, fm.id DESC
                LIMIT ?
            ");
            $stmt->bindValue(1, max(1, min(200, intval($limit))), PDO::PARAM_INT);
            $stmt->execute();
            // History is intentionally summary-only. Decoding dozens of
            // multi-megabyte image payloads can exhaust PHP memory before the
            // admin page has a chance to request one selected comparison.
            return $stmt->fetchAll(PDO::FETCH_ASSOC);
        } catch (PDOException $e) {
            error_log("Fingerprint comparison history query error: " . $e->getMessage());
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

    private function normalizeDatasetType($datasetType) {
        $value = strtolower(trim((string)$datasetType));
        if ($value === 'criminal') {
            $value = 'criminal_reference';
        }
        return in_array($value, ['applicant', 'criminal_reference'], true) ? $value : null;
    }

    private function normalizeDatasetExtension($extension) {
        $value = strtolower(trim((string)$extension));
        $value = preg_replace('/^image\//', '', $value);
        $value = ltrim($value, '.');
        if ($value === 'jpeg') $value = 'jpg';
        if ($value === 'tiff') $value = 'tif';
        return in_array($value, ['png', 'bmp', 'jpg', 'tif', 'wsq'], true) ? $value : 'png';
    }

    private function datasetFilename($datasetType, $fingerCode, $sampleNumber, $extension) {
        $prefix = $datasetType === 'applicant' ? 'pt' : 'c';
        return $prefix . $fingerCode . intval($sampleNumber) . '.' . $this->normalizeDatasetExtension($extension);
    }

    public function getCurrentDatasetParticipant($datasetType) {
        $datasetType = $this->normalizeDatasetType($datasetType);
        if (!$this->db || !$datasetType) return null;

        $stmt = $this->db->prepare("
            SELECT id, dataset_type, participant_number, display_name, family_name, given_name,
                   age, criminal_record_id, consent_given, consented_at, status, created_at, completed_at
            FROM dataset_participants
            WHERE dataset_type = ? AND status = 'active'
            ORDER BY id DESC
            LIMIT 1
        ");
        $stmt->execute([$datasetType]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        return $row ?: null;
    }

    public function getDatasetParticipants($datasetType, $search = '', $page = 1, $pageSize = 40) {
        $datasetType = $this->normalizeDatasetType($datasetType);
        if (!$this->db || !$datasetType) {
            return ['success' => false, 'error' => 'Invalid dataset type.'];
        }

        $page = max(1, intval($page));
        $pageSize = max(1, min(100, intval($pageSize)));
        $search = trim((string)$search);
        $where = 'dp.dataset_type = ?';
        $params = [$datasetType];
        if ($search !== '') {
            $where .= " AND (dp.display_name LIKE ? OR CAST(dp.participant_number AS CHAR) LIKE ? OR COALESCE(cr.case_number, '') LIKE ?)";
            $term = '%' . $search . '%';
            array_push($params, $term, $term, $term);
        }

        try {
            $countStmt = $this->db->prepare("
                SELECT COUNT(*)
                FROM dataset_participants dp
                LEFT JOIN criminal_records cr ON cr.id = dp.criminal_record_id
                WHERE $where
            ");
            $countStmt->execute($params);
            $total = intval($countStmt->fetchColumn());
            $totalPages = max(1, intval(ceil($total / $pageSize)));
            $page = min($page, $totalPages);
            $offset = ($page - 1) * $pageSize;

            $stmt = $this->db->prepare("
                SELECT dp.id, dp.dataset_type, dp.participant_number, dp.display_name,
                       dp.age, dp.criminal_record_id, dp.consent_given, dp.status,
                       dp.created_at, dp.completed_at, cr.case_number, cr.sex AS sex,
                       (SELECT COUNT(*) FROM dataset_fingerprint_samples dfs WHERE dfs.participant_id = dp.id) AS sample_count,
                       (SELECT COUNT(DISTINCT dfs.finger_code) FROM dataset_fingerprint_samples dfs WHERE dfs.participant_id = dp.id) AS collected_finger_count
                FROM dataset_participants dp
                LEFT JOIN criminal_records cr ON cr.id = dp.criminal_record_id
                WHERE $where
                ORDER BY dp.participant_number DESC
                LIMIT $pageSize OFFSET $offset
            ");
            $stmt->execute($params);

            return [
                'success' => true,
                'participants' => $stmt->fetchAll(PDO::FETCH_ASSOC),
                'pagination' => [
                    'page' => $page,
                    'page_size' => $pageSize,
                    'total' => $total,
                    'total_pages' => $totalPages
                ]
            ];
        } catch (Throwable $e) {
            return ['success' => false, 'error' => 'Database error: ' . $e->getMessage()];
        }
    }

    public function getDatasetParticipantDetails($datasetType, $participantId) {
        $datasetType = $this->normalizeDatasetType($datasetType);
        $participantId = intval($participantId);
        if (!$this->db || !$datasetType || $participantId <= 0) {
            return ['success' => false, 'error' => 'Invalid dataset participant.'];
        }

        try {
            $participantStmt = $this->db->prepare("
                SELECT dp.id, dp.dataset_type, dp.participant_number, dp.display_name,
                       dp.family_name, dp.given_name, dp.age, dp.criminal_record_id,
                       dp.consent_given, dp.consented_at, dp.status, dp.created_at,
                       dp.completed_at, cr.case_number, cr.sex AS sex
                FROM dataset_participants dp
                LEFT JOIN criminal_records cr ON cr.id = dp.criminal_record_id
                WHERE dp.id = ? AND dp.dataset_type = ?
                LIMIT 1
            ");
            $participantStmt->execute([$participantId, $datasetType]);
            $participant = $participantStmt->fetch(PDO::FETCH_ASSOC);
            if (!$participant) {
                return ['success' => false, 'error' => 'Dataset participant not found.', 'code' => 'DATASET_PARTICIPANT_NOT_FOUND'];
            }

            $sampleStmt = $this->db->prepare("
                SELECT id, filename, file_extension, finger_side, finger_name,
                       finger_code, sample_number, original_image, image_format,
                       quality_score, quality_label, scanner_source, captured_at, created_at
                FROM dataset_fingerprint_samples
                WHERE participant_id = ?
                ORDER BY FIELD(finger_code, 'rth', 'rin', 'rmi', 'rri', 'rpi', 'lth', 'lin', 'lmi', 'lri', 'lpi'), sample_number ASC
            ");
            $sampleStmt->execute([$participantId]);

            return [
                'success' => true,
                'participant' => $participant,
                'samples' => $sampleStmt->fetchAll(PDO::FETCH_ASSOC)
            ];
        } catch (Throwable $e) {
            return ['success' => false, 'error' => 'Database error: ' . $e->getMessage()];
        }
    }

    private function datasetCriminalCaseNumber($participantNumber, $createdAt = null) {
        $timestamp = $createdAt ? strtotime((string)$createdAt) : false;
        $year = $timestamp ? date('Y', $timestamp) : date('Y');
        return 'CASE-' . $year . '-' . intval($participantNumber);
    }

    private function datasetCriminalSex($value = null) {
        $normalized = strtoupper(substr(trim((string)$value), 0, 1));
        if (in_array($normalized, ['M', 'F'], true)) return $normalized;
        return random_int(0, 1) === 0 ? 'M' : 'F';
    }

    private function ensureSyntheticCriminalRecord($participantNumber, $displayName, $age, $createdAt = null) {
        $participantNumber = intval($participantNumber);
        $caseNumber = $this->datasetCriminalCaseNumber($participantNumber, $createdAt);
        $sex = $this->datasetCriminalSex();

        $caseStmt = $this->db->prepare("
            SELECT id FROM criminal_records
            WHERE case_number = ?
            ORDER BY id ASC
            LIMIT 1
        ");
        $caseStmt->execute([$caseNumber]);
        $existingByCase = intval($caseStmt->fetchColumn());
        if ($existingByCase > 0) return $existingByCase;

        $idStmt = $this->db->prepare('SELECT id, name, sex FROM criminal_records WHERE id = ? LIMIT 1');
        $idStmt->execute([$participantNumber]);
        $existingById = $idStmt->fetch(PDO::FETCH_ASSOC);
        $requestedIdAvailable = !$existingById;

        if ($existingById && strcasecmp(trim((string)$existingById['name']), trim((string)$displayName)) === 0) {
            $sex = $this->datasetCriminalSex($existingById['sex'] ?? null);
            $update = $this->db->prepare('UPDATE criminal_records SET case_number = ?, sex = ?, is_active = 1 WHERE id = ?');
            $update->execute([$caseNumber, $sex, intval($existingById['id'])]);
            return intval($existingById['id']);
        }

        if ($requestedIdAvailable) {
            $insert = $this->db->prepare("
                INSERT INTO criminal_records (id, name, age, sex, case_number, is_active)
                VALUES (?, ?, ?, ?, ?, 1)
            ");
            $insert->execute([$participantNumber, $displayName, intval($age), $sex, $caseNumber]);
            return $participantNumber;
        }

        $insert = $this->db->prepare("
            INSERT INTO criminal_records (name, age, sex, case_number, is_active)
            VALUES (?, ?, ?, ?, 1)
        ");
        $insert->execute([$displayName, intval($age), $sex, $caseNumber]);
        return intval($this->db->lastInsertId());
    }

    private function datasetFingerPosition($fingerCode) {
        $positions = [
            'rth' => 'RIGHT_THUMB',
            'rin' => 'RIGHT_INDEX',
            'rmi' => 'RIGHT_MIDDLE',
            'rri' => 'RIGHT_RING',
            'rpi' => 'RIGHT_PINKY',
            'lth' => 'LEFT_THUMB',
            'lin' => 'LEFT_INDEX',
            'lmi' => 'LEFT_MIDDLE',
            'lri' => 'LEFT_RING',
            'lpi' => 'LEFT_PINKY'
        ];
        return $positions[strtolower(trim((string)$fingerCode))] ?? null;
    }

    public function syncDatasetCriminalParticipant($participantId) {
        if (!$this->db) return ['success' => false, 'error' => 'Database connection not available'];

        try {
            $participantStmt = $this->db->prepare("
                SELECT id, participant_number, display_name, age, criminal_record_id, created_at
                FROM dataset_participants
                WHERE id = ? AND dataset_type = 'criminal_reference'
                LIMIT 1
            ");
            $participantStmt->execute([intval($participantId)]);
            $participant = $participantStmt->fetch(PDO::FETCH_ASSOC);
            if (!$participant) {
                return ['success' => false, 'error' => 'Synthetic reference participant not found.'];
            }

            $criminalRecordId = intval($participant['criminal_record_id'] ?? 0);
            if ($criminalRecordId <= 0) {
                $criminalRecordId = $this->ensureSyntheticCriminalRecord(
                    $participant['participant_number'],
                    $participant['display_name'],
                    $participant['age'],
                    $participant['created_at'] ?? null
                );
                $linkStmt = $this->db->prepare("
                    UPDATE dataset_participants
                    SET criminal_record_id = ?
                    WHERE id = ?
                ");
                $linkStmt->execute([$criminalRecordId, intval($participantId)]);
            }

            $caseNumber = $this->datasetCriminalCaseNumber(
                $participant['participant_number'],
                $participant['created_at'] ?? null
            );
            $sexStmt = $this->db->prepare('SELECT sex FROM criminal_records WHERE id = ? LIMIT 1');
            $sexStmt->execute([$criminalRecordId]);
            $sex = $this->datasetCriminalSex($sexStmt->fetchColumn());
            $caseStmt = $this->db->prepare('UPDATE criminal_records SET case_number = ?, sex = ? WHERE id = ?');
            $caseStmt->execute([$caseNumber, $sex, $criminalRecordId]);

            $existingStmt = $this->db->prepare("
                SELECT finger_position
                FROM criminal_fingerprints
                WHERE criminal_id = ? AND is_active = 1
            ");
            $existingStmt->execute([$criminalRecordId]);
            $existingPositions = array_fill_keys($existingStmt->fetchAll(PDO::FETCH_COLUMN), true);

            $sampleStmt = $this->db->prepare("
                SELECT finger_code, template, template_format, original_image, filename, quality_score
                FROM dataset_fingerprint_samples
                WHERE participant_id = ?
                ORDER BY sample_number ASC, id ASC
            ");
            $sampleStmt->execute([intval($participantId)]);
            $enrolled = [];
            $errors = [];
            foreach ($sampleStmt->fetchAll(PDO::FETCH_ASSOC) as $sample) {
                $position = $this->datasetFingerPosition($sample['finger_code'] ?? '');
                if (!$position || isset($existingPositions[$position])) continue;

                $stored = $this->storeCriminalFingerprint(
                    $criminalRecordId,
                    $position,
                    $sample['template'],
                    $sample['template_format'] ?? 'ISO',
                    intval($sample['quality_score'] ?? 0),
                    $sample['original_image'] ?? null,
                    $sample['filename'] ?? null
                );
                if (!empty($stored['success'])) {
                    $existingPositions[$position] = true;
                    $enrolled[] = $position;
                } else {
                    $errors[] = [
                        'finger_position' => $position,
                        'error' => $stored['error'] ?? 'Operational fingerprint enrollment failed.'
                    ];
                }
            }

            return [
                'success' => true,
                'criminal_record_id' => $criminalRecordId,
                'enrolled_finger_positions' => $enrolled,
                'enrollment_errors' => $errors
            ];
        } catch (Throwable $e) {
            return ['success' => false, 'error' => 'Database error: ' . $e->getMessage()];
        }
    }

    private function backfillDatasetCriminalLinks() {
        if (!$this->db || !$this->columnExists('dataset_participants', 'criminal_record_id')) return;
        $stmt = $this->db->query("
            SELECT id
            FROM dataset_participants
            WHERE dataset_type = 'criminal_reference'
            ORDER BY participant_number ASC
        ");
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $participantId) {
            $result = $this->syncDatasetCriminalParticipant(intval($participantId));
            if (empty($result['success'])) {
                error_log('Dataset criminal link backfill failed for participant ' . intval($participantId) . ': ' . ($result['error'] ?? 'unknown error'));
            }
        }
    }

    public function createDatasetParticipant($datasetType, $consentGiven = false) {
        $datasetType = $this->normalizeDatasetType($datasetType);
        if (!$this->db || !$datasetType) {
            return ['success' => false, 'error' => 'Invalid dataset type.'];
        }
        if ($datasetType === 'applicant' && !$consentGiven) {
            return ['success' => false, 'error' => 'Explicit participant consent is required.', 'code' => 'CONSENT_REQUIRED'];
        }

        try {
            $this->db->beginTransaction();
            $activeStmt = $this->db->prepare("
                SELECT id FROM dataset_participants
                WHERE dataset_type = ? AND status = 'active'
                FOR UPDATE
            ");
            $activeStmt->execute([$datasetType]);
            $activeIds = array_map('intval', $activeStmt->fetchAll(PDO::FETCH_COLUMN));
            if (!empty($activeIds)) {
                $placeholders = implode(',', array_fill(0, count($activeIds), '?'));
                $finishStmt = $this->db->prepare("
                    UPDATE dataset_participants
                    SET status = 'completed', completed_at = CURRENT_TIMESTAMP
                    WHERE id IN ($placeholders)
                ");
                $finishStmt->execute($activeIds);
            }

            if ($datasetType === 'criminal_reference') {
                $maxStmt = $this->db->query("
                    SELECT GREATEST(300,
                        COALESCE((SELECT MAX(id) FROM criminal_records), 0),
                        COALESCE((SELECT MAX(participant_number) FROM dataset_participants WHERE dataset_type = 'criminal_reference'), 0)
                    ) AS maximum_number
                ");
                $maximum = intval($maxStmt->fetchColumn());
            } else {
                $maxStmt = $this->db->prepare("
                    SELECT COALESCE(MAX(participant_number), 0)
                    FROM dataset_participants
                    WHERE dataset_type = ?
                ");
                $maxStmt->execute([$datasetType]);
                $maximum = intval($maxStmt->fetchColumn());
            }

            $participantNumber = $maximum + 1;
            $isCriminalReference = $datasetType === 'criminal_reference';
            $familyName = $isCriminalReference ? 'Applicant' : 'Participant';
            $givenName = (string)$participantNumber;
            $displayName = $familyName . ' ' . $givenName;
            $age = $isCriminalReference ? random_int(19, 65) : null;
            $criminalRecordId = $isCriminalReference
                ? $this->ensureSyntheticCriminalRecord($participantNumber, $displayName, $age)
                : null;
            $consentedAt = $consentGiven ? date('Y-m-d H:i:s') : null;

            $insert = $this->db->prepare("
                INSERT INTO dataset_participants
                    (dataset_type, participant_number, display_name, family_name, given_name, age, criminal_record_id, consent_given, consented_at, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
            ");
            $insert->execute([
                $datasetType,
                $participantNumber,
                $displayName,
                $familyName,
                $givenName,
                $age,
                $criminalRecordId,
                $consentGiven ? 1 : 0,
                $consentedAt
            ]);
            $participantId = intval($this->db->lastInsertId());
            $this->db->commit();

            return [
                'success' => true,
                'participant' => [
                    'id' => $participantId,
                    'dataset_type' => $datasetType,
                    'participant_number' => $participantNumber,
                    'display_name' => $displayName,
                    'family_name' => $familyName,
                    'given_name' => $givenName,
                    'age' => $age,
                    'criminal_record_id' => $criminalRecordId,
                    'consent_given' => $consentGiven ? 1 : 0,
                    'consented_at' => $consentedAt,
                    'status' => 'active'
                ]
            ];
        } catch (Throwable $e) {
            if ($this->db->inTransaction()) $this->db->rollBack();
            return ['success' => false, 'error' => 'Database error: ' . $e->getMessage()];
        }
    }

    public function getNextDatasetSampleNumber($datasetType, $fingerCode) {
        $datasetType = $this->normalizeDatasetType($datasetType);
        if (!$this->db || !$datasetType) return 1;
        $stmt = $this->db->prepare("
            SELECT COALESCE(MAX(sample_number), 0) + 1
            FROM dataset_fingerprint_samples
            WHERE dataset_type = ? AND finger_code = ?
        ");
        $stmt->execute([$datasetType, strtolower(trim((string)$fingerCode))]);
        return max(1, intval($stmt->fetchColumn()));
    }

    public function getDatasetCollectionState($datasetType, $participantId = null, $fingerCode = 'rth', $extension = 'png') {
        $datasetType = $this->normalizeDatasetType($datasetType);
        if (!$this->db || !$datasetType) {
            return ['success' => false, 'error' => 'Invalid dataset type.'];
        }

        $participant = null;
        if ($participantId) {
            $stmt = $this->db->prepare("
                SELECT id, dataset_type, participant_number, display_name, family_name, given_name,
                       age, criminal_record_id, consent_given, consented_at, status, created_at, completed_at
                FROM dataset_participants
                WHERE id = ? AND dataset_type = ?
                LIMIT 1
            ");
            $stmt->execute([intval($participantId), $datasetType]);
            $participant = $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
        } else {
            $participant = $this->getCurrentDatasetParticipant($datasetType);
        }

        $samples = [];
        if ($participant) {
            $sampleStmt = $this->db->prepare("
                SELECT id, filename, finger_side, finger_name, finger_code, sample_number,
                       file_extension, image_format, quality_score, quality_label, scanner_source,
                       captured_at, created_at
                FROM dataset_fingerprint_samples
                WHERE participant_id = ?
                ORDER BY finger_side DESC, finger_code, sample_number
            ");
            $sampleStmt->execute([intval($participant['id'])]);
            $samples = $sampleStmt->fetchAll(PDO::FETCH_ASSOC);
        }

        $sampleNumber = $this->getNextDatasetSampleNumber($datasetType, $fingerCode);
        $collectedCodes = [];
        foreach ($samples as $sample) {
            $collectedCodes[(string)$sample['finger_code']] = true;
        }

        return [
            'success' => true,
            'mode' => $datasetType === 'applicant' ? 'applicant' : 'criminal',
            'dataset_type' => $datasetType,
            'participant' => $participant,
            'samples' => $samples,
            'collected_finger_codes' => array_keys($collectedCodes),
            'collected_finger_count' => count($collectedCodes),
            'next_sample_number' => $sampleNumber,
            'next_filename' => $this->datasetFilename($datasetType, strtolower(trim((string)$fingerCode)), $sampleNumber, $extension)
        ];
    }

    public function storeDatasetFingerprintSample($participantId, $datasetType, $finger, $template, $templateFormat, $originalImage, $imageFormat, $qualityScore, $qualityLabel, $scannerSource, $capturedAt = null) {
        $datasetType = $this->normalizeDatasetType($datasetType);
        if (!$this->db || !$datasetType) {
            return ['success' => false, 'error' => 'Invalid dataset type.'];
        }

        $fingerCode = strtolower(trim((string)($finger['code'] ?? '')));
        $extension = $this->normalizeDatasetExtension($imageFormat);
        $captureHash = hash('sha256', (string)$originalImage);
        $lockName = 'minutiae_dataset_' . $datasetType . '_' . $fingerCode;

        try {
            $lockStmt = $this->db->prepare('SELECT GET_LOCK(?, 5)');
            $lockStmt->execute([$lockName]);
            if (intval($lockStmt->fetchColumn()) !== 1) {
                return ['success' => false, 'error' => 'Dataset filename allocation is busy. Please try again.', 'code' => 'DATASET_LOCK_TIMEOUT'];
            }

            $participantStmt = $this->db->prepare("
                SELECT id, dataset_type, display_name, status
                FROM dataset_participants
                WHERE id = ? AND dataset_type = ?
                LIMIT 1
            ");
            $participantStmt->execute([intval($participantId), $datasetType]);
            $participant = $participantStmt->fetch(PDO::FETCH_ASSOC);
            if (!$participant || $participant['status'] !== 'active') {
                return ['success' => false, 'error' => 'The selected dataset participant is not active.', 'code' => 'PARTICIPANT_NOT_ACTIVE'];
            }

            $duplicateStmt = $this->db->prepare("
                SELECT id, filename
                FROM dataset_fingerprint_samples
                WHERE participant_id = ? AND finger_code = ? AND capture_hash = ?
                LIMIT 1
            ");
            $duplicateStmt->execute([intval($participantId), $fingerCode, $captureHash]);
            $duplicate = $duplicateStmt->fetch(PDO::FETCH_ASSOC);
            if ($duplicate) {
                return [
                    'success' => false,
                    'error' => 'This exact scanner capture is already stored for the selected participant and finger.',
                    'code' => 'DUPLICATE_DATASET_CAPTURE',
                    'existing_filename' => $duplicate['filename']
                ];
            }

            $sampleNumber = $this->getNextDatasetSampleNumber($datasetType, $fingerCode);
            $filename = $this->datasetFilename($datasetType, $fingerCode, $sampleNumber, $extension);
            $captureTimestamp = $capturedAt && strtotime((string)$capturedAt)
                ? date('Y-m-d H:i:s', strtotime((string)$capturedAt))
                : date('Y-m-d H:i:s');
            $insert = $this->db->prepare("
                INSERT INTO dataset_fingerprint_samples
                    (participant_id, dataset_type, filename, file_extension, finger_side, finger_name,
                     finger_code, sample_number, template, template_format, original_image, image_format,
                     quality_score, quality_label, scanner_source, capture_hash, captured_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ");
            $insert->execute([
                intval($participantId),
                $datasetType,
                $filename,
                $extension,
                strtolower((string)($finger['side'] ?? '')),
                strtolower((string)($finger['name'] ?? '')),
                $fingerCode,
                $sampleNumber,
                $template,
                strtoupper(substr((string)$templateFormat, 0, 20)),
                $originalImage,
                $extension,
                intval($qualityScore),
                $qualityLabel,
                substr((string)$scannerSource, 0, 255),
                $captureHash,
                $captureTimestamp
            ]);

            $sampleId = intval($this->db->lastInsertId());
            $operationalEnrollment = null;
            if ($datasetType === 'criminal_reference') {
                // Keep every research capture append-only, but expose the first accepted
                // sample for each finger through the application's existing criminal search.
                $operationalEnrollment = $this->syncDatasetCriminalParticipant(intval($participantId));
            }

            return [
                'success' => true,
                'operational_enrollment' => $operationalEnrollment,
                'sample' => [
                    'id' => $sampleId,
                    'participant_id' => intval($participantId),
                    'filename' => $filename,
                    'finger_side' => strtolower((string)($finger['side'] ?? '')),
                    'finger_name' => strtolower((string)($finger['name'] ?? '')),
                    'finger_code' => $fingerCode,
                    'sample_number' => $sampleNumber,
                    'quality_score' => intval($qualityScore),
                    'quality_label' => $qualityLabel,
                    'captured_at' => $captureTimestamp
                ]
            ];
        } catch (Throwable $e) {
            return ['success' => false, 'error' => 'Database error: ' . $e->getMessage()];
        } finally {
            try {
                $releaseStmt = $this->db->prepare('SELECT RELEASE_LOCK(?)');
                $releaseStmt->execute([$lockName]);
            } catch (Throwable $ignored) {
            }
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
