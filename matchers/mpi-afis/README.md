# mpi-afis MCC and Jiang adapters

This module runs the actual Apache-2.0 `mpi-afis` implementations of:

- Minutia Cylinder-Code with `Ns=8` and LSSR consolidation;
- Jiang and Yau local/global minutiae-structure matching.

Both executables consume the application extractor's minutiae through the
upstream XYT reader. Each row is `x y direction quality`; direction is expressed
in half-degree units because `mpi-afis` doubles the XYT value internally.

The upstream implementations return native similarities in `[0,1]`. The Node
adapter preserves that raw score and exposes `raw * 100` only as Normalized
Similarity, not confidence. Default decision thresholds are configurable and
must be calibrated on the benchmark dataset before research conclusions are
drawn.

The standalone upstream interface exposes a score but not the selected minutia
pairs. The UI therefore states that detailed correspondence visualization is
unavailable rather than constructing lines from another matcher.

Run `npm run matchers:setup` to download and compile the reference source.
