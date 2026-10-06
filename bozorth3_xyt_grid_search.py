from __future__ import annotations

import argparse
import csv
import io
import itertools
import json
import math
import subprocess
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Tuple

import numpy as np

try:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
except Exception:
    plt = None


@dataclass(frozen=True)
class Minutia:
    x: float
    y: float
    theta: float
    quality: float = 100.0


@dataclass(frozen=True)
class PairEntry:
    probe_xyt: str
    candidate_xyt: str
    label: int


@dataclass(frozen=True)
class SearchConfig:
    max_points: int
    min_distance: int
    min_required_for_match: int
    min_quality: int
    border_margin: int
    thinning_iterations: int


def safe_div(numerator: float, denominator: float) -> float:
    return numerator / denominator if denominator else 0.0


def parse_int_list(raw: str) -> List[int]:
    return [int(part.strip()) for part in raw.split(",") if part.strip()]


def load_pairs_csv(path: Path) -> List[PairEntry]:
    entries: List[PairEntry] = []
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        field_map = {name.strip().lower(): name for name in (reader.fieldnames or [])}
        required = {"probe_xyt", "candidate_xyt", "label"}
        if not required.issubset(field_map):
            raise ValueError("Pair CSV must contain 'probe_xyt', 'candidate_xyt', and 'label' columns.")

        for row in reader:
            entries.append(
                PairEntry(
                    probe_xyt=str(row[field_map["probe_xyt"]]).strip(),
                    candidate_xyt=str(row[field_map["candidate_xyt"]]).strip(),
                    label=int(row[field_map["label"]]),
                )
            )
    if not entries:
        raise ValueError("Pair CSV is empty.")
    return entries


def load_xyt(path: Path) -> List[Minutia]:
    minutiae: List[Minutia] = []
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 3:
            continue
        x = float(parts[0])
        y = float(parts[1])
        theta = float(parts[2])
        quality = float(parts[3]) if len(parts) >= 4 else 100.0
        minutiae.append(Minutia(x=x, y=y, theta=theta, quality=quality))
    return minutiae


def filter_minutiae(
    minutiae: Sequence[Minutia],
    config: SearchConfig,
    image_width: int,
    image_height: int,
) -> List[Minutia]:
    filtered = [
        point
        for point in minutiae
        if point.quality >= config.min_quality
        and point.x >= config.border_margin
        and point.y >= config.border_margin
        and point.x <= image_width - config.border_margin
        and point.y <= image_height - config.border_margin
    ]

    filtered.sort(key=lambda point: (point.quality, -abs(point.x - (image_width / 2.0)) - abs(point.y - (image_height / 2.0))), reverse=True)

    kept: List[Minutia] = []
    min_distance_sq = float(config.min_distance * config.min_distance)
    for point in filtered:
        too_close = False
        for existing in kept:
            dx = point.x - existing.x
            dy = point.y - existing.y
            if (dx * dx) + (dy * dy) < min_distance_sq:
                too_close = True
                break
        if not too_close:
            kept.append(point)
        if len(kept) >= config.max_points:
            break
    return kept


def minutiae_to_xyt_text(minutiae: Sequence[Minutia]) -> str:
    lines = [
        f"{int(round(point.x))} {int(round(point.y))} {int(round(point.theta))} {int(round(point.quality))}"
        for point in minutiae
    ]
    return "\n".join(lines) + ("\n" if lines else "")


def run_bozorth3_score(bozorth_path: str, probe_text: str, candidate_text: str) -> float:
    with tempfile.TemporaryDirectory(prefix="bozorth3_xyt_") as temp_dir:
        probe_path = Path(temp_dir) / "probe.xyt"
        candidate_path = Path(temp_dir) / "candidate.xyt"
        probe_path.write_text(probe_text, encoding="utf-8")
        candidate_path.write_text(candidate_text, encoding="utf-8")
        run = subprocess.run(
            [bozorth_path, str(probe_path), str(candidate_path)],
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
        )
        output = f"{run.stdout}\n{run.stderr}".strip()
        if run.returncode != 0:
            raise RuntimeError(f"bozorth3 failed: {output}")
        for line in output.splitlines():
            stripped = line.strip()
            if stripped.isdigit():
                return float(stripped)
        raise RuntimeError(f"Unable to parse bozorth3 score from output: {output}")


