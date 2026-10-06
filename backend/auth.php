<?php
/**
 * Session authentication and audit helpers for admin access.
 */

require_once 'FingerprintDB.php';

class MinutiaeAuth {

    private $db;
    private $config;

    public function __construct($pdo = null) {
        $this->config = require __DIR__ . '/config.php';
        $this->startSession();
        $this->db = new FingerprintDB($pdo);
    }

    private function startSession() {
        if (session_status() === PHP_SESSION_ACTIVE) {
            return;
        }

        $sessionName = $this->config['security']['session_name'] ?? 'MINUTIAE_ADMIN_SESSION';
        $scriptName = $_SERVER['SCRIPT_NAME'] ?? '/';
        $basePath = rtrim(str_replace('\\', '/', dirname(dirname($scriptName))), '/');
        $cookiePath = ($basePath === '' || $basePath === '.') ? '/' : ($basePath . '/');

        session_set_cookie_params([
            'lifetime' => 0,
            'path' => $cookiePath,
            'domain' => '',
            'secure' => !empty($this->config['security']['require_https']),
            'httponly' => true,
            'samesite' => 'Lax'
        ]);
        session_name($sessionName);
        session_start();
    }

    public function currentUser() {
        $sessionUser = $_SESSION['admin_user'] ?? null;
        if (!$sessionUser || empty($sessionUser['username'])) {
            return null;
        }

        if (($sessionUser['auth_source'] ?? 'database') === 'config') {
            $configUser = $this->getConfiguredAccount($sessionUser['username']);
            if (!$configUser) {
                unset($_SESSION['admin_user']);
                return null;
            }

            $user = [
                'id' => $this->buildConfigUserId($configUser['username']),
                'username' => $configUser['username'],
                'role' => $configUser['role'],
                'full_name' => $configUser['full_name'],
                'last_login' => $sessionUser['last_login'] ?? null,
                'auth_source' => 'config'
            ];

            $_SESSION['admin_user'] = $user;
            return $user;
        }

        $freshUser = null;
        if (!empty($sessionUser['id'])) {
            $freshUser = $this->db->getAdminUserById(intval($sessionUser['id']));
        }

        if (!$freshUser) {
            $configUser = $this->getConfiguredAccount($sessionUser['username']);
            if ($configUser) {
                $user = [
                    'id' => $this->buildConfigUserId($configUser['username']),
                    'username' => $configUser['username'],
                    'role' => $configUser['role'],
                    'full_name' => $configUser['full_name'],
                    'last_login' => $sessionUser['last_login'] ?? null,
                    'auth_source' => 'config'
                ];
                $_SESSION['admin_user'] = $user;
                return $user;
            }

            unset($_SESSION['admin_user']);
            return null;
        }

        if (intval($freshUser['is_active'] ?? 0) !== 1) {
            unset($_SESSION['admin_user']);
            return null;
        }

        $user = [
            'id' => intval($freshUser['id']),
            'username' => $freshUser['username'],
            'role' => $freshUser['role'],
            'full_name' => $freshUser['full_name'],
            'last_login' => $freshUser['last_login'],
            'auth_source' => 'database'
        ];

        $_SESSION['admin_user'] = $user;
        return $user;
    }

    public function login($username, $password) {
        $username = trim((string)$username);
        if ($username === '' || trim((string)$password) === '') {
            return [
                'success' => false,
                'error' => 'Username and password are required.'
            ];
        }

        $user = $this->db->getAdminUserByUsername($username);
        $sessionUser = null;

        if ($user && intval($user['is_active'] ?? 0) === 1 && password_verify((string)$password, (string)$user['password_hash'])) {
            $sessionUser = [
                'id' => intval($user['id']),
                'username' => $user['username'],
                'role' => $user['role'],
                'full_name' => $user['full_name'],
                'last_login' => date('Y-m-d H:i:s'),
                'auth_source' => 'database'
            ];
        } else {
            $configuredUser = $this->getConfiguredAccount($username);
            if ($configuredUser && hash_equals((string)$configuredUser['password'], (string)$password)) {
                $sessionUser = [
                    'id' => $this->buildConfigUserId($configuredUser['username']),
                    'username' => $configuredUser['username'],
                    'role' => $configuredUser['role'],
                    'full_name' => $configuredUser['full_name'],
                    'last_login' => date('Y-m-d H:i:s'),
                    'auth_source' => 'config'
                ];
            }
        }

        if (!$sessionUser) {
            $this->logAction('login_failed', 'auth', null, ['username' => $username]);
            return [
                'success' => false,
                'error' => 'Invalid username or password.'
            ];
        }

        session_regenerate_id(true);
        $_SESSION['admin_user'] = $sessionUser;
        if (($sessionUser['auth_source'] ?? 'database') === 'database') {
            $this->db->updateAdminLastLogin($sessionUser['id']);
        }
        $this->logAction('login_success', 'auth', $sessionUser['id']);

        return [
            'success' => true,
            'user' => $sessionUser
        ];
    }

