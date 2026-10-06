# Bozorth3 false-positive investigation

## Outcome

The false-positive problem was not caused by Bozorth3 score direction. Native Bozorth3 correctly uses a higher score for a stronger match and the application comparison correctly evaluates `score >= threshold`.

Two independent data problems caused the misleading results:

1. The criminal-database benchmark labeled records by `criminal_id`, but filenames such as `101_1.tif` through `101_8.tif` are repeated impressions of the same FVC subject/finger. Those genuine pairs were therefore counted as impostors. Finger-position metadata was also inconsistent across those repeated impressions (`RIGHT_INDEX` versus `RIGHT_THUMB`).
2. The academic Bozorth3 route consumed the legacy application minutiae feed. That path divides an already one-direction crossing-number count by two, misclassifying ridge structure and producing dense, non-discriminative templates. On correctly labeled FVC data, legacy genuine and impostor score distributions overlap almost completely.

The native executable, score parsing, unique temporary filenames, and `>= threshold` decision direction were verified independently. No score fallback is used by the academic Bozorth3 route.

## Corrective change

Bozorth3 now receives the same score-independent SourceAFIS-extracted minutiae used as the clean academic feature feed. This changes only Bozorth3 input construction; SourceAFIS, OpenAFIS, MCC, and Jiang scoring are unchanged.

The default Bozorth3 threshold is now 20, calibrated on FVC2004 DB4_B. Scores within ±3 of the threshold return `BORDERLINE` with no binary match decision. Inputs below 18 usable minutiae or below image quality 35 return `INSUFFICIENT QUALITY`; the native raw score is still retained for diagnostics.

Every comparison now records:

- probe/candidate fingerprint IDs, source paths, finger positions, image hashes, and same-image detection;
- extracted and used minutiae counts plus filtering rules;
- unique XYT paths, SHA-256 hashes, line counts, and samples;
- exact native command, exit code, stdout, stderr, timeout state, and elapsed time;
- raw score, threshold, decision state, quality-gate state, and review recommendation.

The older database-backed performance-matrix evaluator now fails fast when image hashes are reused across criminal IDs or FVC same-subject filenames are assigned to different criminal/finger labels. It can no longer silently report those contradictory records as impostors.

## Calibration protocol

- Dataset: FVC2004 DB4_B, 10 subjects, 8 impressions per subject (80 images).
- Ground truth: the FVC filename subject prefix, never application criminal IDs or matcher output.
- Comparisons: 280 within-subject genuine pairs and 280 balanced cross-subject impostor pairs.
- Split: subjects 101–105 for threshold selection; subjects 106–110 held out for validation.
- Selection objective: minimum training errors, then fewer false accepts, then closest FAR/FRR, then the lowest threshold on an equivalent plateau.

## Before and after

| Configuration | Threshold | TP | FN | FP | TN | Accuracy | Precision | Recall | F1 | FAR | FRR |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Before: legacy application minutiae | 40 | 236 | 44 | 234 | 46 | 50.36% | 50.21% | 84.29% | 62.93% | 83.57% | 15.71% |
| After: SourceAFIS minutiae | 20 | 256 | 24 | 0 | 280 | 95.71% | 100.00% | 91.43% | 95.52% | 0.00% | 8.57% |

The held-out validation result for the new configuration was identical: 128 TP, 12 FN, 0 FP, and 140 TN (FAR 0.00%, FRR 8.57%, F1 95.52%). This is a dataset result, not a claim of zero deployment FAR; local scanner captures still require their own representative calibration.

Legacy score distributions confirm the extraction failure: genuine mean 196.90 and impostor mean 187.86. SourceAFIS-fed Bozorth3 separates them: genuine mean 80.10 and impostor mean 7.29, with impostor maximum 19 in this evaluation.

## Live verification

- Genuine `101_1.tif` versus `101_2.tif`: raw score 24, threshold 20, `MATCH`; 29/42 minutiae; native exit 0; distinct image and template hashes.
- Impostor `101_1.tif` versus `102_1.tif`: raw score 6, threshold 20, `NO MATCH`; 29/63 minutiae; native exit 0; distinct image and template hashes.

## Artifacts

- `bozorth3-calibration-20261001T052758Z/scores.csv`: every labeled comparison and native score.
- `bozorth3-calibration-20261001T052758Z/threshold-sweep.csv`: full integer threshold sweep with confusion matrices and metrics.
- `bozorth3-calibration-20261001T052758Z/score-distributions-and-roc.svg` and `.png`: score distributions and ROC visualization.
- `bozorth3-calibration-20261001T052758Z/summary.json`: machine-readable protocol and results.
- `bozorth3-calibration-20261001T052758Z/REPORT.md`: generated calibration report.

Reproduce the standalone SourceAFIS-to-Bozorth3 evaluation with `npm run bozorth3:calibrate`. To also reproduce the slower legacy before-case, start the fingerprint service and set `CALIBRATE_LEGACY=1`.
