<?php
declare(strict_types=1);

require_once __DIR__ . '/backend/FingerprintDB.php';

if (PHP_SAPI !== 'cli') {
    require_once __DIR__ . '/backend/auth.php';
    $auth = new MinutiaeAuth();
    $auth->requireRole(['admin', 'super_admin'], 'run_criminal_seeder', 'system');
}

header('Content-Type: text/plain; charset=UTF-8');

function numberToWords(int $number): string
{
    if ($number < 1 || $number > 300) {
        throw new InvalidArgumentException('Number out of supported range (1-300).');
    }

    $ones = [
        0 => '',
        1 => 'One',
        2 => 'Two',
        3 => 'Three',
        4 => 'Four',
        5 => 'Five',
        6 => 'Six',
        7 => 'Seven',
        8 => 'Eight',
        9 => 'Nine',
        10 => 'Ten',
        11 => 'Eleven',
        12 => 'Twelve',
        13 => 'Thirteen',
        14 => 'Fourteen',
        15 => 'Fifteen',
        16 => 'Sixteen',
        17 => 'Seventeen',
        18 => 'Eighteen',
        19 => 'Nineteen'
    ];

    $tens = [
        2 => 'Twenty',
        3 => 'Thirty',
        4 => 'Forty',
        5 => 'Fifty',
        6 => 'Sixty',
        7 => 'Seventy',
        8 => 'Eighty',
        9 => 'Ninety'
    ];

    if ($number < 20) {
        return $ones[$number];
    }

    if ($number < 100) {
        $tenPart = intdiv($number, 10);
        $onePart = $number % 10;
        return trim($tens[$tenPart] . ' ' . $ones[$onePart]);
    }

    if ($number < 300) {
        $remainder = $number - 100;
        return $remainder > 0
            ? 'One Hundred ' . numberToWords($remainder)
            : 'One Hundred';
    }

    return 'Three Hundred';
}

function buildPdoFromConfig(): PDO
{
    $config = require __DIR__ . '/backend/config.php';
    $db = $config['database'] ?? [];

    $dsn = sprintf(
        'mysql:host=%s;port=%d;dbname=%s;charset=%s',
        $db['host'] ?? 'localhost',
        intval($db['port'] ?? 3306),
        $db['database'] ?? 'minutiae_runtime',
        $db['charset'] ?? 'utf8mb4'
    );

    return new PDO(
        $dsn,
        $db['user'] ?? 'root',
        $db['password'] ?? '',
        [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC
        ]
    );
}

try {
    $pdo = buildPdoFromConfig();
    new FingerprintDB($pdo);

    $selectStmt = $pdo->prepare("
        SELECT id
        FROM criminal_records
        WHERE case_number = ?
        ORDER BY id ASC
        LIMIT 1
    ");
    $insertStmt = $pdo->prepare("
        INSERT INTO criminal_records (name, age, sex, case_number)
        VALUES (?, ?, ?, ?)
    ");
    $updateStmt = $pdo->prepare("
        UPDATE criminal_records
        SET
            name = ?,
            age = ?,
            sex = ?,
            case_number = ?,
            is_active = 1,
            deleted_at = NULL,
            deletion_reason = NULL
        WHERE id = ?
    ");

    $inserted = 0;
    $updated = 0;
    $preview = [];

    $pdo->beginTransaction();

    for ($i = 1; $i <= 300; $i++) {
        $familyName = 'Applicant';
        $firstName = numberToWords($i);
        $fullName = $familyName . ', ' . $firstName;
        $age = random_int(18, 60);
        $sexLabel = random_int(0, 1) === 0 ? 'Male' : 'Female';
        $sexCode = $sexLabel === 'Male' ? 'M' : 'F';
        $caseNumber = sprintf('CASE-2026-%03d', $i);

        $selectStmt->execute([$caseNumber]);
        $existing = $selectStmt->fetch();

        if ($existing && !empty($existing['id'])) {
            $updateStmt->execute([$fullName, $age, $sexCode, $caseNumber, intval($existing['id'])]);
            $updated++;
        } else {
            $insertStmt->execute([$fullName, $age, $sexCode, $caseNumber]);
            $inserted++;
        }

        if ($i <= 10) {
            $preview[] = sprintf(
                '%s | %s | %d | %s',
                $caseNumber,
                $fullName,
                $age,
                $sexLabel
            );
        }
    }

    $pdo->commit();

    echo "Seeder completed successfully.\n";
    echo "Inserted: {$inserted}\n";
    echo "Updated: {$updated}\n";
    echo "Total processed: 300\n\n";
    echo "Preview (first 10 records):\n";
    foreach ($preview as $line) {
        echo '- ' . $line . "\n";
    }
} catch (Throwable $e) {
    if (isset($pdo) && $pdo instanceof PDO && $pdo->inTransaction()) {
        $pdo->rollBack();
    }

    http_response_code(500);
    echo "Seeder failed: " . $e->getMessage() . "\n";
    exit(1);
}