    public function logout() {
        $user = $this->currentUser();
        if ($user) {
            $this->logAction('logout', 'auth', $user['id']);
        }

        $_SESSION = [];
        if (ini_get('session.use_cookies')) {
            $params = session_get_cookie_params();
            setcookie(session_name(), '', time() - 42000, $params['path'], $params['domain'], $params['secure'], $params['httponly']);
        }
        session_destroy();

        return ['success' => true];
    }

    public function requireRole($roles, $action = 'access_resource', $targetType = null, $targetId = null, $details = []) {
        $user = $this->currentUser();
        if (!$user) {
            $this->sendJson([
                'success' => false,
                'error' => 'Authentication required.'
            ], 401);
        }

        $roles = is_array($roles) ? $roles : [$roles];
        if (!in_array($user['role'], $roles, true)) {
            $this->logAction('authorization_denied', $targetType ?: 'resource', $targetId, array_merge($details, [
                'attempted_action' => $action,
                'required_roles' => $roles
            ]));
            $this->sendJson([
                'success' => false,
                'error' => 'You do not have permission to perform this action.'
            ], 403);
        }

        $this->logAction($action, $targetType, $targetId, $details);
        return $user;
    }

    public function logAction($action, $targetType = null, $targetId = null, $details = []) {
        $user = $this->currentUser();
        $this->db->insertAuditLog(
            $user['id'] ?? null,
            $user['username'] ?? null,
            $user['role'] ?? null,
            $action,
            $targetType,
            $targetId,
            $details,
            $this->getClientIp()
        );
    }

    public function requirePrivacyConsent($payload) {
        $consentAccepted = !empty($payload['privacy_consent']);
        $consentVersion = trim((string)($payload['privacy_notice_version'] ?? ''));
        $expectedVersion = $this->config['security']['privacy_notice_version'] ?? '';

        if (!$consentAccepted || $consentVersion !== $expectedVersion) {
            $this->sendJson([
                'success' => false,
                'error' => 'Data privacy consent is required before processing applicant information.'
            ], 422);
        }
    }

    public function getPrivacyNoticeVersion() {
        return $this->config['security']['privacy_notice_version'] ?? '';
    }

    public function sendJson($payload, $status = 200) {
        if (!headers_sent()) {
            header('Content-Type: application/json');
        }
        http_response_code($status);
        echo json_encode($payload);
        exit;
    }

    private function getClientIp() {
        $keys = ['HTTP_X_FORWARDED_FOR', 'REMOTE_ADDR'];
        foreach ($keys as $key) {
            if (!empty($_SERVER[$key])) {
                $value = explode(',', $_SERVER[$key])[0];
                return trim($value);
            }
        }
        return null;
    }

    private function getConfiguredAccount($username) {
        $username = trim((string)$username);
        $accounts = $this->config['security']['admin_accounts'] ?? [];

        foreach ($accounts as $account) {
            if (strcasecmp(trim((string)($account['username'] ?? '')), $username) !== 0) {
                continue;
            }

            return [
                'username' => trim((string)($account['username'] ?? '')),
                'password' => (string)($account['password'] ?? ''),
                'role' => (string)($account['role'] ?? 'admin'),
                'full_name' => $account['full_name'] ?? null
            ];
        }

        return null;
    }

    private function buildConfigUserId($username) {
        return intval(sprintf('%u', crc32('config:' . strtolower((string)$username))));
    }
}

if (realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__) {
    try {
        header('Content-Type: application/json');

        $auth = new MinutiaeAuth();
        $action = $_GET['action'] ?? 'session';

        if ($_SERVER['REQUEST_METHOD'] === 'POST') {
            $data = json_decode(file_get_contents('php://input'), true) ?? [];

            switch ($action) {
                case 'login':
                    $auth->sendJson($auth->login($data['username'] ?? '', $data['password'] ?? ''));
                    break;

                case 'logout':
                    $auth->sendJson($auth->logout());
                    break;

                default:
                    $auth->sendJson([
                        'success' => false,
                        'error' => 'Unknown action: ' . $action
                    ], 400);
            }
        }

        switch ($action) {
            case 'session':
                $user = $auth->currentUser();
                $auth->sendJson([
                    'success' => true,
                    'authenticated' => !empty($user),
                    'user' => $user,
                    'privacy_notice_version' => $auth->getPrivacyNoticeVersion()
                ]);
                break;

            default:
                $auth->sendJson([
                    'success' => false,
                    'error' => 'Unknown action: ' . $action
                ], 400);
        }
    } catch (Throwable $e) {
        error_log('Auth endpoint error: ' . $e->getMessage());
        if (!headers_sent()) {
            header('Content-Type: application/json');
        }
        http_response_code(500);
        echo json_encode([
            'success' => false,
            'error' => 'Authentication service is temporarily unavailable.'
        ]);
        exit;
    }
}
?>
