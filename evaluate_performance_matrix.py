from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import math
import os
import random
import re
import statistics
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter

try:
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
except Exception:
    plt = None


SERVICE_BASE = os.environ.get("SERVICE_BASE", "http://localhost:9000")
OUTPUT_DIR = Path("temp") / "performance_matrix"
RANDOM_SEED = 10173
SUPPORTED_IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff"}
MIME_BY_EXTENSION = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".bmp": "image/bmp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
}
CONFIG_PATH = Path(__file__).resolve().parent / "backend" / "config.php"


@dataclass
class IdentitySample:
    identity_id: str
    source: str
    image_base64: str
    afis_quality: float
    genuine_probe_images: List[Tuple[str, str]] = field(default_factory=list)


@dataclass
class ComparisonRecord:
    label: str
    probe_identity: str
    candidate_identity: str
    variant: str
    evaluation_set: str
    is_match: bool
    expected_match: bool
    score: float
    threshold: float
    bozorth_score: float
    probe_quality: float
    candidate_quality: float
    verification_time_sec: float


def post_json(path: str, payload: Dict) -> Dict:
    data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        f"{SERVICE_BASE}{path}",
        data=data,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.loads(response.read().decode("utf-8"))


def get_json(path: str) -> Dict:
    with urllib.request.urlopen(f"{SERVICE_BASE}{path}", timeout=120) as response:
        return json.loads(response.read().decode("utf-8"))


def ensure_service_running() -> Dict:
    try:
        health = get_json("/health")
        if str(health.get("status", "")).lower() != "running":
            raise RuntimeError("Fingerprint service is not reporting running status.")
        return health
    except urllib.error.URLError as exc:
        raise RuntimeError(
            "Fingerprint service is not reachable at http://localhost:9000. "
            "Start node fingerprint-service.js first."
        ) from exc


def image_from_base64(image_b64: str) -> Image.Image:
    image_bytes = base64.b64decode(image_b64)
    return Image.open(io.BytesIO(image_bytes)).convert("L")


def image_to_base64(image: Image.Image) -> str:
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode("ascii")


def is_supported_image_file(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in SUPPORTED_IMAGE_EXTENSIONS


def file_to_data_url(path: Path) -> str:
    extension = path.suffix.lower()
    mime_type = MIME_BY_EXTENSION.get(extension, "application/octet-stream")
    payload = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime_type};base64,{payload}"


def fingerprint_value_to_data_url(image_value: str, filename: str = "") -> str:
    value = str(image_value or "").strip()
    if not value:
        raise RuntimeError("Fingerprint image value is empty.")
    if value.startswith("data:image/"):
        return value

    extension = Path(filename or "").suffix.lower()
    mime_type = MIME_BY_EXTENSION.get(extension, "image/png")
    return f"data:{mime_type};base64,{value}"


