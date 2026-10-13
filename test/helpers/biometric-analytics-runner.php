<?php
require_once __DIR__ . '/../../backend/BiometricAnalytics.php';

$payload = json_decode(stream_get_contents(STDIN), true, 512, JSON_THROW_ON_ERROR);
$analytics = new BiometricAnalytics(__DIR__ . '/../../biometric_analytics.py');
echo json_encode($analytics->analyze($payload), JSON_THROW_ON_ERROR);

