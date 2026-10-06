from __future__ import annotations

import argparse
import csv
import io
import json
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

try:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
except Exception:
    plt = None


def safe_div(numerator: float, denominator: float) -> float:
    return numerator / denominator if denominator else 0.0


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


def select_best_f1_row(rows: Sequence[Dict]) -> Optional[Dict]:
    if not rows:
        return None
    return max(
        rows,
        key=lambda row: (
            row["f1_score_pct"],
            row["recall_pct"],
            row["precision_pct"],
            row["accuracy_pct"],
            -row["far_pct"],
        ),
    )


def select_eer_row(rows: Sequence[Dict]) -> Optional[Dict]:
    if not rows:
        return None
    return min(
        rows,
        key=lambda row: (
            abs(row["far_pct"] - row["frr_pct"]),
            (row["far_pct"] + row["frr_pct"]) / 2.0,
            -row["f1_score_pct"],
            -row["accuracy_pct"],
        ),
    )


def perform_threshold_sweep(
    scores: Sequence[float],
    labels: Sequence[int],
    threshold_start: float = 50.0,
    threshold_stop: float = 80.0,
    threshold_step: float = 2.0,
) -> Dict:
    if threshold_step <= 0:
        raise ValueError("threshold_step must be greater than 0.")
    if threshold_stop < threshold_start:
        raise ValueError("threshold_stop must be greater than or equal to threshold_start.")

    score_array = np.asarray(scores, dtype=float)
    label_array = np.asarray(labels, dtype=int)
    if score_array.shape != label_array.shape:
        raise ValueError("scores and labels must have the same shape.")
    if score_array.size == 0:
        raise ValueError("scores and labels must not be empty.")

    thresholds = np.arange(float(threshold_start), float(threshold_stop) + (float(threshold_step) / 2.0), float(threshold_step))
    rows = [compute_threshold_metrics(score_array, label_array, threshold) for threshold in thresholds]
    best_f1 = select_best_f1_row(rows)
    eer_approx = select_eer_row(rows)

    return {
        "score_count": int(score_array.size),
        "score_min": round(float(np.min(score_array)), 4),
        "score_max": round(float(np.max(score_array)), 4),
        "threshold_start": round(float(threshold_start), 4),
        "threshold_stop": round(float(threshold_stop), 4),
        "threshold_step": round(float(threshold_step), 4),
        "rows": rows,
        "best_f1": best_f1,
        "eer_approx": eer_approx,
    }


def load_score_label_csv(path: Path) -> Tuple[List[float], List[int]]:
    scores: List[float] = []
    labels: List[int] = []
    with path.open("r", encoding="utf-8", newline="") as handle:
        reader = csv.DictReader(handle)
        field_map = {name.strip().lower(): name for name in (reader.fieldnames or [])}
        required = {"score", "label"}
        if not required.issubset(field_map):
            raise ValueError("CSV must contain 'score' and 'label' columns.")

        for row in reader:
            scores.append(float(row[field_map["score"]]))
            labels.append(int(row[field_map["label"]]))
    return scores, labels


def build_threshold_csv(result: Dict) -> str:
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
    for row in result["rows"]:
        lines.append(",".join(str(row[column]) for column in headers))
    return "\n".join(lines)


def build_markdown_table(result: Dict) -> str:
    rows = result["rows"]
    best_f1 = result.get("best_f1")
    eer_approx = result.get("eer_approx")
    lines = [
        "# Threshold Sweep Analysis",
        "",
        f"- Score count: `{result['score_count']}`",
        f"- Score range: `{result['score_min']:.2f}` to `{result['score_max']:.2f}`",
        f"- Sweep: `{result['threshold_start']:.2f}` to `{result['threshold_stop']:.2f}` step `{result['threshold_step']:.2f}`",
    ]
    if best_f1:
        lines.append(
            f"- Best F1 threshold: `{best_f1['threshold']:.2f}` "
            f"(F1 `{best_f1['f1_score_pct']:.2f}%`, Precision `{best_f1['precision_pct']:.2f}%`, "
            f"Recall `{best_f1['recall_pct']:.2f}%`, FAR `{best_f1['far_pct']:.2f}%`, FRR `{best_f1['frr_pct']:.2f}%`)"
        )
    if eer_approx:
        lines.append(
            f"- EER approximation threshold: `{eer_approx['threshold']:.2f}` "
            f"(FAR `{eer_approx['far_pct']:.2f}%`, FRR `{eer_approx['frr_pct']:.2f}%`, gap `{eer_approx['far_frr_gap_pct']:.2f}%`)"
        )

    lines.extend(
        [
            "",
            "| Threshold | Accuracy | Precision | Recall | F1 | FAR | FRR | Notes |",
            "|---:|---:|---:|---:|---:|---:|---:|---|",
        ]
    )
    for row in rows:
        notes: List[str] = []
        if best_f1 and abs(row["threshold"] - best_f1["threshold"]) < 1e-9:
            notes.append("Best F1")
        if eer_approx and abs(row["threshold"] - eer_approx["threshold"]) < 1e-9:
            notes.append("EER Approx")
        note_text = " / ".join(notes) if notes else ""
        lines.append(
            f"| {row['threshold']:.2f} | {row['accuracy_pct']:.2f}% | {row['precision_pct']:.2f}% | "
            f"{row['recall_pct']:.2f}% | {row['f1_score_pct']:.2f}% | {row['far_pct']:.2f}% | "
            f"{row['frr_pct']:.2f}% | {note_text} |"
        )
    return "\n".join(lines)