def normalize_bozorth_score(raw_score: float) -> float:
    return float(max(0.0, raw_score))


def compute_threshold_metrics(scores: np.ndarray, labels: np.ndarray, threshold: float) -> Dict:
    predicted_positive = scores >= threshold
    expected_positive = labels.astype(bool)
    tp = int(np.count_nonzero(predicted_positive & expected_positive))
    fn = int(np.count_nonzero((~predicted_positive) & expected_positive))
    fp = int(np.count_nonzero(predicted_positive & (~expected_positive)))
    tn = int(np.count_nonzero((~predicted_positive) & (~expected_positive)))

    accuracy = safe_div(tp + tn, tp + tn + fp + fn) * 100.0
    precision = safe_div(tp, tp + fp) * 100.0
    recall = safe_div(tp, tp + fn) * 100.0
    f1 = safe_div(2.0 * precision * recall, precision + recall)
    far = safe_div(fp, fp + tn) * 100.0
    frr = safe_div(fn, fn + tp) * 100.0

    return {
        "threshold": round(float(threshold), 4),
        "accuracy_pct": round(accuracy, 4),
        "precision_pct": round(precision, 4),
        "recall_pct": round(recall, 4),
        "f1_score_pct": round(f1, 4),
        "far_pct": round(far, 4),
        "frr_pct": round(frr, 4),
        "far_frr_gap_pct": round(abs(far - frr), 4),
        "tp": tp,
        "fn": fn,
        "fp": fp,
        "tn": tn,
    }


def perform_threshold_sweep(
    scores: Sequence[float],
    labels: Sequence[int],
    threshold_start: float,
    threshold_stop: float,
    threshold_step: float,
) -> Dict:
    thresholds = np.arange(float(threshold_start), float(threshold_stop) + (float(threshold_step) / 2.0), float(threshold_step))
    score_array = np.asarray(scores, dtype=float)
    label_array = np.asarray(labels, dtype=int)
    rows = [compute_threshold_metrics(score_array, label_array, threshold) for threshold in thresholds]

    best_f1 = max(
        rows,
        key=lambda row: (
            row["f1_score_pct"],
            -row["far_pct"],
            row["recall_pct"],
            row["accuracy_pct"],
        ),
    )
    eer_approx = min(
        rows,
        key=lambda row: (
            row["far_frr_gap_pct"],
            (row["far_pct"] + row["frr_pct"]) / 2.0,
            -row["f1_score_pct"],
        ),
    )
    return {
        "rows": rows,
        "best_f1": best_f1,
        "eer_approx": eer_approx,
    }


def score_config_objective(best_f1: Dict, eer_approx: Dict, far_target: float) -> Tuple:
    far_penalty = max(0.0, best_f1["far_pct"] - far_target)
    return (
        -far_penalty,
        -best_f1["far_pct"],
        best_f1["f1_score_pct"],
        -eer_approx["far_frr_gap_pct"],
        -eer_approx["far_pct"],
        -best_f1["frr_pct"],
        best_f1["accuracy_pct"],
    )


