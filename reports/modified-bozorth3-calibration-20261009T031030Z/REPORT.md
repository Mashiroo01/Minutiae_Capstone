# Modified Bozorth3 calibration report

Generated 2026-10-09T03:10:30.181Z.

## Ground truth and protocol

- Dataset: `C:\xampp\htdocs\Minutiae\temp\matcher-build\openafis\data\valid\fvc2004\DB4_B`
- 80 images, 10 FVC subjects, 280 genuine and 280 balanced impostor pairs.
- Labels come only from the FVC filename subject prefix, never from matcher output or application criminal IDs.
- Subjects 101-105 train; 106-110 held-out validation.
- Native scores are preserved. Higher scores mean more similar.
- Threshold selection: minimum training errors, then fewer false accepts, then closest FAR/FRR, then the lowest threshold on an equivalent plateau.
- Active feed: denoised NIST MINDTCT candidates validated against the Gabor/binarized/Zhang-Suen skeleton.
- Extracted templates ranged from 31 to 115 minutiae (mean 66.81); 0/80 hit the former 140-point limit and 0/80 fell below the 18-point quality floor.

## Results

### Enhanced pipeline → Modified Bozorth3

- Chosen threshold: **16**
- Train: FAR 0.71%, FRR 12.14%, F1 93.18% (1 FP, 17 FN)
- Held-out validation: FAR 1.43%, FRR 23.57%, F1 85.94% (2 FP, 33 FN)
- All pairs: FAR 1.07%, FRR 17.86%, accuracy 90.54%, precision 98.71%, recall 82.14%, F1 89.67%
- Genuine scores: {"count":280,"minimum":3,"p25":20,"median":37,"p75":75,"p95":184,"maximum":274,"mean":58.28}
- Impostor scores: {"count":280,"minimum":0,"p25":4,"median":6,"p75":8,"p95":12,"maximum":19,"mean":6.55}

## Artifacts

- `scores.csv`: every labeled comparison and native score.
- `threshold-sweep.csv`: confusion matrix and metrics for every integer threshold.
- `score-distributions-and-roc.svg`: genuine/impostor score distributions and ROC curve for the selected feed.
- `summary.json`: machine-readable protocol and metrics.
- `match-percentage-profile.json`: reusable threshold-anchored normalization profile for review before activation.
