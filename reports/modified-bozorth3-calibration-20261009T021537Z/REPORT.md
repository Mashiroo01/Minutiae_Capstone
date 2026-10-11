# Modified Bozorth3 calibration report

Generated 2026-10-09T02:15:37.496Z.

## Ground truth and protocol

- Dataset: `C:\xampp\htdocs\Minutiae\temp\matcher-build\openafis\data\valid\fvc2004\DB4_B`
- 80 images, 10 FVC subjects, 280 genuine and 280 balanced impostor pairs.
- Labels come only from the FVC filename subject prefix, never from matcher output or application criminal IDs.
- Subjects 101-105 train; 106-110 held-out validation.
- Native scores are preserved. Higher scores mean more similar.
- Threshold selection: minimum training errors, then fewer false accepts, then closest FAR/FRR, then the lowest threshold on an equivalent plateau.
- Active feed: enhanced denoising/Gabor/binarization/Zhang-Suen/cleaned-minutiae pipeline.

## Results

### Enhanced pipeline → Modified Bozorth3

- Chosen threshold: **309**
- Train: FAR 0.00%, FRR 94.29%, F1 10.81% (0 FP, 132 FN)
- Held-out validation: FAR 0.00%, FRR 95.71%, F1 8.22% (0 FP, 134 FN)
- All pairs: FAR 0.00%, FRR 95.00%, accuracy 52.50%, precision 100.00%, recall 5.00%, F1 9.52%
- Genuine scores: {"count":280,"minimum":13,"p25":136,"median":231,"p75":272,"p95":308,"maximum":337,"mean":196.9}
- Impostor scores: {"count":280,"minimum":13,"p25":95,"median":222,"p75":270,"p95":296,"maximum":308,"mean":187.86}

## Calibration decision

**Rejected — not activated.** The genuine and impostor distributions overlap too heavily for a defensible production threshold. The training-selected threshold of 309 gives a 95.71% false-reject rate on held-out subjects. The best all-pair balanced threshold is 228, but it still gives 45.71% FAR, 46.07% FRR, and only 54.11% balanced accuracy. Modified Bozorth3 therefore remains marked `calibration_required`, and the application does not display a fabricated match percentage.

## Artifacts

- `scores.csv`: every labeled comparison and native score.
- `threshold-sweep.csv`: confusion matrix and metrics for every integer threshold.
- `score-distributions-and-roc.svg`: genuine/impostor score distributions and ROC curve for the selected feed.
- `summary.json`: machine-readable protocol and metrics.
- `match-percentage-profile.json`: rejected candidate profile retained as calibration evidence; it was not activated.