def build_threshold_plot(result: Dict, output_dir: Path, prefix: str) -> Dict:
    if plt is None:
        return {
            "enabled": False,
            "reason": "matplotlib is not installed in this environment.",
            "far_frr_plot": None,
            "f1_plot": None,
        }

    rows = result["threshold_sweep"]["rows"]
    best_f1 = result["threshold_sweep"]["best_f1"]
    eer_approx = result["threshold_sweep"]["eer_approx"]
    thresholds = [row["threshold"] for row in rows]
    far_values = [row["far_pct"] for row in rows]
    frr_values = [row["frr_pct"] for row in rows]
    f1_values = [row["f1_score_pct"] for row in rows]

    fig_far, ax_far = plt.subplots(figsize=(8.5, 6.0))
    ax_far.plot(thresholds, far_values, label="FAR", color="#d62728", linewidth=1.8)
    ax_far.plot(thresholds, frr_values, label="FRR", color="#1f77b4", linewidth=1.8)
    ax_far.scatter([best_f1["threshold"]], [best_f1["far_pct"]], color="#d62728", s=70)
    ax_far.scatter([eer_approx["threshold"]], [eer_approx["frr_pct"]], color="#2ca02c", s=70)
    ax_far.axvline(best_f1["threshold"], color="#d62728", linestyle="--", alpha=0.6)
    ax_far.axvline(eer_approx["threshold"], color="#2ca02c", linestyle="--", alpha=0.6)
    ax_far.set_title("FAR and FRR vs Threshold")
    ax_far.set_xlabel("Threshold")
    ax_far.set_ylabel("Rate (%)")
    ax_far.grid(True, alpha=0.28)
    ax_far.legend()

    fig_f1, ax_f1 = plt.subplots(figsize=(8.5, 6.0))
    ax_f1.plot(thresholds, f1_values, label="F1-score", color="#9467bd", linewidth=1.8)
    ax_f1.scatter([best_f1["threshold"]], [best_f1["f1_score_pct"]], color="#d62728", s=70, label="Best F1")
    ax_f1.scatter([eer_approx["threshold"]], [eer_approx["f1_score_pct"]], color="#2ca02c", s=70, label="EER Approx")
    ax_f1.axvline(best_f1["threshold"], color="#d62728", linestyle="--", alpha=0.6)
    ax_f1.axvline(eer_approx["threshold"], color="#2ca02c", linestyle="--", alpha=0.6)
    ax_f1.set_title("F1-score vs Threshold")
    ax_f1.set_xlabel("Threshold")
    ax_f1.set_ylabel("F1-score (%)")
    ax_f1.grid(True, alpha=0.28)
    ax_f1.legend()

    output_dir.mkdir(parents=True, exist_ok=True)
    far_path = output_dir / f"{prefix}_far_frr_vs_threshold.png"
    f1_path = output_dir / f"{prefix}_f1_vs_threshold.png"

    far_buffer = io.BytesIO()
    fig_far.savefig(far_buffer, format="png", dpi=170, bbox_inches="tight")
    plt.close(fig_far)
    far_path.write_bytes(far_buffer.getvalue())

    f1_buffer = io.BytesIO()
    fig_f1.savefig(f1_buffer, format="png", dpi=170, bbox_inches="tight")
    plt.close(fig_f1)
    f1_path.write_bytes(f1_buffer.getvalue())

    return {
        "enabled": True,
        "reason": "",
        "far_frr_plot": str(far_path),
        "f1_plot": str(f1_path),
    }


def build_threshold_csv(rows: Sequence[Dict]) -> str:
    headers = [
        "threshold",
        "accuracy_pct",
        "precision_pct",
        "recall_pct",
        "f1_score_pct",
        "far_pct",
        "frr_pct",
        "far_frr_gap_pct",
        "tp",
        "fn",
        "fp",
        "tn",
    ]
    lines = [",".join(headers)]
    for row in rows:
        lines.append(",".join(str(row[column]) for column in headers))
    return "\n".join(lines)


def build_config_summary(best_result: Dict) -> str:
    config = best_result["config"]
    best_f1 = best_result["threshold_sweep"]["best_f1"]
    eer_approx = best_result["threshold_sweep"]["eer_approx"]
    return "\n".join(
        [
            "# Bozorth3 XYT Grid Search",
            "",
            "## Best Configuration",
            "",
            f"- maxPoints: `{config['max_points']}`",
            f"- minDistance: `{config['min_distance']}`",
            f"- minRequiredForMatch: `{config['min_required_for_match']}`",
            f"- minQuality: `{config['min_quality']}`",
            f"- borderMargin: `{config['border_margin']}`",
            f"- thinningIterations: `{config['thinning_iterations']}`",
            "",
            "## Best-F1 Threshold",
            "",
            f"- threshold: `{best_f1['threshold']:.2f}`",
            f"- accuracy: `{best_f1['accuracy_pct']:.2f}%`",
            f"- precision: `{best_f1['precision_pct']:.2f}%`",
            f"- recall: `{best_f1['recall_pct']:.2f}%`",
            f"- f1_score: `{best_f1['f1_score_pct']:.2f}%`",
            f"- FAR: `{best_f1['far_pct']:.2f}%`",
            f"- FRR: `{best_f1['frr_pct']:.2f}%`",
            "",
            "## EER Approximation",
            "",
            f"- threshold: `{eer_approx['threshold']:.2f}`",
            f"- FAR: `{eer_approx['far_pct']:.2f}%`",
            f"- FRR: `{eer_approx['frr_pct']:.2f}%`",
            f"- gap: `{eer_approx['far_frr_gap_pct']:.2f}%`",
        ]
    )