def save_plot_bytes(fig, path: Path) -> Path:
    buffer = io.BytesIO()
    fig.savefig(buffer, format="png", dpi=170, bbox_inches="tight")
    plt.close(fig)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(buffer.getvalue())
    return path


def render_plots(result: Dict, output_dir: Path) -> Dict:
    if plt is None:
        return {
            "enabled": False,
            "reason": "matplotlib is not installed in this environment.",
            "far_frr_curve": None,
            "precision_recall_curve": None,
            "rate_vs_threshold_curve": None,
            "f1_vs_threshold_curve": None,
        }

    rows = result["rows"]
    best_f1 = result["best_f1"]
    eer_approx = result["eer_approx"]

    threshold_values = [row["threshold"] for row in rows]
    far_values = [row["far_pct"] for row in rows]
    frr_values = [row["frr_pct"] for row in rows]
    recall_values = [row["recall_pct"] for row in rows]
    precision_values = [row["precision_pct"] for row in rows]
    f1_values = [row["f1_score_pct"] for row in rows]

    fig_far, ax_far = plt.subplots(figsize=(8.5, 6.0))
    ax_far.plot(far_values, frr_values, marker="o", linewidth=1.8, color="#1f77b4")
    ax_far.scatter([best_f1["far_pct"]], [best_f1["frr_pct"]], color="#d62728", s=70, label="Best F1")
    ax_far.scatter([eer_approx["far_pct"]], [eer_approx["frr_pct"]], color="#2ca02c", s=70, label="EER Approx")
    ax_far.annotate(f"T={best_f1['threshold']}", (best_f1["far_pct"], best_f1["frr_pct"]), xytext=(8, 8), textcoords="offset points")
    ax_far.annotate(f"T={eer_approx['threshold']}", (eer_approx["far_pct"], eer_approx["frr_pct"]), xytext=(8, -14), textcoords="offset points")
    ax_far.set_title("FAR vs FRR Threshold Sweep")
    ax_far.set_xlabel("FAR (%)")
    ax_far.set_ylabel("FRR (%)")
    ax_far.grid(True, alpha=0.28)
    ax_far.legend()

    fig_pr, ax_pr = plt.subplots(figsize=(8.5, 6.0))
    ax_pr.plot(recall_values, precision_values, marker="o", linewidth=1.8, color="#9467bd")
    ax_pr.scatter([best_f1["recall_pct"]], [best_f1["precision_pct"]], color="#d62728", s=70, label="Best F1")
    ax_pr.scatter([eer_approx["recall_pct"]], [eer_approx["precision_pct"]], color="#2ca02c", s=70, label="EER Approx")
    ax_pr.annotate(f"T={best_f1['threshold']}", (best_f1["recall_pct"], best_f1["precision_pct"]), xytext=(8, 8), textcoords="offset points")
    ax_pr.annotate(f"T={eer_approx['threshold']}", (eer_approx["recall_pct"], eer_approx["precision_pct"]), xytext=(8, -14), textcoords="offset points")
    ax_pr.set_title("Precision vs Recall Threshold Sweep")
    ax_pr.set_xlabel("Recall (%)")
    ax_pr.set_ylabel("Precision (%)")
    ax_pr.grid(True, alpha=0.28)
    ax_pr.legend()

    fig_rates, ax_rates = plt.subplots(figsize=(8.5, 6.0))
    ax_rates.plot(threshold_values, far_values, marker="o", linewidth=1.8, color="#d62728", label="FAR")
    ax_rates.plot(threshold_values, frr_values, marker="o", linewidth=1.8, color="#1f77b4", label="FRR")
    ax_rates.axvline(best_f1["threshold"], color="#d62728", linestyle="--", alpha=0.6)
    ax_rates.axvline(eer_approx["threshold"], color="#2ca02c", linestyle="--", alpha=0.6)
    ax_rates.scatter([best_f1["threshold"]], [best_f1["far_pct"]], color="#d62728", s=70)
    ax_rates.scatter([eer_approx["threshold"]], [eer_approx["frr_pct"]], color="#2ca02c", s=70)
    ax_rates.set_title("FAR and FRR vs Threshold")
    ax_rates.set_xlabel("Threshold")
    ax_rates.set_ylabel("Rate (%)")
    ax_rates.grid(True, alpha=0.28)
    ax_rates.legend()

    fig_f1, ax_f1 = plt.subplots(figsize=(8.5, 6.0))
    ax_f1.plot(threshold_values, f1_values, marker="o", linewidth=1.8, color="#9467bd", label="F1-score")
    ax_f1.scatter([best_f1["threshold"]], [best_f1["f1_score_pct"]], color="#d62728", s=70, label="Best F1")
    ax_f1.scatter([eer_approx["threshold"]], [eer_approx["f1_score_pct"]], color="#2ca02c", s=70, label="EER Approx")
    ax_f1.axvline(best_f1["threshold"], color="#d62728", linestyle="--", alpha=0.6)
    ax_f1.axvline(eer_approx["threshold"], color="#2ca02c", linestyle="--", alpha=0.6)
    ax_f1.set_title("F1-score vs Threshold")
    ax_f1.set_xlabel("Threshold")
    ax_f1.set_ylabel("F1-score (%)")
    ax_f1.grid(True, alpha=0.28)
    ax_f1.legend()

    far_plot = save_plot_bytes(fig_far, output_dir / "threshold_far_vs_frr_curve.png")
    pr_plot = save_plot_bytes(fig_pr, output_dir / "threshold_precision_vs_recall_curve.png")
    rate_plot = save_plot_bytes(fig_rates, output_dir / "threshold_far_frr_vs_threshold.png")
    f1_plot = save_plot_bytes(fig_f1, output_dir / "threshold_f1_vs_threshold.png")
    return {
        "enabled": True,
        "reason": "",
        "far_frr_curve": str(far_plot),
        "precision_recall_curve": str(pr_plot),
        "rate_vs_threshold_curve": str(rate_plot),
        "f1_vs_threshold_curve": str(f1_plot),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Analyze fingerprint similarity thresholds from score/label data.")
    parser.add_argument("--input-csv", required=True, help="CSV file with 'score' and 'label' columns.")
    parser.add_argument("--threshold-start", type=float, default=50.0, help="Threshold sweep start value.")
    parser.add_argument("--threshold-stop", type=float, default=80.0, help="Threshold sweep stop value.")
    parser.add_argument("--threshold-step", type=float, default=2.0, help="Threshold sweep step value.")
    parser.add_argument("--output-dir", default="temp/threshold_sweep", help="Directory for CSV, JSON, markdown, and plots.")
    parser.add_argument("--skip-plots", action="store_true", help="Skip plot generation.")
    args = parser.parse_args()

    input_path = Path(args.input_csv).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    scores, labels = load_score_label_csv(input_path)
    result = perform_threshold_sweep(scores, labels, args.threshold_start, args.threshold_stop, args.threshold_step)
    result["input_csv"] = str(input_path)
    result["plots"] = (
        {
            "enabled": False,
            "reason": "Plot generation was skipped by CLI option.",
            "far_frr_curve": None,
            "precision_recall_curve": None,
            "rate_vs_threshold_curve": None,
            "f1_vs_threshold_curve": None,
        }
        if args.skip_plots
        else render_plots(result, output_dir)
    )

    csv_path = output_dir / "threshold_sweep_table.csv"
    json_path = output_dir / "threshold_sweep_results.json"
    md_path = output_dir / "THRESHOLD_SWEEP_ANALYSIS.md"
    csv_path.write_text(build_threshold_csv(result), encoding="utf-8")
    json_path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    md_path.write_text(build_markdown_table(result), encoding="utf-8")

    print(f"Saved threshold CSV to {csv_path}")
    print(f"Saved threshold JSON to {json_path}")
    print(f"Saved threshold markdown to {md_path}")
    if result["plots"].get("enabled"):
        print(f"Saved FAR/FRR curve to {result['plots']['far_frr_curve']}")
        print(f"Saved Precision/Recall curve to {result['plots']['precision_recall_curve']}")
        print(f"Saved FAR/FRR vs threshold plot to {result['plots']['rate_vs_threshold_curve']}")
        print(f"Saved F1 vs threshold plot to {result['plots']['f1_vs_threshold_curve']}")

    print(
        json.dumps(
            {
                "best_f1_threshold": round(float(result["best_f1"]["threshold"]), 2),
                "best_f1_score_pct": round(float(result["best_f1"]["f1_score_pct"]), 2),
                "eer_threshold": round(float(result["eer_approx"]["threshold"]), 2),
                "eer_far_pct": round(float(result["eer_approx"]["far_pct"]), 2),
                "eer_frr_pct": round(float(result["eer_approx"]["frr_pct"]), 2),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
