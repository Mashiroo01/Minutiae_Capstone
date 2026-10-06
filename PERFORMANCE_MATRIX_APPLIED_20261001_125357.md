# Applied Performance Matrix for the Improved Fingerprint Matching Algorithm

This report was generated automatically by `evaluate_performance_matrix.py` and applies the performance matrix directly to the improved local AFIS + enhanced Bozorth3 matcher used by the system.

## Evaluation Basis

- Benchmark type: `database-backed criminal fingerprint benchmark`
- Identity samples: `6`
- Primary probes per identity: `4.00`
- Stress variants per identity: `2.00`
- Negative comparisons per identity: `5.00`
- Random seed: `10173`
- Note:
  The matrix was computed directly from active fingerprint images stored in the criminal_fingerprints table and evaluated through the same /afis/from-image and /afis/compare pipeline used by the application.
- Uploads directory: `not used in this run`
- Database mode: `criminals`
- Database records used: `6`
- Primary metrics were computed from standard operational variants, while low-quality robustness was measured separately using the stress variants.

## Confusion Matrix

- `TP`: 22
- `FN`: 2
- `FP`: 6
- `TN`: 24

## Performance Matrix

| Evaluation Area | Performance Indicator | Measured Value | Verbal Interpretation |
|---|---|---:|---|
| Biometric Accuracy | Accuracy | 85.19% | Satisfactory |
| Biometric Accuracy | Precision | 78.57% | Needs Improvement |
| Biometric Accuracy | Recall / Sensitivity | 91.67% | Very Satisfactory |
| Biometric Accuracy | F1-Score | 84.62% | Fair |
| Biometric Accuracy | False Acceptance Rate (FAR) | 20.00% | Needs Improvement |
| Biometric Accuracy | False Rejection Rate (FRR) | 8.33% | Satisfactory |
| Image Robustness | Low-Quality Match Robustness | 87.50% | Satisfactory |
| Image Robustness | Mean AFIS Quality | 82.33 / 100 | Fair |
| Matcher Behavior | Mean Genuine Match Score | 77.62 | Higher than impostor scores |
| Matcher Behavior | Mean Impostor Match Score | 65.37 | Lower than genuine scores |
| Matcher Behavior | Score Separation | 12.26 | Stronger separation indicates better discrimination |
| Matcher Behavior | Adaptive Threshold Stability | 68.00 mean / 0.00 std | Stable threshold adjustment |
| Processing Efficiency | Enrollment Processing Time | 0.48 sec | Excellent |
| Processing Efficiency | Probe Processing Time | 0.45 sec | Excellent |
| Processing Efficiency | Verification Processing Time | 1.71 sec | Excellent |
| Processing Efficiency | Estimated End-to-End Screening Time | 2.16 sec | Excellent |
| Processing Efficiency | Service Availability | 100.00% | Excellent |

## Threshold Sweep Analysis

- Sweep range: `40.00` to `80.00` in steps of `4.00`
- Score count analyzed: `54`
- Score range observed: `54.00` to `82.00`
- Best F1 threshold: `72.00` (Accuracy `92.59%`, Precision `88.46%`, Recall `95.83%`, F1 `92.00%`, FAR `10.00%`, FRR `4.17%`)
- EER approximation threshold: `72.00` (FAR `10.00%`, FRR `4.17%`, gap `5.83%`)
- Plot generation: `Plot generation was skipped by CLI option.`

| Threshold | Accuracy | Precision | Recall | F1 | FAR | FRR | Notes |
|---:|---:|---:|---:|---:|---:|---:|---|
| 40.00 | 44.44% | 44.44% | 100.00% | 61.54% | 100.00% | 0.00% |  |
| 44.00 | 44.44% | 44.44% | 100.00% | 61.54% | 100.00% | 0.00% |  |
| 48.00 | 44.44% | 44.44% | 100.00% | 61.54% | 100.00% | 0.00% |  |
| 52.00 | 44.44% | 44.44% | 100.00% | 61.54% | 100.00% | 0.00% |  |
| 56.00 | 48.15% | 46.15% | 100.00% | 63.16% | 93.33% | 0.00% |  |
| 60.00 | 55.56% | 50.00% | 100.00% | 66.67% | 80.00% | 0.00% |  |
| 64.00 | 61.11% | 53.33% | 100.00% | 69.57% | 70.00% | 0.00% |  |
| 68.00 | 77.78% | 66.67% | 100.00% | 80.00% | 40.00% | 0.00% |  |
| 72.00 | 92.59% | 88.46% | 95.83% | 92.00% | 10.00% | 4.17% | Best F1 / EER Approx |
| 76.00 | 90.74% | 100.00% | 79.17% | 88.37% | 0.00% | 20.83% |  |
| 80.00 | 66.67% | 100.00% | 25.00% | 40.00% | 0.00% | 75.00% |  |

## Summary Interpretation