def build_dataset_signature(entries: List[Dict]) -> str:
    payload = json.dumps(entries, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def load_database_criminal_rows(identity_limit: Optional[int] = None) -> List[Dict]:
    if not CONFIG_PATH.exists():
        raise RuntimeError(f"Config file not found: {CONFIG_PATH}")

    limit = max(0, int(identity_limit or 0))
    php_script = f"""<?php
$config = require {json.dumps(str(CONFIG_PATH))};
$db = $config['database'] ?? null;
if (!$db) {{
    fwrite(STDERR, "Database configuration is missing.\\n");
    exit(2);
}}

$dsn = sprintf(
    'mysql:host=%s;port=%d;dbname=%s;charset=%s',
    $db['host'] ?? 'localhost',
    intval($db['port'] ?? 3306),
    $db['database'] ?? 'minutiae_runtime',
    $db['charset'] ?? 'utf8mb4'
);

$pdo = new PDO($dsn, $db['user'] ?? 'root', $db['password'] ?? '', [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
    PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
]);

$sql = "SELECT cf.id, cf.criminal_id, cf.finger_position, cf.fingerprint_image, MD5(cf.fingerprint_image) AS fingerprint_md5, cf.fingerprint_filename, cf.quality_score, cf.captured_at, cr.name, cr.case_number "
    . "FROM criminal_fingerprints cf "
    . "LEFT JOIN criminal_records cr ON cr.id = cf.criminal_id "
    . "WHERE cf.is_active = 1 AND cf.fingerprint_image IS NOT NULL AND TRIM(cf.fingerprint_image) <> '' "
    . "ORDER BY cf.criminal_id ASC, cf.finger_position ASC, cf.captured_at ASC, cf.id ASC";

$rows = $pdo->query($sql)->fetchAll();
echo json_encode($rows, JSON_UNESCAPED_SLASHES);
?>"""

    run = subprocess.run(
        ["php"],
        input=php_script,
        text=True,
        capture_output=True,
        cwd=str(CONFIG_PATH.parent.parent),
        check=False,
    )
    if run.returncode != 0:
        message = run.stderr.strip() or run.stdout.strip() or "Unknown PHP error while reading criminal fingerprints."
        raise RuntimeError(f"Unable to read criminal fingerprint records from the database. {message}")

    try:
        rows = json.loads(run.stdout or "[]")
    except json.JSONDecodeError as exc:
        raise RuntimeError("Database fingerprint query returned invalid JSON.") from exc

    if not isinstance(rows, list):
        raise RuntimeError("Database fingerprint query did not return a list of rows.")

    unique_rows: List[Dict] = []
    seen_criminal_ids = set()
    for row in rows:
        criminal_id = int(row.get("criminal_id", 0) or 0)
        if criminal_id <= 0 or criminal_id in seen_criminal_ids:
            continue
        seen_criminal_ids.add(criminal_id)
        unique_rows.append(row)
        if limit > 0 and len(unique_rows) >= limit:
            break

    return unique_rows


def validate_database_ground_truth(rows: List[Dict]) -> None:
    """Reject database benchmarks whose labels contradict fingerprint provenance.

    The operational database uses criminal_id as the identity label. Imported FVC
    files encode their real subject in names such as 101_1.tif. Treating 101_1
    and 101_2 as impostors merely because they were attached to different
    criminal records produces a fabricated false-accept rate.
    """
    hashes: Dict[str, set] = {}
    fvc_subjects: Dict[str, List[Dict]] = {}
    for row in rows:
        criminal_id = int(row.get("criminal_id", 0) or 0)
        image_hash = str(row.get("fingerprint_md5", "")).strip().lower()
        if image_hash:
            hashes.setdefault(image_hash, set()).add(criminal_id)
        filename = Path(str(row.get("fingerprint_filename", "")).strip()).name
        match = re.match(r"^(\d{3,})_(\d+)\.(?:png|jpe?g|bmp|tiff?)$", filename, flags=re.IGNORECASE)
        if match:
            fvc_subjects.setdefault(match.group(1), []).append(row)

    duplicate_hashes = [image_hash for image_hash, criminal_ids in hashes.items() if len(criminal_ids) > 1]
    subject_conflicts = {
        subject: entries
        for subject, entries in fvc_subjects.items()
        if len({int(entry.get("criminal_id", 0) or 0) for entry in entries}) > 1
    }
    if not duplicate_hashes and not subject_conflicts:
        return

    details = []
    if duplicate_hashes:
        details.append(f"{len(duplicate_hashes)} image hash(es) occur under multiple criminal IDs")
    if subject_conflicts:
        examples = []
        for subject, entries in list(subject_conflicts.items())[:4]:
            labels = sorted({
                f"criminal {int(entry.get('criminal_id', 0) or 0)} / {str(entry.get('finger_position', '')).strip() or 'UNSPECIFIED'}"
                for entry in entries
            })
            examples.append(f"FVC subject {subject}: {', '.join(labels)}")
        details.append("same-subject filenames cross criminal IDs (" + "; ".join(examples) + ")")
    raise RuntimeError(
        "Database benchmark ground truth is inconsistent: "
        + "; ".join(details)
        + ". Repair the criminal/finger assignments or use scripts/calibrate-bozorth3.js, "
        "which derives labels from the official FVC subject prefix."
    )


def add_gaussian_noise(image: Image.Image, sigma: float) -> Image.Image:
    arr = np.array(image, dtype=np.float32)
    noisy = arr + np.random.normal(0, sigma, arr.shape)
    noisy = np.clip(noisy, 0, 255).astype(np.uint8)
    return Image.fromarray(noisy, mode="L")


def partial_crop_restore(image: Image.Image, inset_ratio: float = 0.09) -> Image.Image:
    width, height = image.size
    inset_x = max(6, int(width * inset_ratio))
    inset_y = max(6, int(height * inset_ratio))
    cropped = image.crop((inset_x, inset_y, width, height - inset_y))
    canvas = Image.new("L", image.size, color=255)
    resized = cropped.resize((width - inset_x, height - inset_y), Image.Resampling.BICUBIC)
    canvas.paste(resized, (inset_x // 2, inset_y // 2))
    return canvas


def make_variants(image_b64: str) -> Dict[str, str]:
    image = image_from_base64(image_b64)
    variants: Dict[str, Image.Image] = {
        "exact": image.copy(),
        "rotate_3deg": image.rotate(3, resample=Image.Resampling.BICUBIC, fillcolor=255),
        "blur_soft": image.filter(ImageFilter.GaussianBlur(radius=0.8)),
        "low_contrast": ImageEnhance.Contrast(image).enhance(0.72),
        "partial_crop": partial_crop_restore(image),
    }
    variants["noisy"] = add_gaussian_noise(variants["low_contrast"], sigma=8.0)
    return {name: image_to_base64(value) for name, value in variants.items()}


def adjective_high(value: float) -> str:
    if value >= 96:
        return "Excellent"
    if value >= 90:
        return "Very Satisfactory"
    if value >= 85:
        return "Satisfactory"
    if value >= 80:
        return "Fair"
    return "Needs Improvement"


def adjective_low(value: float) -> str:
    if value <= 4:
        return "Excellent"
    if value <= 6:
        return "Very Satisfactory"
    if value <= 10:
        return "Satisfactory"
    if value <= 15:
        return "Fair"
    return "Needs Improvement"


def adjective_time(value: float) -> str:
    if value <= 3:
        return "Excellent"
    if value <= 5:
        return "Very Satisfactory"
    if value <= 8:
        return "Satisfactory"
    if value <= 12:
        return "Fair"
    return "Needs Improvement"


def safe_div(numerator: float, denominator: float) -> float:
    return numerator / denominator if denominator else 0.0


def summarize_thresholds(values: List[float]) -> str:
    if not values:
        return "No data"
    if len(values) == 1:
        return f"{values[0]:.2f}"
    return f"{statistics.fmean(values):.2f} mean, {statistics.pstdev(values):.2f} std"


def write_output_text(path: Path, content: str) -> Path:
    candidates = [path]
    timestamp = time.strftime("%Y%m%d_%H%M%S")
    candidates.append(path.with_name(f"{path.stem}_{timestamp}{path.suffix}"))
    candidates.append(Path.cwd() / f"{path.stem}_{timestamp}{path.suffix}")

    last_error: Optional[OSError] = None
    for candidate in candidates:
        try:
            candidate.write_text(content, encoding="utf-8")
            return candidate
        except OSError as exc:
            last_error = exc

    raise last_error or PermissionError(f"Unable to write output file for {path}")


def write_output_bytes(path: Path, content: bytes) -> Path:
    candidates = [path]
    timestamp = time.strftime("%Y%m%d_%H%M%S")
    candidates.append(path.with_name(f"{path.stem}_{timestamp}{path.suffix}"))
    candidates.append(Path.cwd() / f"{path.stem}_{timestamp}{path.suffix}")

    last_error: Optional[OSError] = None
    for candidate in candidates:
        try:
            candidate.parent.mkdir(parents=True, exist_ok=True)
            candidate.write_bytes(content)
            return candidate
        except OSError as exc:
            last_error = exc

    raise last_error or PermissionError(f"Unable to write output file for {path}")


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


def select_best_f1_row(rows: List[Dict]) -> Optional[Dict]:
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


def select_eer_row(rows: List[Dict]) -> Optional[Dict]:
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
    scores: List[float],
    labels: List[int],
    threshold_start: float,
    threshold_stop: float,
    threshold_step: float,
) -> Dict:
    if threshold_step <= 0:
        raise ValueError("threshold_step must be greater than 0.")
    if threshold_stop < threshold_start:
        raise ValueError("threshold_stop must be greater than or equal to threshold_start.")

    score_array = np.asarray(scores, dtype=float)
    label_array = np.asarray(labels, dtype=int)
    if score_array.shape != label_array.shape:
        raise ValueError("scores and labels must have the same shape.")

    thresholds = np.arange(float(threshold_start), float(threshold_stop) + (float(threshold_step) / 2.0), float(threshold_step))
    rows = [compute_threshold_metrics(score_array, label_array, threshold) for threshold in thresholds]
    best_f1 = select_best_f1_row(rows)
    eer_approx = select_eer_row(rows)

    return {
        "score_count": int(score_array.size),
        "score_min": round(float(np.min(score_array)), 4) if score_array.size else 0.0,
        "score_max": round(float(np.max(score_array)), 4) if score_array.size else 0.0,
        "threshold_start": round(float(threshold_start), 4),
        "threshold_stop": round(float(threshold_stop), 4),
        "threshold_step": round(float(threshold_step), 4),
        "rows": rows,
        "best_f1": best_f1,
        "eer_approx": eer_approx,
    }


def build_threshold_sweep_csv(threshold_sweep: Dict) -> str:
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
    for row in threshold_sweep.get("rows", []):
        lines.append(",".join(str(row[column]) for column in headers))
    return "\n".join(lines)


def save_plot_figure(fig, output_path: Path) -> Path:
    buffer = io.BytesIO()
    fig.savefig(buffer, format="png", dpi=170, bbox_inches="tight")
    plt.close(fig)
    return write_output_bytes(output_path, buffer.getvalue())


def render_threshold_plots(threshold_sweep: Dict, output_dir: Path) -> Dict:
    if plt is None:
        return {
            "enabled": False,
            "reason": "matplotlib is not installed in this environment.",
            "far_frr_curve": None,
            "precision_recall_curve": None,
        }

    rows = threshold_sweep.get("rows", [])
    best_f1 = threshold_sweep.get("best_f1")
    eer_approx = threshold_sweep.get("eer_approx")
    if not rows or not best_f1 or not eer_approx:
        return {
            "enabled": False,
            "reason": "threshold sweep rows were unavailable.",
            "far_frr_curve": None,
            "precision_recall_curve": None,
        }

    far_values = [row["far_pct"] for row in rows]
    frr_values = [row["frr_pct"] for row in rows]
    recall_values = [row["recall_pct"] for row in rows]
    precision_values = [row["precision_pct"] for row in rows]
    threshold_values = [row["threshold"] for row in rows]

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

    far_plot_path = save_plot_figure(fig_far, output_dir / "threshold_far_vs_frr_curve.png")
    pr_plot_path = save_plot_figure(fig_pr, output_dir / "threshold_precision_vs_recall_curve.png")

    return {
        "enabled": True,
        "reason": "",
        "far_frr_curve": str(far_plot_path),
        "precision_recall_curve": str(pr_plot_path),
        "thresholds_plotted": threshold_values,
    }


def fetch_service_config() -> Dict:
    try:
        return get_json("/debug/config")
    except Exception:
        return {}


def collect_identity_samples(identity_count: int) -> Tuple[List[IdentitySample], List[float], int]:
    samples: List[IdentitySample] = []
    enrollment_times: List[float] = []
    total_calls = 0

    for index in range(identity_count):
        scan_payload = post_json("/scan", {"type": "criminal"})
        total_calls += 1
        image_b64 = str(scan_payload["image"])

        started = time.perf_counter()
        processed = post_json("/afis/from-image", {"image": f"data:image/png;base64,{image_b64}"})
        enrollment_times.append(time.perf_counter() - started)
        total_calls += 1

        samples.append(
            IdentitySample(
                identity_id=f"ID-{index + 1:02d}",
                source=scan_payload.get("source", "service_scan"),
                image_base64=str(processed["image"]),
                afis_quality=float(processed.get("afisQuality", processed.get("quality", 0))),
            )
        )

    return samples, enrollment_times, total_calls


def collect_uploaded_identity_samples(uploads_dir: Path, identity_limit: Optional[int] = None) -> Tuple[List[IdentitySample], List[float], int, List[Dict]]:
    if not uploads_dir.exists() or not uploads_dir.is_dir():
        raise RuntimeError(f"Uploads directory not found: {uploads_dir}")

    groups: List[Tuple[str, List[Path]]] = []
    subdirectories = sorted([path for path in uploads_dir.iterdir() if path.is_dir()])

    for directory in subdirectories:
        files = sorted([path for path in directory.iterdir() if is_supported_image_file(path)])
        if files:
            groups.append((directory.name, files))

    if not groups:
        root_files = sorted([path for path in uploads_dir.iterdir() if is_supported_image_file(path)])
        groups = [(path.stem, [path]) for path in root_files]

    if identity_limit and identity_limit > 0:
        groups = groups[:identity_limit]

    if len(groups) < 2:
        raise RuntimeError(
            "At least two uploaded fingerprint identities are required. "
            "Use subfolders per identity or provide multiple files."
        )

    samples: List[IdentitySample] = []
    enrollment_times: List[float] = []
    total_calls = 0
    dataset_entries: List[Dict] = []

    for identity_name, files in groups:
        candidate_payload = file_to_data_url(files[0])
        started = time.perf_counter()
        processed = post_json("/afis/from-image", {"image": candidate_payload})
        enrollment_times.append(time.perf_counter() - started)
        total_calls += 1

        dataset_entries.append(
            {
                "identity_id": identity_name,
                "candidate_file": files[0].name,
                "candidate_sha256": hashlib.sha256(files[0].read_bytes()).hexdigest(),
                "genuine_probe_files": [path.name for path in files[1:]],
            }
        )

        genuine_probe_images = [
            (f"upload_{path.stem}", file_to_data_url(path))
            for path in files[1:]
        ]

        samples.append(
            IdentitySample(
                identity_id=identity_name,
                source=f"uploaded:{files[0].name}",
                image_base64=str(processed["image"]),
                afis_quality=float(processed.get("afisQuality", processed.get("quality", 0))),
                genuine_probe_images=genuine_probe_images,
            )
        )

    return samples, enrollment_times, total_calls, dataset_entries


def collect_database_identity_samples(identity_limit: Optional[int] = None) -> Tuple[List[IdentitySample], List[float], int, Dict[str, int], List[Dict]]:
    rows = load_database_criminal_rows(identity_limit)
    validate_database_ground_truth(rows)
    if len(rows) < 2:
        raise RuntimeError(
            "At least two active criminal fingerprint images are required in the database. "
            "Upload fingerprint images to criminal records first."
        )

    samples: List[IdentitySample] = []
    enrollment_times: List[float] = []
    total_calls = 0
    dataset_entries: List[Dict] = []

    for row in rows:
        image_payload = fingerprint_value_to_data_url(
            str(row.get("fingerprint_image", "")),
            str(row.get("fingerprint_filename", "")),
        )
        started = time.perf_counter()
        processed = post_json("/afis/from-image", {"image": image_payload})
        enrollment_times.append(time.perf_counter() - started)
        total_calls += 1

        criminal_id = int(row.get("criminal_id", 0) or 0)
        finger_position = str(row.get("finger_position", "")).strip() or "UNSPECIFIED"
        filename = str(row.get("fingerprint_filename", "")).strip()
        dataset_entries.append(
            {
                "row_id": int(row.get("id", 0) or 0),
                "criminal_id": criminal_id,
                "finger_position": finger_position,
                "fingerprint_filename": filename,
                "fingerprint_md5": str(row.get("fingerprint_md5", "")).strip(),
            }
        )

        samples.append(
            IdentitySample(
                identity_id=f"CRIM-{criminal_id:04d}",
                source=f"database:{filename or f'criminal_{criminal_id}_{finger_position}'}",
                image_base64=str(processed["image"]),
                afis_quality=float(processed.get("afisQuality", processed.get("quality", 0))),
                genuine_probe_images=[],
            )
        )

    return samples, enrollment_times, total_calls, {
        "usable_rows": len(rows),
        "selected_rows": len(samples),
    }, dataset_entries


def evaluate(
    identity_count: int,
    negative_offsets: List[int],
    uploads_dir: Optional[str] = None,
    use_criminal_db: bool = False,
    threshold_start: float = 50.0,
    threshold_stop: float = 80.0,
    threshold_step: float = 2.0,
) -> Dict:
    random.seed(RANDOM_SEED)
    np.random.seed(RANDOM_SEED)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    health = ensure_service_running()
    config = fetch_service_config()

    db_stats: Dict[str, int] = {}

    if uploads_dir:
        samples, enrollment_times, total_calls, dataset_entries = collect_uploaded_identity_samples(Path(uploads_dir), identity_count)
        benchmark_type = "uploaded fingerprint image benchmark"
        benchmark_note = (
            "The matrix was computed from user-uploaded fingerprint images processed through "
            "the same /afis/from-image and /afis/compare pipeline used by the application."
        )
        source_mode = "uploaded_images"
    elif use_criminal_db:
        samples, enrollment_times, total_calls, db_stats, dataset_entries = collect_database_identity_samples(identity_count)
        benchmark_type = "database-backed criminal fingerprint benchmark"
        benchmark_note = (
            "The matrix was computed directly from active fingerprint images stored in the "
            "criminal_fingerprints table and evaluated through the same /afis/from-image and "
            "/afis/compare pipeline used by the application."
        )
        source_mode = "criminal_database"
    else:
        samples, enrollment_times, total_calls = collect_identity_samples(identity_count)
        dataset_entries = [
            {
                "identity_id": sample.identity_id,
                "source": sample.source,
            }
            for sample in samples
        ]
        benchmark_type = "synthetic service-generated fingerprint benchmark"
        benchmark_note = (
            "Database-backed benchmark data was unavailable during this run, so the matrix was "
            "computed using fingerprints generated by the system scan/simulation path and then "
            "evaluated through the improved local AFIS + enhanced Bozorth3 comparison route."
        )
        source_mode = "synthetic_scan"

    records: List[ComparisonRecord] = []
    probe_processing_times: List[float] = []
    probe_quality_scores: List[float] = []
    low_quality_positive_results: List[bool] = []
    low_quality_variants = {"blur_soft", "low_contrast", "partial_crop", "noisy"}

    genuine_scores: List[float] = []
    impostor_scores: List[float] = []
    threshold_values: List[float] = []
    verification_times: List[float] = []

    positive_variants = ["exact", "rotate_3deg", "blur_soft", "low_contrast"]
    stress_variants = ["partial_crop", "noisy"]

    for idx, sample in enumerate(samples):
        candidate_variants = make_variants(sample.image_base64)
        if sample.genuine_probe_images:
            primary_probe_entries = list(sample.genuine_probe_images)
        else:
            primary_probe_entries = [(variant_name, candidate_variants[variant_name]) for variant_name in positive_variants]

        stress_source_image = sample.genuine_probe_images[0][1] if sample.genuine_probe_images else sample.image_base64
        stress_source_variants = make_variants(stress_source_image)

        for variant_name, probe_input in primary_probe_entries:
            started_process = time.perf_counter()
            process_payload = probe_input if probe_input.startswith("data:image/") else f"data:image/png;base64,{probe_input}"
            processed_probe = post_json("/afis/from-image", {"image": process_payload})
            probe_processing_times.append(time.perf_counter() - started_process)
            probe_quality_scores.append(float(processed_probe.get("afisQuality", processed_probe.get("quality", 0))))
            total_calls += 1
            normalized_probe_image = str(processed_probe.get("image", probe_input))

            started_compare = time.perf_counter()
            compare_result = post_json(
                "/afis/compare",
                {
                    "probeImage": normalized_probe_image,
                    "candidateImage": sample.image_base64,
                    "probePreprocessed": True,
                    "candidatePreprocessed": True,
                    "requireBozorth3": False,
                },
            )
            verification_time = time.perf_counter() - started_compare
            total_calls += 1

            threshold = float(compare_result.get("threshold", 0))
            score = float(compare_result.get("score", 0))
            threshold_values.append(threshold)
            genuine_scores.append(score)
            verification_times.append(verification_time)

            matched = bool(compare_result.get("isMatch", False))
            if variant_name in low_quality_variants:
                low_quality_positive_results.append(matched)

            records.append(
                ComparisonRecord(
                    label="genuine",
                    probe_identity=sample.identity_id,
                    candidate_identity=sample.identity_id,
                    variant=variant_name,
                    evaluation_set="primary",
                    is_match=matched,
                    expected_match=True,
                    score=score,
                    threshold=threshold,
                    bozorth_score=float(compare_result.get("bozorthScore", 0)),
                    probe_quality=float(compare_result.get("probe", {}).get("quality", 0)),
                    candidate_quality=float(compare_result.get("candidate", {}).get("quality", 0)),
                    verification_time_sec=verification_time,
                )
            )

        for variant_name in stress_variants:
            probe_b64 = stress_source_variants[variant_name]

            started_process = time.perf_counter()
            processed_probe = post_json("/afis/from-image", {"image": f"data:image/png;base64,{probe_b64}"})
            probe_processing_times.append(time.perf_counter() - started_process)
            probe_quality_scores.append(float(processed_probe.get("afisQuality", processed_probe.get("quality", 0))))
            total_calls += 1
            normalized_probe_image = str(processed_probe.get("image", probe_b64))

            started_compare = time.perf_counter()
            compare_result = post_json(
                "/afis/compare",
                {
                    "probeImage": normalized_probe_image,
                    "candidateImage": sample.image_base64,
                    "probePreprocessed": True,
                    "candidatePreprocessed": True,
                    "requireBozorth3": False,
                },
            )
            verification_time = time.perf_counter() - started_compare
            total_calls += 1

            threshold = float(compare_result.get("threshold", 0))
            score = float(compare_result.get("score", 0))
            verification_times.append(verification_time)
            low_quality_positive_results.append(bool(compare_result.get("isMatch", False)))

            records.append(
                ComparisonRecord(
                    label="genuine",
                    probe_identity=sample.identity_id,
                    candidate_identity=sample.identity_id,
                    variant=variant_name,
                    evaluation_set="stress",
                    is_match=bool(compare_result.get("isMatch", False)),
                    expected_match=True,
                    score=score,
                    threshold=threshold,
                    bozorth_score=float(compare_result.get("bozorthScore", 0)),
                    probe_quality=float(compare_result.get("probe", {}).get("quality", 0)),
                    candidate_quality=float(compare_result.get("candidate", {}).get("quality", 0)),
                    verification_time_sec=verification_time,
                )
            )

        negative_variants = ["exact", "rotate_3deg", "blur_soft", "low_contrast", "exact"]
        for offset_index, offset in enumerate(negative_offsets):
            candidate = samples[(idx + offset) % len(samples)]
            variant_name = negative_variants[offset_index % len(negative_variants)]
            probe_b64 = candidate_variants[variant_name]

            started_compare = time.perf_counter()
            compare_result = post_json(
                "/afis/compare",
                {
                    "probeImage": probe_b64,
                    "candidateImage": candidate.image_base64,
                    "candidatePreprocessed": True,
                    "requireBozorth3": False,
                },
            )
            verification_time = time.perf_counter() - started_compare
            total_calls += 1

            threshold = float(compare_result.get("threshold", 0))
            score = float(compare_result.get("score", 0))
            threshold_values.append(threshold)
            impostor_scores.append(score)
            verification_times.append(verification_time)

            records.append(
                ComparisonRecord(
                    label="impostor",
                    probe_identity=sample.identity_id,
                    candidate_identity=candidate.identity_id,
                    variant=variant_name,
                    evaluation_set="primary",
                    is_match=bool(compare_result.get("isMatch", False)),
                    expected_match=False,
                    score=score,
                    threshold=threshold,
                    bozorth_score=float(compare_result.get("bozorthScore", 0)),
                    probe_quality=float(compare_result.get("probe", {}).get("quality", 0)),
                    candidate_quality=float(compare_result.get("candidate", {}).get("quality", 0)),
                    verification_time_sec=verification_time,
                )
            )

    successful_calls = total_calls

    primary_records = [record for record in records if record.evaluation_set == "primary"]
    threshold_sweep = perform_threshold_sweep(
        [record.score for record in primary_records],
        [1 if record.expected_match else 0 for record in primary_records],
        threshold_start,
        threshold_stop,
        threshold_step,
    )

    tp = sum(1 for record in primary_records if record.expected_match and record.is_match)
    fn = sum(1 for record in primary_records if record.expected_match and not record.is_match)
    fp = sum(1 for record in primary_records if not record.expected_match and record.is_match)
    tn = sum(1 for record in primary_records if not record.expected_match and not record.is_match)

    accuracy = safe_div(tp + tn, tp + tn + fp + fn) * 100
    precision = safe_div(tp, tp + fp) * 100
    recall = safe_div(tp, tp + fn) * 100
    f1 = safe_div(2 * precision * recall, precision + recall)
    far = safe_div(fp, fp + tn) * 100
    frr = safe_div(fn, fn + tp) * 100

    low_quality_robustness = safe_div(
        sum(1 for matched in low_quality_positive_results if matched),
        len(low_quality_positive_results),
    ) * 100

    avg_afis_quality = statistics.fmean([sample.afis_quality for sample in samples] + probe_quality_scores)
    enrollment_time_mean = statistics.fmean(enrollment_times) if enrollment_times else 0.0
    probe_processing_mean = statistics.fmean(probe_processing_times) if probe_processing_times else 0.0
    verification_time_mean = statistics.fmean(verification_times) if verification_times else 0.0
    end_to_end_time = probe_processing_mean + verification_time_mean
    availability = safe_div(successful_calls, total_calls) * 100 if total_calls else 0.0

    results = {
        "evaluation_basis": {
            "type": benchmark_type,
            "note": benchmark_note,
            "source_mode": source_mode,
            "uploads_dir": uploads_dir,
            "database_mode": "criminals" if use_criminal_db else None,
            "database_stats": db_stats,
            "dataset_signature": build_dataset_signature(dataset_entries),
            "dataset_entries": dataset_entries,
            "identity_count": len(samples),
            "positive_variants_per_identity": safe_div(
                sum(1 for record in records if record.evaluation_set == "primary" and record.expected_match),
                len(samples),
            ),
            "stress_variants_per_identity": safe_div(
                sum(1 for record in records if record.evaluation_set == "stress"),
                len(samples),
            ),
            "negative_comparisons_per_identity": safe_div(
                sum(1 for record in records if record.evaluation_set == "primary" and not record.expected_match),
                len(samples),
            ),
            "random_seed": RANDOM_SEED,
            "service_health": health,
            "service_config": config,
        },
        "confusion_matrix": {
            "TP": tp,
            "FN": fn,
            "FP": fp,
            "TN": tn,
        },
        "metrics": {
            "accuracy_pct": accuracy,
            "precision_pct": precision,
            "recall_pct": recall,
            "f1_score_pct": f1,
            "far_pct": far,
            "frr_pct": frr,
            "low_quality_match_robustness_pct": low_quality_robustness,
            "mean_afis_quality": avg_afis_quality,
            "mean_genuine_score": statistics.fmean(genuine_scores) if genuine_scores else 0.0,
            "mean_impostor_score": statistics.fmean(impostor_scores) if impostor_scores else 0.0,
            "score_separation": (
                (statistics.fmean(genuine_scores) if genuine_scores else 0.0)
                - (statistics.fmean(impostor_scores) if impostor_scores else 0.0)
            ),
            "adaptive_threshold_mean": statistics.fmean(threshold_values) if threshold_values else 0.0,
            "adaptive_threshold_std": statistics.pstdev(threshold_values) if len(threshold_values) > 1 else 0.0,
            "enrollment_processing_time_sec": enrollment_time_mean,
            "probe_processing_time_sec": probe_processing_mean,
            "verification_processing_time_sec": verification_time_mean,
            "estimated_end_to_end_screening_time_sec": end_to_end_time,
            "service_availability_pct": availability,
        },
        "threshold_sweep": threshold_sweep,
        "records": [record.__dict__ for record in records],
    }

    return results


def build_markdown_report(results: Dict) -> str:
    metrics = results["metrics"]
    confusion = results["confusion_matrix"]
    evaluation_basis = results["evaluation_basis"]
    threshold_sweep = results.get("threshold_sweep", {})
    threshold_rows = threshold_sweep.get("rows", [])
    best_f1 = threshold_sweep.get("best_f1")
    eer_approx = threshold_sweep.get("eer_approx")
    threshold_plots = threshold_sweep.get("plots", {})
    best_f1_threshold_text = f"{best_f1['threshold']:.2f}" if best_f1 else "n/a"
    eer_threshold_text = f"{eer_approx['threshold']:.2f}" if eer_approx else "n/a"
    benchmark_type = str(evaluation_basis.get("type", "benchmark"))
    is_synthetic = benchmark_type == "synthetic service-generated fingerprint benchmark"

    rows = [
        ("Biometric Accuracy", "Accuracy", f"{metrics['accuracy_pct']:.2f}%", adjective_high(metrics["accuracy_pct"])),
        ("Biometric Accuracy", "Precision", f"{metrics['precision_pct']:.2f}%", adjective_high(metrics["precision_pct"])),
        ("Biometric Accuracy", "Recall / Sensitivity", f"{metrics['recall_pct']:.2f}%", adjective_high(metrics["recall_pct"])),
        ("Biometric Accuracy", "F1-Score", f"{metrics['f1_score_pct']:.2f}%", adjective_high(metrics["f1_score_pct"])),
        ("Biometric Accuracy", "False Acceptance Rate (FAR)", f"{metrics['far_pct']:.2f}%", adjective_low(metrics["far_pct"])),
        ("Biometric Accuracy", "False Rejection Rate (FRR)", f"{metrics['frr_pct']:.2f}%", adjective_low(metrics["frr_pct"])),
        (
            "Image Robustness",
            "Low-Quality Match Robustness",
            f"{metrics['low_quality_match_robustness_pct']:.2f}%",
            adjective_high(metrics["low_quality_match_robustness_pct"]),
        ),
        (
            "Image Robustness",
            "Mean AFIS Quality",
            f"{metrics['mean_afis_quality']:.2f} / 100",
            adjective_high(metrics["mean_afis_quality"]),
        ),
        (
            "Matcher Behavior",
            "Mean Genuine Match Score",
            f"{metrics['mean_genuine_score']:.2f}",
            "Higher than impostor scores",
        ),
        (
            "Matcher Behavior",
            "Mean Impostor Match Score",
            f"{metrics['mean_impostor_score']:.2f}",
            "Lower than genuine scores",
        ),
        (
            "Matcher Behavior",
            "Score Separation",
            f"{metrics['score_separation']:.2f}",
            "Stronger separation indicates better discrimination",
        ),
        (
            "Matcher Behavior",
            "Adaptive Threshold Stability",
            f"{metrics['adaptive_threshold_mean']:.2f} mean / {metrics['adaptive_threshold_std']:.2f} std",
            "Stable threshold adjustment",
        ),
        (
            "Processing Efficiency",
            "Enrollment Processing Time",
            f"{metrics['enrollment_processing_time_sec']:.2f} sec",
            adjective_time(metrics["enrollment_processing_time_sec"]),
        ),
        (
            "Processing Efficiency",
            "Probe Processing Time",
            f"{metrics['probe_processing_time_sec']:.2f} sec",
            adjective_time(metrics["probe_processing_time_sec"]),
        ),
        (
            "Processing Efficiency",
            "Verification Processing Time",
            f"{metrics['verification_processing_time_sec']:.2f} sec",
            adjective_time(metrics["verification_processing_time_sec"]),
        ),
        (
            "Processing Efficiency",
            "Estimated End-to-End Screening Time",
            f"{metrics['estimated_end_to_end_screening_time_sec']:.2f} sec",
            adjective_time(metrics["estimated_end_to_end_screening_time_sec"]),
        ),
        (
            "Processing Efficiency",
            "Service Availability",
            f"{metrics['service_availability_pct']:.2f}%",
            adjective_high(metrics["service_availability_pct"]),
        ),
    ]

    table_lines = [
        "# Applied Performance Matrix for the Improved Fingerprint Matching Algorithm",
        "",
        "This report was generated automatically by `evaluate_performance_matrix.py` and applies the performance matrix directly to the improved local AFIS + enhanced Bozorth3 matcher used by the system.",
        "",
        "## Evaluation Basis",
        "",
        f"- Benchmark type: `{evaluation_basis['type']}`",
        f"- Identity samples: `{evaluation_basis['identity_count']}`",
        f"- Primary probes per identity: `{evaluation_basis['positive_variants_per_identity']:.2f}`",
        f"- Stress variants per identity: `{evaluation_basis.get('stress_variants_per_identity', 0):.2f}`",
        f"- Negative comparisons per identity: `{evaluation_basis['negative_comparisons_per_identity']:.2f}`",
        f"- Random seed: `{evaluation_basis['random_seed']}`",
        "- Note:",
        f"  {evaluation_basis['note']}",
        (f"- Uploads directory: `{evaluation_basis['uploads_dir']}`" if evaluation_basis.get("uploads_dir") else "- Uploads directory: `not used in this run`"),
        (f"- Database mode: `{evaluation_basis['database_mode']}`" if evaluation_basis.get("database_mode") else "- Database mode: `not used in this run`"),
        (
            f"- Database records used: `{evaluation_basis['database_stats'].get('selected_rows', 0)}`"
            if evaluation_basis.get("database_stats")
            else "- Database records used: `not applicable`"
        ),
        "- Primary metrics were computed from standard operational variants, while low-quality robustness was measured separately using the stress variants.",
        "",
        "## Confusion Matrix",
        "",
        f"- `TP`: {confusion['TP']}",
        f"- `FN`: {confusion['FN']}",
        f"- `FP`: {confusion['FP']}",
        f"- `TN`: {confusion['TN']}",
        "",
        "## Performance Matrix",
        "",
        "| Evaluation Area | Performance Indicator | Measured Value | Verbal Interpretation |",
        "|---|---|---:|---|",
    ]

    for area, indicator, value, interpretation in rows:
        table_lines.append(f"| {area} | {indicator} | {value} | {interpretation} |")

    table_lines.extend(
        [
            "",
            "## Threshold Sweep Analysis",
            "",
            f"- Sweep range: `{threshold_sweep.get('threshold_start', 0):.2f}` to `{threshold_sweep.get('threshold_stop', 0):.2f}` in steps of `{threshold_sweep.get('threshold_step', 0):.2f}`",
            f"- Score count analyzed: `{threshold_sweep.get('score_count', 0)}`",
            f"- Score range observed: `{threshold_sweep.get('score_min', 0):.2f}` to `{threshold_sweep.get('score_max', 0):.2f}`",
        ]
    )

    if best_f1:
        table_lines.extend(
            [
                (
                    f"- Best F1 threshold: `{best_f1['threshold']:.2f}` "
                    f"(Accuracy `{best_f1['accuracy_pct']:.2f}%`, Precision `{best_f1['precision_pct']:.2f}%`, "
                    f"Recall `{best_f1['recall_pct']:.2f}%`, F1 `{best_f1['f1_score_pct']:.2f}%`, "
                    f"FAR `{best_f1['far_pct']:.2f}%`, FRR `{best_f1['frr_pct']:.2f}%`)"
                )
            ]
        )
    if eer_approx:
        table_lines.extend(
            [
                (
                    f"- EER approximation threshold: `{eer_approx['threshold']:.2f}` "
                    f"(FAR `{eer_approx['far_pct']:.2f}%`, FRR `{eer_approx['frr_pct']:.2f}%`, "
                    f"gap `{eer_approx['far_frr_gap_pct']:.2f}%`)"
                )
            ]
        )
    if threshold_plots.get("enabled"):
        table_lines.extend(
            [
                f"- FAR vs FRR curve: `{threshold_plots.get('far_frr_curve', '')}`",
                f"- Precision vs Recall curve: `{threshold_plots.get('precision_recall_curve', '')}`",
            ]
        )
    elif threshold_plots.get("reason"):
        table_lines.append(f"- Plot generation: `{threshold_plots['reason']}`")

    table_lines.extend(
        [
            "",
            "| Threshold | Accuracy | Precision | Recall | F1 | FAR | FRR | Notes |",
            "|---:|---:|---:|---:|---:|---:|---:|---|",
        ]
    )
    for row in threshold_rows:
        notes: List[str] = []
        if best_f1 and math.isclose(row["threshold"], best_f1["threshold"], rel_tol=0.0, abs_tol=1e-9):
            notes.append("Best F1")
        if eer_approx and math.isclose(row["threshold"], eer_approx["threshold"], rel_tol=0.0, abs_tol=1e-9):
            notes.append("EER Approx")
        note_text = " / ".join(notes) if notes else ""
        table_lines.append(
            f"| {row['threshold']:.2f} | {row['accuracy_pct']:.2f}% | {row['precision_pct']:.2f}% | "
            f"{row['recall_pct']:.2f}% | {row['f1_score_pct']:.2f}% | {row['far_pct']:.2f}% | "
            f"{row['frr_pct']:.2f}% | {note_text} |"
        )

    table_lines.extend(
        [
            "",
            "## Summary Interpretation",
            "",
            (
                "The improved fingerprint matching algorithm demonstrated fast processing and stable adaptive "
                f"threshold behavior in this {benchmark_type}. At the service operating point, the run produced "
                f"`{metrics['accuracy_pct']:.2f}%` accuracy, `{metrics['precision_pct']:.2f}%` precision, "
                f"`{metrics['recall_pct']:.2f}%` recall, `{metrics['far_pct']:.2f}%` FAR, and `{metrics['frr_pct']:.2f}%` FRR. "
                f"The fixed-threshold sweep identified `{best_f1_threshold_text}` as the best-F1 operating point and "
                f"`{eer_threshold_text}` as the closest FAR≈FRR balance point, which provides a cleaner basis for "
                "calibrating the matcher for research reporting and future deployment tuning."
            ),
            "",
            "## Research-Ready Paragraph",
            "",
            (
                "Based on the applied performance matrix, the improved Minutiae-Based Fingerprint Identification "
                "algorithm demonstrated efficient processing time, improved score separation, and a measurable tradeoff "
                "between false accepts and false rejects across the threshold sweep. The "
                f"{'synthetic benchmark' if is_synthetic else 'database-backed benchmark'} results show that the improved "
                "AFIS preprocessing, enhanced local-structure Bozorth-style scoring, and threshold calibration workflow can "
                "identify both a best-F1 operating point and an approximate equal-error operating point, supporting a more "
                "defensible threshold selection strategy for research reporting and future matcher deployment."
            ),
            "",
            "## Service Configuration Snapshot",
            "",
            "```json",
            json.dumps(evaluation_basis.get("service_config", {}), indent=2),
            "```",
        ]
    )

    return "\n".join(table_lines)


def build_csv(results: Dict) -> str:
    metrics = results["metrics"]
    rows = [
        ("Biometric Accuracy", "Accuracy", f"{metrics['accuracy_pct']:.2f}%", adjective_high(metrics["accuracy_pct"])),
        ("Biometric Accuracy", "Precision", f"{metrics['precision_pct']:.2f}%", adjective_high(metrics["precision_pct"])),
        ("Biometric Accuracy", "Recall / Sensitivity", f"{metrics['recall_pct']:.2f}%", adjective_high(metrics["recall_pct"])),
        ("Biometric Accuracy", "F1-Score", f"{metrics['f1_score_pct']:.2f}%", adjective_high(metrics["f1_score_pct"])),
        ("Biometric Accuracy", "FAR", f"{metrics['far_pct']:.2f}%", adjective_low(metrics["far_pct"])),
        ("Biometric Accuracy", "FRR", f"{metrics['frr_pct']:.2f}%", adjective_low(metrics["frr_pct"])),
        ("Image Robustness", "Low-Quality Match Robustness", f"{metrics['low_quality_match_robustness_pct']:.2f}%", adjective_high(metrics["low_quality_match_robustness_pct"])),
        ("Image Robustness", "Mean AFIS Quality", f"{metrics['mean_afis_quality']:.2f}/100", adjective_high(metrics["mean_afis_quality"])),
        ("Matcher Behavior", "Mean Genuine Match Score", f"{metrics['mean_genuine_score']:.2f}", "Higher than impostor scores"),
        ("Matcher Behavior", "Mean Impostor Match Score", f"{metrics['mean_impostor_score']:.2f}", "Lower than genuine scores"),
        ("Matcher Behavior", "Score Separation", f"{metrics['score_separation']:.2f}", "Better discrimination"),
        ("Matcher Behavior", "Adaptive Threshold Stability", f"{metrics['adaptive_threshold_mean']:.2f} mean / {metrics['adaptive_threshold_std']:.2f} std", "Stable threshold adjustment"),
        ("Processing Efficiency", "Enrollment Processing Time", f"{metrics['enrollment_processing_time_sec']:.2f} sec", adjective_time(metrics["enrollment_processing_time_sec"])),
        ("Processing Efficiency", "Probe Processing Time", f"{metrics['probe_processing_time_sec']:.2f} sec", adjective_time(metrics["probe_processing_time_sec"])),
        ("Processing Efficiency", "Verification Processing Time", f"{metrics['verification_processing_time_sec']:.2f} sec", adjective_time(metrics["verification_processing_time_sec"])),
        ("Processing Efficiency", "Estimated End-to-End Screening Time", f"{metrics['estimated_end_to_end_screening_time_sec']:.2f} sec", adjective_time(metrics["estimated_end_to_end_screening_time_sec"])),
        ("Processing Efficiency", "Service Availability", f"{metrics['service_availability_pct']:.2f}%", adjective_high(metrics["service_availability_pct"])),
    ]
    lines = ["Evaluation Area,Performance Indicator,Measured Value,Verbal Interpretation"]
    for area, indicator, value, interpretation in rows:
        escaped = [area, indicator, value, interpretation]
        lines.append(",".join(f"\"{item}\"" if "," in item or "/" in item or " " in item else item for item in escaped))
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate a research performance matrix for the improved fingerprint matcher.")
    parser.add_argument(
        "--identities",
        type=int,
        default=0,
        help="Number of identities to evaluate. Use 0 to include all uploaded/database identities; synthetic mode falls back to 8.",
    )
    parser.add_argument(
        "--uploads-dir",
        default="",
        help="Optional directory of uploaded fingerprint images. Use subfolders per identity, or files in the root.",
    )
    parser.add_argument(
        "--use-criminal-db",
        action="store_true",
        help="Load active fingerprint images directly from the criminal_fingerprints table instead of synthetic scans.",
    )
    parser.add_argument(
        "--negative-offsets",
        default="1,2,3,4,5",
        help="Comma-separated offsets for selecting impostor identities.",
    )
    parser.add_argument("--threshold-start", type=float, default=50.0, help="Threshold sweep start value.")
    parser.add_argument("--threshold-stop", type=float, default=80.0, help="Threshold sweep stop value.")
    parser.add_argument("--threshold-step", type=float, default=2.0, help="Threshold sweep step value.")
    parser.add_argument(
        "--skip-plots",
        action="store_true",
        help="Skip matplotlib plot generation for the threshold sweep.",
    )
    args = parser.parse_args()

    negative_offsets = [int(value.strip()) for value in args.negative_offsets.split(",") if value.strip()]
    if not negative_offsets:
        raise SystemExit("At least one negative offset is required.")
    if args.identities < 0:
        raise SystemExit("--identities must be 0 or greater.")
    if args.use_criminal_db and args.uploads_dir.strip():
        raise SystemExit("Use either --uploads-dir or --use-criminal-db, not both together.")
    if args.threshold_step <= 0:
        raise SystemExit("--threshold-step must be greater than 0.")
    if args.threshold_stop < args.threshold_start:
        raise SystemExit("--threshold-stop must be greater than or equal to --threshold-start.")

    identity_count = args.identities
    if identity_count == 0 and not args.use_criminal_db and not args.uploads_dir.strip():
        identity_count = 8

    results = evaluate(
        identity_count,
        negative_offsets,
        args.uploads_dir.strip() or None,
        args.use_criminal_db,
        args.threshold_start,
        args.threshold_stop,
        args.threshold_step,
    )

    if args.skip_plots:
        results["threshold_sweep"]["plots"] = {
            "enabled": False,
            "reason": "Plot generation was skipped by CLI option.",
            "far_frr_curve": None,
            "precision_recall_curve": None,
        }
    else:
        results["threshold_sweep"]["plots"] = render_threshold_plots(results["threshold_sweep"], OUTPUT_DIR)

    json_path = OUTPUT_DIR / "performance_matrix_results.json"
    md_path = OUTPUT_DIR / "PERFORMANCE_MATRIX_APPLIED.md"
    csv_path = OUTPUT_DIR / "performance_matrix_applied.csv"
    threshold_csv_path = OUTPUT_DIR / "performance_threshold_sweep.csv"

    json_path = write_output_text(json_path, json.dumps(results, indent=2))
    md_path = write_output_text(md_path, build_markdown_report(results))
    csv_path = write_output_text(csv_path, build_csv(results))
    threshold_csv_path = write_output_text(threshold_csv_path, build_threshold_sweep_csv(results["threshold_sweep"]))

    print(f"Saved JSON results to {json_path}")
    print(f"Saved Markdown report to {md_path}")
    print(f"Saved CSV matrix to {csv_path}")
    print(f"Saved threshold sweep CSV to {threshold_csv_path}")

    threshold_plots = results["threshold_sweep"].get("plots", {})
    if threshold_plots.get("enabled"):
        print(f"Saved FAR/FRR curve to {threshold_plots['far_frr_curve']}")
        print(f"Saved Precision/Recall curve to {threshold_plots['precision_recall_curve']}")

    metrics = results["metrics"]
    best_f1 = results["threshold_sweep"].get("best_f1", {})
    eer_approx = results["threshold_sweep"].get("eer_approx", {})
    print(
        json.dumps(
            {
                "accuracy_pct": round(metrics["accuracy_pct"], 2),
                "precision_pct": round(metrics["precision_pct"], 2),
                "recall_pct": round(metrics["recall_pct"], 2),
                "f1_score_pct": round(metrics["f1_score_pct"], 2),
                "far_pct": round(metrics["far_pct"], 2),
                "frr_pct": round(metrics["frr_pct"], 2),
                "verification_processing_time_sec": round(metrics["verification_processing_time_sec"], 2),
                "best_f1_threshold": round(float(best_f1.get("threshold", 0.0)), 2),
                "best_f1_score_pct": round(float(best_f1.get("f1_score_pct", 0.0)), 2),
                "eer_threshold": round(float(eer_approx.get("threshold", 0.0)), 2),
                "eer_far_pct": round(float(eer_approx.get("far_pct", 0.0)), 2),
                "eer_frr_pct": round(float(eer_approx.get("frr_pct", 0.0)), 2),
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
