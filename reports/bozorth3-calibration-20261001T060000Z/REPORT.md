# Bozorth3 calibration report

Generated 2026-10-01T06:00:02.914Z.

## Ground truth and protocol

- Dataset: `C:\xampp\htdocs\Minutiae\temp\matcher-build\openafis\data\valid\fvc2004\DB4_B`
- 80 images, 10 FVC subjects, 280 genuine and 280 balanced impostor pairs.
- Labels come only from the FVC filename subject prefix, never from matcher output or application criminal IDs.
- Subjects 101-105 train; 106-110 held-out validation.
- Native scores are preserved. Higher scores mean more similar.
- Threshold selection: minimum training errors, then fewer false accepts, then closest FAR/FRR, then the lowest threshold on an equivalent plateau.

## Results

### After: SourceAFIS minutiae → Bozorth3

- Chosen threshold: **20**
- Train: FAR 0.00%, FRR 8.57%, F1 95.52% (0 FP, 12 FN)
- Held-out validation: FAR 0.00%, FRR 8.57%, F1 95.52% (0 FP, 12 FN)
- All pairs: FAR 0.00%, FRR 8.57%, accuracy 95.71%, precision 100.00%, recall 91.43%, F1 95.52%
- Genuine scores: {"count":280,"minimum":3,"p25":40,"median":64,"p75":106,"p95":183,"maximum":309,"mean":80.1}
- Impostor scores: {"count":280,"minimum":0,"p25":5,"median":7,"p75":9,"p95":14,"maximum":19,"mean":7.29}

## Artifacts

- `scores.csv`: every labeled comparison and native score.
- `threshold-sweep.csv`: confusion matrix and metrics for every integer threshold.
- `score-distributions-and-roc.svg`: genuine/impostor score distributions and ROC curve for the selected feed.
- `summary.json`: machine-readable protocol and metrics.
