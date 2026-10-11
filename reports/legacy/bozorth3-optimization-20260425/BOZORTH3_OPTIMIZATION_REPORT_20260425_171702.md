# Bozorth3 Optimization Report

## Evaluation Basis

- Source mode: `criminal_database`
- Identity samples: `6`
- Pair observations: `54`
- Stress pairs included: `False`
- FAR target: `20.00%`
- Threshold sweep: `56` to `80`

## Recommended Operating Point

- Base threshold: `56`
- Consistency min score: `12`
- Min required minutiae: `18`
- Structural orientation min: `26`
- Structural graph min: `18`
- Partial overlap min: `0.26`
- Partial quality min: `68`
- Local-structure rescue min: `54`
- Partial local-structure min: `50`
- Bozorth floor: `44`
- Bozorth allowance below threshold: `20`

## Recommended Metrics

- Accuracy: `92.59%`
- Precision: `95.45%`
- Recall: `87.50%`
- F1-score: `91.30%`
- FAR: `3.33%`
- FRR: `12.50%`

## Cross-Validation

- Folds completed: `3`
- Mean validation recall: `87.50%`
- Mean validation FAR: `0.00%`
- Mean validation FRR: `12.50%`

## Service Snapshot

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
      "structuralOrientationMin": 26,
      "structuralGraphMin": 18,
      "partialOverlapMin": 0.26,
      "partialQualityMin": 68,
      "localStructureRescueMin": 54,
      "partialLocalStructureMin": 50,
      "bozorthFloor": 42,
      "bozorthThresholdAllowance": 20
    },
    "fusion": {
      "bozorth": 0.42,
      "consistency": 0.18,
      "orientation": 0.1,
      "graph": 0.08,
      "localStructure": 0.12,
      "quality": 0.1
    },
    "matchThreshold": 60
  },
  "scanner": {
    "available": false,
    "vendorId": 9537,
    "productId": 566,
    "tempDir": "C:\\xampp\\htdocs\\Minutiae\\temp"
  }
}
```