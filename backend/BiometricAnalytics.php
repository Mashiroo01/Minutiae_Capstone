<?php

class BiometricAnalytics {
    private $scriptPath;
    private $pythonExecutable;

    public function __construct($scriptPath = null, $pythonExecutable = null) {
        $this->scriptPath = $scriptPath ?: dirname(__DIR__) . '/biometric_analytics.py';
        $configuredPython = trim((string)getenv('MINUTIAE_PYTHON'));
        $this->pythonExecutable = $pythonExecutable
            ?: ($configuredPython !== '' ? $configuredPython : (PHP_OS_FAMILY === 'Windows' ? 'python' : 'python3'));
    }

    public static function loadProfile($configPath, $matcher = 'Modified Bozorth3') {
        if (!is_file($configPath)) {
            return null;
        }

        $decoded = json_decode((string)file_get_contents($configPath), true);
        $profile = $decoded['profiles'][$matcher] ?? null;
        return is_array($profile) ? $profile : null;
    }

    public function analyze($payload) {
        if (!is_file($this->scriptPath)) {
            return $this->unavailable('Python biometric analytics script is not installed.');
        }

        $input = json_encode($payload, JSON_UNESCAPED_SLASHES);
        if ($input === false) {
            return $this->unavailable('Biometric analytics input could not be encoded.');
        }

        $descriptors = [
            0 => ['pipe', 'r'],
            1 => ['pipe', 'w'],
            2 => ['pipe', 'w']
        ];
        $process = @proc_open([$this->pythonExecutable, $this->scriptPath], $descriptors, $pipes, dirname(__DIR__));
        if (!is_resource($process)) {
            return $this->unavailable('Python could not be started for biometric analytics.');
        }

        fwrite($pipes[0], $input);
        fclose($pipes[0]);
        $stdout = stream_get_contents($pipes[1]);
        $stderr = stream_get_contents($pipes[2]);
        fclose($pipes[1]);
        fclose($pipes[2]);
        $exitCode = proc_close($process);

        $decoded = json_decode((string)$stdout, true);
        if ($exitCode !== 0 || !is_array($decoded)) {
            error_log('Biometric analytics process failed: ' . trim((string)$stderr));
            return $this->unavailable('Python biometric analytics could not be calculated.');
        }

        return $decoded;
    }

    private function unavailable($message) {
        return [
            'status' => 'unavailable',
            'message' => $message,
            'confusion_matrix' => null,
            'posterior' => null,
            'operational_posterior' => null
        ];
    }
}