def evaluate_configuration(
    pairs: Sequence[PairEntry],
    bozorth_path: str,
    config: SearchConfig,
    image_width: int,
    image_height: int,
    threshold_start: float,
    threshold_stop: float,
    threshold_step: float,
) -> Dict:
    minutiae_cache: Dict[str, List[Minutia]] = {}
    filtered_cache: Dict[Tuple[str, SearchConfig], List[Minutia]] = {}
    scores: List[float] = []
    labels: List[int] = []

    def get_filtered(path_text: str) -> List[Minutia]:
        path = str(Path(path_text).resolve())
        cache_key = (path, config)
        if cache_key in filtered_cache:
            return filtered_cache[cache_key]
        if path not in minutiae_cache:
            minutiae_cache[path] = load_xyt(Path(path))
        filtered = filter_minutiae(minutiae_cache[path], config, image_width, image_height)
        filtered_cache[cache_key] = filtered
        return filtered

    for pair in pairs:
        probe = get_filtered(pair.probe_xyt)
        candidate = get_filtered(pair.candidate_xyt)
        if len(probe) < config.min_required_for_match or len(candidate) < config.min_required_for_match:
            raw_score = 0.0
        else:
            raw_score = run_bozorth3_score(
                bozorth_path,
                minutiae_to_xyt_text(probe),
                minutiae_to_xyt_text(candidate),
            )
        scores.append(normalize_bozorth_score(raw_score))
        labels.append(int(pair.label))

    threshold_sweep = perform_threshold_sweep(scores, labels, threshold_start, threshold_stop, threshold_step)
    return {
        "config": asdict(config),
        "score_min": round(float(min(scores)), 4) if scores else 0.0,
        "score_max": round(float(max(scores)), 4) if scores else 0.0,
        "threshold_sweep": threshold_sweep,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Grid-search practical Bozorth3 XYT filtering parameters to reduce FAR.")
    parser.add_argument("--pairs-csv", required=True, help="CSV with probe_xyt,candidate_xyt,label columns.")
    parser.add_argument("--bozorth3-path", required=True, help="Path to the bozorth3 executable.")
    parser.add_argument("--output-dir", default="temp/bozorth3_xyt_grid_search", help="Output directory.")
    parser.add_argument("--image-width", type=int, default=500, help="Image width used for border-margin filtering.")
    parser.add_argument("--image-height", type=int, default=500, help="Image height used for border-margin filtering.")
    parser.add_argument("--max-points-grid", default="90,110,120,140", help="Comma-separated grid for maxPoints.")
    parser.add_argument("--min-distance-grid", default="7,9,11", help="Comma-separated grid for minDistance.")
    parser.add_argument("--min-required-grid", default="18,20,22,24", help="Comma-separated grid for minRequiredForMatch.")
    parser.add_argument("--min-quality-grid", default="24,28,32,36", help="Comma-separated grid for minQuality.")
    parser.add_argument("--border-margin-grid", default="18,22,26", help="Comma-separated grid for borderMargin.")
    parser.add_argument("--thinning-iterations-grid", default="10,12", help="Comma-separated grid for thinningIterations. This is reported for extraction tuning but does not change existing XYT points.")
    parser.add_argument("--threshold-start", type=float, default=50.0, help="Threshold sweep start value.")
    parser.add_argument("--threshold-stop", type=float, default=80.0, help="Threshold sweep stop value.")
    parser.add_argument("--threshold-step", type=float, default=2.0, help="Threshold sweep step value.")
    parser.add_argument("--far-target", type=float, default=20.0, help="Preferred upper bound for FAR during config selection.")
    parser.add_argument("--skip-plots", action="store_true", help="Skip matplotlib plot generation.")
    args = parser.parse_args()

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    pairs = load_pairs_csv(Path(args.pairs_csv).resolve())
    max_points_grid = parse_int_list(args.max_points_grid)
    min_distance_grid = parse_int_list(args.min_distance_grid)
    min_required_grid = parse_int_list(args.min_required_grid)
    min_quality_grid = parse_int_list(args.min_quality_grid)
    border_margin_grid = parse_int_list(args.border_margin_grid)
    thinning_iterations_grid = parse_int_list(args.thinning_iterations_grid)

    best_result: Optional[Dict] = None
    best_key: Optional[Tuple] = None
    tried_results: List[Dict] = []

    for config_values in itertools.product(
        max_points_grid,
        min_distance_grid,
        min_required_grid,
        min_quality_grid,
        border_margin_grid,
        thinning_iterations_grid,
    ):
        config = SearchConfig(
            max_points=config_values[0],
            min_distance=config_values[1],
            min_required_for_match=config_values[2],
            min_quality=config_values[3],
            border_margin=config_values[4],
            thinning_iterations=config_values[5],
        )
        result = evaluate_configuration(
            pairs,
            args.bozorth3_path,
            config,
            args.image_width,
            args.image_height,
            args.threshold_start,
            args.threshold_stop,
            args.threshold_step,
        )
        best_f1 = result["threshold_sweep"]["best_f1"]
        eer_approx = result["threshold_sweep"]["eer_approx"]
        ranking_key = score_config_objective(best_f1, eer_approx, args.far_target)
        tried_results.append(
            {
                "config": result["config"],
                "best_f1": best_f1,
                "eer_approx": eer_approx,
                "ranking_key": ranking_key,
            }
        )
        if best_key is None or ranking_key > best_key:
            best_key = ranking_key
            best_result = result

    if best_result is None:
        raise SystemExit("No grid-search result was produced.")

    plots = (
        {
            "enabled": False,
            "reason": "Plot generation was skipped by CLI option.",
            "far_frr_plot": None,
            "f1_plot": None,
        }
        if args.skip_plots
        else build_threshold_plot(best_result, output_dir, "best_config")
    )
    best_result["plots"] = plots
    best_result["grid_search"] = {
        "pairs_csv": str(Path(args.pairs_csv).resolve()),
        "bozorth3_path": args.bozorth3_path,
        "image_width": args.image_width,
        "image_height": args.image_height,
        "far_target": args.far_target,
        "tested_configurations": len(tried_results),
        "parameter_grid": {
            "max_points": max_points_grid,
            "min_distance": min_distance_grid,
            "min_required_for_match": min_required_grid,
            "min_quality": min_quality_grid,
            "border_margin": border_margin_grid,
            "thinning_iterations": thinning_iterations_grid,
        },
        "ranked_results": tried_results,
    }

    (output_dir / "best_config_threshold_sweep.csv").write_text(
        build_threshold_csv(best_result["threshold_sweep"]["rows"]),
        encoding="utf-8",
    )
    (output_dir / "best_config_summary.md").write_text(
        build_config_summary(best_result),
        encoding="utf-8",
    )
    (output_dir / "best_config_results.json").write_text(
        json.dumps(best_result, indent=2),
        encoding="utf-8",
    )

    print(f"Saved threshold sweep CSV to {output_dir / 'best_config_threshold_sweep.csv'}")
    print(f"Saved summary markdown to {output_dir / 'best_config_summary.md'}")
    print(f"Saved result JSON to {output_dir / 'best_config_results.json'}")
    if plots.get("enabled"):
        print(f"Saved FAR/FRR plot to {plots['far_frr_plot']}")
        print(f"Saved F1 plot to {plots['f1_plot']}")
    else:
        print(f"Plot generation: {plots.get('reason', 'disabled')}")

    best_f1 = best_result["threshold_sweep"]["best_f1"]
    eer_approx = best_result["threshold_sweep"]["eer_approx"]
    print(
        json.dumps(
            {
                "best_config": best_result["config"],
                "best_f1_threshold": best_f1["threshold"],
                "best_f1_score_pct": best_f1["f1_score_pct"],
                "best_f1_far_pct": best_f1["far_pct"],
                "best_f1_frr_pct": best_f1["frr_pct"],
                "eer_threshold": eer_approx["threshold"],
                "eer_far_pct": eer_approx["far_pct"],
                "eer_frr_pct": eer_approx["frr_pct"],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
