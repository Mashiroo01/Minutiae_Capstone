<?php
/**
 * Minutiae example configuration.
 *
 * Copy this file to config.php and replace every CHANGE_ME value before use.
 * config.php is intentionally excluded from Git because it contains secrets.
 */

return [
    'system' => [
        'name' => 'Minutiae',
        'version' => '1.0.0',
        'description' => 'Fingerprint Matching and Verification System'
    ],

    'bozorth3' => [
        'path' => getenv('MINUTIAE_BOZORTH3_PATH') ?: 'C:\\path\\to\\bozorth3.exe',
        'cygwin_bash' => getenv('MINUTIAE_CYGWIN_BASH') ?: 'C:\\cygwin64\\bin\\bash.exe',
        'match_threshold' => 80,
        'template_format' => 'ISO',
        'temp_dir' => rtrim(
            getenv('MINUTIAE_TEMP_DIR') ?: (sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'Minutiae' . DIRECTORY_SEPARATOR . 'work'),
            DIRECTORY_SEPARATOR
        ) . DIRECTORY_SEPARATOR
    ],

    'database' => [
        'type' => 'mysql',
        'host' => getenv('MINUTIAE_DB_HOST') ?: 'localhost',
        'user' => getenv('MINUTIAE_DB_USER') ?: 'root',
        'password' => getenv('MINUTIAE_DB_PASSWORD') ?: '',
        'database' => getenv('MINUTIAE_DB_NAME') ?: 'minutiae_runtime',
        'port' => intval(getenv('MINUTIAE_DB_PORT') ?: 3306),
        'charset' => 'utf8mb4'
    ],

    'services' => [
        'fingerprint_service_url' => rtrim(
            getenv('MINUTIAE_AFIS_BASE_URL') ?: 'http://localhost:9000',
            '/'
        )
    ],

    'quality' => [
        'min_quality_score' => 50,
        'reject_poor_quality' => true
    ],

    'thresholds' => [
        'critical_threshold' => 80,
        'warning_threshold' => 65,
        'low_threshold' => 45
    ],

    'risk_levels' => [
        'high' => [
            'positive_matches' => 1,
            'min_score' => 80,
            'action' => 'REJECT'
        ],
        'medium' => [
            'positive_matches' => 0,
            'min_score' => 65,
            'action' => 'REVIEW'
        ],
        'low' => [
            'positive_matches' => 0,
            'min_score' => 0,
            'action' => 'APPROVE'
        ]
    ],

    'logging' => [
        'enabled' => true,
        'file' => getenv('MINUTIAE_LOG_FILE') ?: (__DIR__ . DIRECTORY_SEPARATOR . '..' . DIRECTORY_SEPARATOR . 'logs' . DIRECTORY_SEPARATOR . 'system.log'),
        'level' => 'info'
    ],

    'security' => [
        'require_https' => false,
        'api_token_enabled' => false,
        'cors_enabled' => true,
        'allowed_origins' => ['*'],
        'session_name' => 'MINUTIAE_ADMIN_SESSION',
        'privacy_notice_version' => '2026-03-28',
        'admin_accounts' => [
            [
                'username' => getenv('MINUTIAE_ADMIN_USERNAME') ?: 'admin',
                'password' => getenv('MINUTIAE_ADMIN_PASSWORD') ?: 'CHANGE_ME',
                'role' => 'super_admin',
                'full_name' => 'System Administrator'
            ]
        ]
    ]
];
