# Academic matcher adapters

This directory contains thin command-line bridges used by `fingerprint-service.js`.

- **SourceAFIS 3.18.1** is loaded from Maven Central and compares the original
  probe/reference image bytes at 500 DPI. SourceAFIS is Apache-2.0 licensed.
- **OpenAFIS** is built from `neilharan/openafis` and receives CSV minutiae
  templates generated from the application's actual extracted ridge endings and
  bifurcations. Non-square captures use one shared square, isotropic coordinate
  canvas so rotations remain rigid instead of being stretched independently on
  X and Y. OpenAFIS is BSD-2-Clause licensed.
- **MCC** and **Jiang Matcher** use the Apache-2.0 `mpi-afis` reference
  implementations. Both receive the application's actual extracted minutiae as
  XYT rows; they execute separate upstream algorithms and return separate native
  `[0,1]` scores. SourceAFIS clockwise directions are converted to the
  mpi-afis convention with `(180 - angle) mod 360`. MCC templates are shifted
  independently to a fixed top-left margin before cylinder generation, which
  removes the reference implementation's absolute-position dependence without
  centering or changing local distances, angles, or matcher thresholds.

Run the setup script once from PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\setup-academic-matchers.ps1
```

Matcher failures are reported independently by the comparison API. No fallback
or fabricated score is substituted for a failed matcher. OpenAFIS alignment
diagnostics are calculated only from correspondence pairs emitted by OpenAFIS.
MCC and Jiang explicitly report that a transform is unavailable because their
native APIs do not expose selected pair correspondences.

After starting the fingerprint service, run the repeatable end-to-end check:

```powershell
npm run matchers:verify
```

The check compares exact, changed, rotation, placement, low-quality, blurry, and
partial-image scenarios; requires all five matchers to return finite independent
scores; verifies MCC/Jiang backend events; and requires OpenAFIS to return at
least one real renderable minutiae correspondence.

For the stricter repeated-impression regression on the calibrated FVC2004 DB2_B
set, run:

```powershell
npm run matchers:verify-repeated
```

Set `FVC_REPEATED_DATASET_ROOT` to exercise another FVC-style dataset containing
`101_1.tif`, `101_2.tif`, `101_3.tif`, and `102_1.tif`.