The improved fingerprint matching algorithm demonstrated fast processing and stable adaptive threshold behavior in this database-backed criminal fingerprint benchmark. At the service operating point, the run produced `85.19%` accuracy, `78.57%` precision, `91.67%` recall, `20.00%` FAR, and `8.33%` FRR. The fixed-threshold sweep identified `72.00` as the best-F1 operating point and `72.00` as the closest FAR≈FRR balance point, which provides a cleaner basis for calibrating the matcher for research reporting and future deployment tuning.

## Research-Ready Paragraph

Based on the applied performance matrix, the improved Minutiae-Based Fingerprint Identification algorithm demonstrated efficient processing time, improved score separation, and a measurable tradeoff between false accepts and false rejects across the threshold sweep. The database-backed benchmark results show that the improved AFIS preprocessing, enhanced local-structure Bozorth-style scoring, and threshold calibration workflow can identify both a best-F1 operating point and an approximate equal-error operating point, supporting a more defensible threshold selection strategy for research reporting and future matcher deployment.

## Service Configuration Snapshot

```json
{
  "success": true,
  "afis": {
    "enhancement": {
      "clahe": true,
      "claheWindow": 24,
      "claheMaxSlope": 4,
      "medianSize": 3,
      "sharpenSigma": 1.2,
      "normalize": true,
      "inputSize": 500,
      "trimThreshold": 12,
      "blockSize": 16,
      "foregroundStdThreshold": 18,
      "gaborRadius": 4,
      "gaborGain": 1.35,
      "thinningIterations": 12
    },
    "minutiae": {
      "maxPoints": 140,
      "minDistance": 7,
      "minRequiredForMatch": 18,
      "minQuality": 24,
      "borderMargin": 18,
      "neighborRadius": 32,
      "endingMinTraceLength": 10,
      "bifurcationMinTraceLength": 7,
      "traceMaxSteps": 18,
      "descriptorNeighbors": 5
    },
    "consistency": {
      "enabled": true,
      "minScore": 12,
      "minDirectionalScore": 6,
      "distancePx": 16,
      "angleDeg": 24,
      "requireType": true,
      "useCentroidShift": true
    },
    "alignment": {
      "enabled": true,
      "topCandidates": 18,
      "maxAngleDeg": 35,
      "distancePx": 16,
      "angleDeg": 24
    },
    "graph": {
      "distanceBinSize": 20,
      "distanceBins": 12,
      "angleBinSize": 20,
      "angleBins": 9
    },
    "localStructure": {
      "enabled": true,
      "descriptorNeighbors": 5,
      "distancePx": 18,
      "angleDeg": 28,
      "minScore": 52
    },
    "bozorthEnhancement": {
      "enabled": true,
      "distancePx": 18,
      "angleDeg": 26,
      "pairMinScore": 54,
      "edgeDistanceTolerance": 22,
      "edgeAngleDeg": 24,
      "edgeOrientationDeg": 28,
      "rawWeight": 0.52,
      "pairWeight": 0.18,
      "coverageWeight": 0.14,
      "graphWeight": 0.16
    },
    "thresholding": {
      "minThreshold": 60,
      "maxThreshold": 84,
      "lowQualityPenalty": 10,
      "lowOverlapPenalty": 8,
      "lowMinutiaePenalty": 6,
      "highQualityBonus": 4
    },
    "decision": {
      "structuralOrientationMin": 76,
      "structuralGraphMin": 80,
      "partialOverlapMin": 0.26,
      "partialQualityMin": 68,
      "localStructureRescueMin": 42,
      "partialLocalStructureMin": 34,
      "bozorthFloor": 44,
      "bozorthThresholdAllowance": 20
    },
    "fusion": {
      "bozorth": 0.06,
      "consistency": 0.1,
      "orientation": 0.5,
      "graph": 0.2,
      "localStructure": 0.12,
      "quality": 0.02
    },
    "matchThreshold": 68,
    "academicMatchers": {
      "bozorth3Threshold": 40,
      "sourceAfisThreshold": 40,
      "openAfisThreshold": 6,
      "mccThreshold": 0.04,
      "jiangThreshold": 0.245,
      "sourceAfisDpi": 500,
      "sourceAfisReady": true,
      "openAfisReady": true,
      "mccReady": true,
      "jiangReady": true
    }
  },
  "scanner": {
    "available": true,
    "provider": "zkteco-zk9500",
    "captureCommandConfigured": true,
    "captureCommand": "C:\\xampp\\htdocs\\Minutiae\\scripts\\zkteco-zk9500-capture.exe",
    "captureArgs": "--output {output} --type {type} --timeout {timeout}",
    "statusArgs": "--status",
    "outputExtension": "raw",
    "dpi": 500,
    "simulationAllowed": false,
    "tempDir": "C:\\Users\\mendi\\AppData\\Local\\Temp\\Minutiae\\work",
    "scannerTempDir": "C:\\Users\\mendi\\AppData\\Local\\Temp\\Minutiae\\scanner"
  }
}
```