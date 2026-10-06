import argparse
import dataclasses
import itertools
import json
import random
import statistics
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Sequence, Set, Tuple

from evaluate_performance_matrix import (
    RANDOM_SEED,
    collect_database_identity_samples,
    collect_identity_samples,
    collect_uploaded_identity_samples,
    ensure_service_running,
    fetch_service_config,
    make_variants,
    post_json,
    safe_div,
    write_output_text,
)


OUTPUT_DIR = Path("temp") / "bozorth3_tuning"
POSITIVE_VARIANTS = ["exact", "rotate_3deg", "blur_soft", "low_contrast"]
STRESS_VARIANTS = ["partial_crop", "noisy"]
NEGATIVE_VARIANTS = ["exact", "rotate_3deg", "blur_soft", "low_contrast", "exact"]


@dataclass(frozen=True)
class PairObservation:
    probe_identity: str
    candidate_identity: str
    expected_match: bool
    variant: str
    evaluation_set: str
    normalized_bozorth_score: float
    consistency_score: float
    effective_consistency_score: float
    consistency_forward: float
    consistency_reverse: float
    aligned_consistency_score: float
    aligned_consistency_forward: float
    aligned_consistency_reverse: float
    orientation_score: float
    graph_score: float
    local_structure_score: float
    quality_score: float
    overlap_ratio: float
    probe_quality: float
    candidate_quality: float
    probe_count: int
    candidate_count: int
    api_score: float
    api_threshold: float
    api_is_match: bool


@dataclass(frozen=True)
class MatcherParams:
    base_threshold: int = 60
    min_threshold: int = 60
    max_threshold: int = 84
    low_quality_penalty: float = 10.0
    low_overlap_penalty: float = 8.0
    low_minutiae_penalty: float = 6.0
    high_quality_bonus: float = 4.0
    min_required_for_match: int = 18
    high_quality_relax: int = 6
    medium_quality_relax: int = 4
    low_quality_add: int = 4
    consistency_min_score: int = 12
    min_directional_score: int = 6
    structural_orientation_min: int = 26
    structural_graph_min: int = 18
    partial_overlap_min: float = 0.26
    partial_quality_min: int = 68
    local_structure_rescue_min: int = 54
    partial_local_structure_min: int = 50
    bozorth_floor: int = 44
    bozorth_threshold_allowance: int = 20
    fusion_bozorth: float = 0.42
    fusion_consistency: float = 0.18
    fusion_orientation: float = 0.10
    fusion_graph: float = 0.08
    fusion_local_structure: float = 0.12
    fusion_quality: float = 0.10


def clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def dataclass_to_dict(instance) -> Dict:
    return dataclasses.asdict(instance)


def load_samples(identity_count: int, uploads_dir: Optional[str], use_criminal_db: bool):
    if uploads_dir:
        samples, enrollment_times, total_calls = collect_uploaded_identity_samples(Path(uploads_dir), identity_count)
        source_mode = "uploaded_images"
        source_details = {"uploads_dir": uploads_dir}
    elif use_criminal_db:
        samples, enrollment_times, total_calls, db_stats = collect_database_identity_samples(identity_count)
        source_mode = "criminal_database"
        source_details = {"database_stats": db_stats}
    else:
        samples, enrollment_times, total_calls = collect_identity_samples(identity_count)
        source_mode = "synthetic_scan"
        source_details = {}

    return samples, enrollment_times, total_calls, source_mode, source_details


def build_observation(
    probe_identity: str,
    candidate_identity: str,
    expected_match: bool,
    variant: str,
    evaluation_set: str,
    compare_result: Dict,
) -> PairObservation:
    consistency = compare_result.get("consistency", {})
    aligned = compare_result.get("alignedConsistency", {})
    orientation = compare_result.get("orientationFrequency", {})
    local_structure = compare_result.get("localStructure", {})
    quality = compare_result.get("qualityFusion", {})
    probe = compare_result.get("probe", {})
    candidate = compare_result.get("candidate", {})

    return PairObservation(
        probe_identity=probe_identity,
        candidate_identity=candidate_identity,
        expected_match=expected_match,
        variant=variant,
        evaluation_set=evaluation_set,
        normalized_bozorth_score=float(compare_result.get("normalizedBozorthScore", 0.0)),
        consistency_score=float(consistency.get("score", 0.0)),
        effective_consistency_score=float(consistency.get("effectiveScore", consistency.get("score", 0.0))),
        consistency_forward=float(consistency.get("forward", 0.0)),
        consistency_reverse=float(consistency.get("reverse", 0.0)),
        aligned_consistency_score=float(aligned.get("score", 0.0)),
        aligned_consistency_forward=float(aligned.get("forward", 0.0)),
        aligned_consistency_reverse=float(aligned.get("reverse", 0.0)),
        orientation_score=float(orientation.get("score", 0.0)),
        graph_score=float(compare_result.get("spatialModel", {}).get("score", 0.0)),
        local_structure_score=float(local_structure.get("score", 0.0)),
        quality_score=float(quality.get("score", 0.0)),
        overlap_ratio=float(orientation.get("overlapRatio", 0.0)),
        probe_quality=float(probe.get("quality", 0.0)),
        candidate_quality=float(candidate.get("quality", 0.0)),
        probe_count=int(compare_result.get("minutiaeRequirement", {}).get("probeCount", 0)),
        candidate_count=int(compare_result.get("minutiaeRequirement", {}).get("candidateCount", 0)),
        api_score=float(compare_result.get("score", 0.0)),
        api_threshold=float(compare_result.get("threshold", 0.0)),
        api_is_match=bool(compare_result.get("isMatch", False)),
    )


def collect_pair_observations(
    samples,
    negative_offsets: Sequence[int],
    include_stress: bool,
    base_threshold: int,
) -> Tuple[List[PairObservation], int]:
    observations: List[PairObservation] = []
    total_calls = 0

    for index, sample in enumerate(samples):
        candidate_variants = make_variants(sample.image_base64)
        primary_probe_entries = (
            list(sample.genuine_probe_images)
            if sample.genuine_probe_images
            else [(variant_name, candidate_variants[variant_name]) for variant_name in POSITIVE_VARIANTS]
        )

        for variant_name, probe_input in primary_probe_entries:
            process_payload = probe_input if probe_input.startswith("data:image/") else f"data:image/png;base64,{probe_input}"
            processed_probe = post_json("/afis/from-image", {"image": process_payload})
            total_calls += 1
            normalized_probe_image = str(processed_probe.get("image", probe_input))

            compare_result = post_json(
                "/afis/compare",
                {
                    "probeImage": normalized_probe_image,
                    "candidateImage": sample.image_base64,
                    "probePreprocessed": True,
                    "candidatePreprocessed": True,
                    "threshold": base_threshold,
                    "requireBozorth3": False,
                },
            )
            total_calls += 1

            observations.append(
                build_observation(
                    probe_identity=sample.identity_id,
                    candidate_identity=sample.identity_id,
                    expected_match=True,
                    variant=variant_name,
                    evaluation_set="primary",
                    compare_result=compare_result,
                )
            )

        if include_stress:
            stress_source_image = sample.genuine_probe_images[0][1] if sample.genuine_probe_images else sample.image_base64
            stress_variants = make_variants(stress_source_image)
            for variant_name in STRESS_VARIANTS:
                probe_b64 = stress_variants[variant_name]
                processed_probe = post_json("/afis/from-image", {"image": f"data:image/png;base64,{probe_b64}"})
                total_calls += 1
                normalized_probe_image = str(processed_probe.get("image", probe_b64))

                compare_result = post_json(
                    "/afis/compare",
                    {
                        "probeImage": normalized_probe_image,
                        "candidateImage": sample.image_base64,
                        "probePreprocessed": True,
                        "candidatePreprocessed": True,
                        "threshold": base_threshold,
                        "requireBozorth3": False,
                    },
                )
                total_calls += 1

                observations.append(
                    build_observation(
                        probe_identity=sample.identity_id,
                        candidate_identity=sample.identity_id,
                        expected_match=True,
                        variant=variant_name,
                        evaluation_set="stress",
                        compare_result=compare_result,
                    )
                )

        for offset_index, offset in enumerate(negative_offsets):
            candidate = samples[(index + offset) % len(samples)]
            variant_name = NEGATIVE_VARIANTS[offset_index % len(NEGATIVE_VARIANTS)]
            probe_b64 = candidate_variants[variant_name]

            compare_result = post_json(
                "/afis/compare",
                {
                    "probeImage": probe_b64,
                    "candidateImage": candidate.image_base64,
                    "candidatePreprocessed": True,
                    "threshold": base_threshold,
                    "requireBozorth3": False,
                },
            )
            total_calls += 1

            observations.append(
                build_observation(
                    probe_identity=sample.identity_id,
                    candidate_identity=candidate.identity_id,
                    expected_match=False,
                    variant=variant_name,
                    evaluation_set="primary",
                    compare_result=compare_result,
                )
            )

    return observations, total_calls


def compute_adaptive_minutiae_requirement(observation: PairObservation, params: MatcherParams) -> int:
    quality_mean = (observation.probe_quality + observation.candidate_quality) / 2.0
    requirement = params.min_required_for_match
    if quality_mean >= 82 and observation.overlap_ratio <= 0.55:
        requirement -= params.high_quality_relax
    elif quality_mean >= 72 and observation.overlap_ratio <= 0.68:
        requirement -= params.medium_quality_relax
    if quality_mean < 60:
        requirement += params.low_quality_add
    return int(round(clamp(requirement, 14, 30)))


def compute_adaptive_threshold(
    observation: PairObservation,
    params: MatcherParams,
    minutiae_count_score: float,
) -> float:
    quality_mean = (observation.probe_quality + observation.candidate_quality) / 2.0
    threshold = float(params.base_threshold)

    if quality_mean < 72:
        threshold += params.low_quality_penalty * ((72 - quality_mean) / 32.0)
    elif quality_mean > 88:
        threshold -= params.high_quality_bonus * ((quality_mean - 88) / 12.0)

    if observation.overlap_ratio < 0.60:
        threshold += params.low_overlap_penalty * ((0.60 - observation.overlap_ratio) / 0.60)

    if minutiae_count_score < 1.0:
        threshold += params.low_minutiae_penalty * (1.0 - minutiae_count_score)

    return float(round(clamp(threshold, params.min_threshold, params.max_threshold)))


def classify_observation(observation: PairObservation, params: MatcherParams) -> Tuple[bool, float, float]:
    requirement = compute_adaptive_minutiae_requirement(observation, params)
    minutiae_count_score = min(observation.probe_count, observation.candidate_count) / max(1, requirement)
    adaptive_threshold = compute_adaptive_threshold(observation, params, min(1.0, minutiae_count_score))
    effective_consistency_score = max(
        observation.effective_consistency_score,
        observation.consistency_score,
        observation.aligned_consistency_score,
    )
    fused_score = round(
        (observation.normalized_bozorth_score * params.fusion_bozorth)
        + (effective_consistency_score * params.fusion_consistency)
        + (observation.orientation_score * params.fusion_orientation)
        + (observation.graph_score * params.fusion_graph)
        + (observation.local_structure_score * params.fusion_local_structure)
        + (observation.quality_score * params.fusion_quality)
    )

    raw_consistency_pass = (
        observation.consistency_score >= params.consistency_min_score
        and observation.consistency_forward >= params.min_directional_score
        and observation.consistency_reverse >= params.min_directional_score
    )
    aligned_consistency_pass = (
        observation.aligned_consistency_score >= params.consistency_min_score
        and observation.aligned_consistency_forward >= params.min_directional_score
        and observation.aligned_consistency_reverse >= params.min_directional_score
    )
    passes_consistency = raw_consistency_pass or aligned_consistency_pass
    structural_pass = (
        observation.orientation_score >= params.structural_orientation_min
        and observation.graph_score >= params.structural_graph_min
    )
    structure_rescue_pass = observation.local_structure_score >= params.local_structure_rescue_min
    partial_tolerance_pass = (
        observation.overlap_ratio >= params.partial_overlap_min
        or observation.quality_score >= params.partial_quality_min
        or observation.local_structure_score >= params.partial_local_structure_min
    )
    has_sufficient_minutiae = (
        observation.probe_count >= requirement
        and observation.candidate_count >= requirement
    )
    bozorth_floor = max(params.bozorth_floor, adaptive_threshold - params.bozorth_threshold_allowance)
    is_match = (
        fused_score >= adaptive_threshold
        and observation.normalized_bozorth_score >= bozorth_floor
        and passes_consistency
        and (structural_pass or structure_rescue_pass)
        and partial_tolerance_pass
        and has_sufficient_minutiae
    )
    return is_match, float(fused_score), float(adaptive_threshold)


def compute_metrics(observations: Sequence[PairObservation], params: MatcherParams) -> Dict[str, float]:
    if not observations:
        return {
            "accuracy_pct": 0.0,
            "precision_pct": 0.0,
            "recall_pct": 0.0,
            "f1_score_pct": 0.0,
            "far_pct": 0.0,
            "frr_pct": 0.0,
            "tp": 0,
            "tn": 0,
            "fp": 0,
            "fn": 0,
            "mean_fused_score": 0.0,
            "mean_adaptive_threshold": 0.0,
            "tpr": 0.0,
            "fpr": 0.0,
        }

    tp = tn = fp = fn = 0
    fused_scores: List[float] = []
    adaptive_thresholds: List[float] = []

    for observation in observations:
        is_match, fused_score, adaptive_threshold = classify_observation(observation, params)
        fused_scores.append(fused_score)
        adaptive_thresholds.append(adaptive_threshold)
        if observation.expected_match and is_match:
            tp += 1
        elif observation.expected_match and not is_match:
            fn += 1
        elif not observation.expected_match and is_match:
            fp += 1
        else:
            tn += 1

    accuracy = safe_div(tp + tn, tp + tn + fp + fn) * 100.0
    precision = safe_div(tp, tp + fp) * 100.0
    recall = safe_div(tp, tp + fn) * 100.0
    f1 = safe_div(2.0 * precision * recall, precision + recall)
    far = safe_div(fp, fp + tn) * 100.0
    frr = safe_div(fn, fn + tp) * 100.0

    return {
        "accuracy_pct": accuracy,
        "precision_pct": precision,
        "recall_pct": recall,
        "f1_score_pct": f1,
        "far_pct": far,
        "frr_pct": frr,
        "tp": tp,
        "tn": tn,
        "fp": fp,
        "fn": fn,
        "mean_fused_score": statistics.fmean(fused_scores) if fused_scores else 0.0,
        "mean_adaptive_threshold": statistics.fmean(adaptive_thresholds) if adaptive_thresholds else 0.0,
        "tpr": recall / 100.0,
        "fpr": far / 100.0,
    }


def objective_key(metrics: Dict[str, float], far_target: float) -> Tuple:
    if metrics["far_pct"] <= far_target:
        return (
            1,
            metrics["recall_pct"],
            metrics["f1_score_pct"],
            metrics["precision_pct"],
            -metrics["frr_pct"],
            -metrics["far_pct"],
        )

    return (
        0,
        -(metrics["far_pct"] - far_target),
        metrics["recall_pct"],
        metrics["f1_score_pct"],
        metrics["precision_pct"],
        -metrics["frr_pct"],
        -metrics["far_pct"],
    )


def generate_threshold_sweep(
    observations: Sequence[PairObservation],
    default_params: MatcherParams,
    threshold_values: Iterable[int],
    far_target: float,
) -> List[Dict]:
    rows: List[Dict] = []
    for threshold in threshold_values:
        params = dataclasses.replace(default_params, base_threshold=threshold)
        metrics = compute_metrics(observations, params)
        rows.append(
            {
                "base_threshold": threshold,
                "accuracy_pct": round(metrics["accuracy_pct"], 4),
                "precision_pct": round(metrics["precision_pct"], 4),
                "recall_pct": round(metrics["recall_pct"], 4),
                "f1_score_pct": round(metrics["f1_score_pct"], 4),
                "far_pct": round(metrics["far_pct"], 4),
                "frr_pct": round(metrics["frr_pct"], 4),
                "tpr": round(metrics["tpr"], 6),
                "fpr": round(metrics["fpr"], 6),
                "meets_far_target": metrics["far_pct"] <= far_target,
            }
        )
    return rows


def search_best_params(
    observations: Sequence[PairObservation],
    threshold_values: Iterable[int],
    far_target: float,
) -> Tuple[MatcherParams, Dict[str, float], List[Dict]]:
    default_params = MatcherParams()
    threshold_sweep = generate_threshold_sweep(observations, default_params, threshold_values, far_target)
    best_threshold_row = max(
        threshold_sweep,
        key=lambda row: objective_key(
            {
                "accuracy_pct": row["accuracy_pct"],
                "precision_pct": row["precision_pct"],
                "recall_pct": row["recall_pct"],
                "f1_score_pct": row["f1_score_pct"],
                "far_pct": row["far_pct"],
                "frr_pct": row["frr_pct"],
            },
            far_target,
        ),
    )
    best_threshold = int(best_threshold_row["base_threshold"])

    threshold_grid = sorted({
        value
        for value in range(best_threshold - 4, best_threshold + 5, 2)
        if 56 <= value <= 92
    })

    best_params = dataclasses.replace(default_params, base_threshold=best_threshold)
    best_metrics = compute_metrics(observations, best_params)
    best_key = objective_key(best_metrics, far_target)

    directional_candidates = {6, 8, 10}
    for params in (
        dataclasses.replace(
            default_params,
            base_threshold=base_threshold,
            consistency_min_score=consistency_min_score,
            min_directional_score=min(directional_candidates, key=lambda value: abs(value - max(6, consistency_min_score // 2))),
            min_required_for_match=min_required,
            structural_orientation_min=orientation_min,
            structural_graph_min=graph_min,
            partial_overlap_min=overlap_min,
            partial_quality_min=quality_min,
            local_structure_rescue_min=default_params.local_structure_rescue_min,
            partial_local_structure_min=default_params.partial_local_structure_min,
            bozorth_floor=bozorth_floor,
            bozorth_threshold_allowance=allowance,
            min_threshold=min(min_threshold, max_threshold),
            max_threshold=max(min_threshold, max_threshold),
        )
        for base_threshold, consistency_min_score, min_required, orientation_min, graph_min, overlap_min, quality_min, bozorth_floor, allowance, min_threshold, max_threshold in itertools.product(
            threshold_grid,
            [12, 14, 16],
            [18, 20, 22, 24],
            [26, 28, 30],
            [18, 20, 22],
            [0.26, 0.28, 0.32],
            [68, 70, 74],
            [42, 44, 48],
            [20, 24],
            [60, 62, 64],
            [84, 88, 92],
        )
    ):
        metrics = compute_metrics(observations, params)
        candidate_key = objective_key(metrics, far_target)
        if candidate_key > best_key:
            best_params = params
            best_metrics = metrics
            best_key = candidate_key

    return best_params, best_metrics, threshold_sweep


def split_identity_folds(identity_ids: Sequence[str], fold_count: int) -> List[Set[str]]:
    ids = list(identity_ids)
    random.Random(RANDOM_SEED).shuffle(ids)
    fold_count = max(2, min(fold_count, len(ids)))
    folds: List[Set[str]] = []
    for fold_index in range(fold_count):
        folds.append(set(ids[fold_index::fold_count]))
    return [fold for fold in folds if fold]


def filter_observations_for_identities(observations: Sequence[PairObservation], identities: Set[str]) -> List[PairObservation]:
    return [
        observation
        for observation in observations
        if observation.probe_identity in identities and observation.candidate_identity in identities
    ]


def run_cross_validation(
    observations: Sequence[PairObservation],
    identity_ids: Sequence[str],
    fold_count: int,
    threshold_values: Iterable[int],
    far_target: float,
) -> Dict:
    folds = split_identity_folds(identity_ids, fold_count)
    fold_results: List[Dict] = []

    for fold_index, validation_ids in enumerate(folds, start=1):
        training_ids = set(identity_ids) - validation_ids
        training_observations = filter_observations_for_identities(observations, training_ids)
        validation_observations = filter_observations_for_identities(observations, validation_ids)
        if not training_observations or not validation_observations:
            continue

        best_params, training_metrics, _ = search_best_params(training_observations, threshold_values, far_target)
        validation_metrics = compute_metrics(validation_observations, best_params)

        fold_results.append(
            {
                "fold": fold_index,
                "training_identity_count": len(training_ids),
                "validation_identity_count": len(validation_ids),
                "training_pair_count": len(training_observations),
                "validation_pair_count": len(validation_observations),
                "best_params": dataclass_to_dict(best_params),
                "training_metrics": {key: round(value, 4) for key, value in training_metrics.items()},
                "validation_metrics": {key: round(value, 4) for key, value in validation_metrics.items()},
            }
        )

    if not fold_results:
        return {
            "fold_count": 0,
            "mean_validation_recall_pct": 0.0,
            "mean_validation_far_pct": 0.0,
            "mean_validation_frr_pct": 0.0,
            "folds": [],
        }

    return {
        "fold_count": len(fold_results),
        "mean_validation_recall_pct": round(statistics.fmean(item["validation_metrics"]["recall_pct"] for item in fold_results), 4),
        "mean_validation_far_pct": round(statistics.fmean(item["validation_metrics"]["far_pct"] for item in fold_results), 4),
        "mean_validation_frr_pct": round(statistics.fmean(item["validation_metrics"]["frr_pct"] for item in fold_results), 4),
        "folds": fold_results,
    }


def build_threshold_csv(rows: Sequence[Dict]) -> str:
    headers = [
        "base_threshold",
        "accuracy_pct",
        "precision_pct",
        "recall_pct",
        "f1_score_pct",
        "far_pct",
        "frr_pct",
        "tpr",
        "fpr",
        "meets_far_target",
    ]
    lines = [",".join(headers)]
    for row in rows:
        lines.append(",".join(str(row[column]) for column in headers))
    return "\n".join(lines)


def build_markdown_report(results: Dict) -> str:
    metrics = results["recommended_metrics"]
    recommendation = results["recommended_params"]
    cv = results["cross_validation"]
    basis = results["evaluation_basis"]

    return "\n".join(
        [
            "# Bozorth3 Optimization Report",
            "",
            "## Evaluation Basis",
            "",
            f"- Source mode: `{basis['source_mode']}`",
            f"- Identity samples: `{basis['identity_count']}`",
            f"- Pair observations: `{basis['pair_count']}`",
            f"- Stress pairs included: `{basis['include_stress_pairs']}`",
            f"- FAR target: `{basis['far_target_pct']:.2f}%`",
            f"- Threshold sweep: `{basis['threshold_values'][0]}` to `{basis['threshold_values'][-1]}`",
            "",
            "## Recommended Operating Point",
            "",
            f"- Base threshold: `{recommendation['base_threshold']}`",
            f"- Consistency min score: `{recommendation['consistency_min_score']}`",
            f"- Min required minutiae: `{recommendation['min_required_for_match']}`",
            f"- Structural orientation min: `{recommendation['structural_orientation_min']}`",
            f"- Structural graph min: `{recommendation['structural_graph_min']}`",
            f"- Partial overlap min: `{recommendation['partial_overlap_min']}`",
            f"- Partial quality min: `{recommendation['partial_quality_min']}`",
            f"- Local-structure rescue min: `{recommendation['local_structure_rescue_min']}`",
            f"- Partial local-structure min: `{recommendation['partial_local_structure_min']}`",
            f"- Bozorth floor: `{recommendation['bozorth_floor']}`",
            f"- Bozorth allowance below threshold: `{recommendation['bozorth_threshold_allowance']}`",
            "",
            "## Recommended Metrics",
            "",
            f"- Accuracy: `{metrics['accuracy_pct']:.2f}%`",
            f"- Precision: `{metrics['precision_pct']:.2f}%`",
            f"- Recall: `{metrics['recall_pct']:.2f}%`",
            f"- F1-score: `{metrics['f1_score_pct']:.2f}%`",
            f"- FAR: `{metrics['far_pct']:.2f}%`",
            f"- FRR: `{metrics['frr_pct']:.2f}%`",
            "",
            "## Cross-Validation",
            "",
            f"- Folds completed: `{cv['fold_count']}`",
            f"- Mean validation recall: `{cv['mean_validation_recall_pct']:.2f}%`",
            f"- Mean validation FAR: `{cv['mean_validation_far_pct']:.2f}%`",
            f"- Mean validation FRR: `{cv['mean_validation_frr_pct']:.2f}%`",
            "",
            "## Service Snapshot",
            "",
            "```json",
            json.dumps(basis.get("service_config", {}), indent=2),
            "```",
        ]
    )


def optimize(
    identities: int,
    negative_offsets: Sequence[int],
    uploads_dir: Optional[str],
    use_criminal_db: bool,
    include_stress: bool,
    far_target: float,
    fold_count: int,
    threshold_values: Sequence[int],
) -> Dict:
    random.seed(RANDOM_SEED)
    try:
        OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    except PermissionError:
        pass

    health = ensure_service_running()
    service_config = fetch_service_config()
    samples, enrollment_times, load_calls, source_mode, source_details = load_samples(identities, uploads_dir, use_criminal_db)
    observations, pair_calls = collect_pair_observations(samples, negative_offsets, include_stress, MatcherParams().base_threshold)

    best_params, best_metrics, threshold_sweep = search_best_params(observations, threshold_values, far_target)
    cross_validation = run_cross_validation(
        observations=observations,
        identity_ids=[sample.identity_id for sample in samples],
        fold_count=fold_count,
        threshold_values=threshold_values,
        far_target=far_target,
    )

    return {
        "evaluation_basis": {
            "source_mode": source_mode,
            "identity_count": len(samples),
            "pair_count": len(observations),
            "include_stress_pairs": include_stress,
            "far_target_pct": far_target,
            "threshold_values": list(threshold_values),
            "negative_offsets": list(negative_offsets),
            "service_health": health,
            "service_config": service_config,
            "enrollment_calls": load_calls,
            "pair_collection_calls": pair_calls,
            "mean_enrollment_processing_time_sec": statistics.fmean(enrollment_times) if enrollment_times else 0.0,
            **source_details,
        },
        "recommended_params": dataclass_to_dict(best_params),
        "recommended_metrics": {key: round(value, 4) for key, value in best_metrics.items()},
        "threshold_sweep": threshold_sweep,
        "cross_validation": cross_validation,
        "pair_observations": [dataclass_to_dict(observation) for observation in observations],
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Tune Bozorth3 operating parameters for higher recall and lower FRR.")
    parser.add_argument("--identities", type=int, default=8, help="Number of identities to load for tuning.")
    parser.add_argument("--uploads-dir", default="", help="Optional uploaded-image directory instead of DB or synthetic samples.")
    parser.add_argument("--use-criminal-db", action="store_true", help="Load active criminal fingerprints directly from the database.")
    parser.add_argument("--include-stress", action="store_true", help="Include stress variants like partial crop and noise as positive pairs.")
    parser.add_argument("--far-target", type=float, default=15.0, help="Desired maximum FAR percentage during parameter selection.")
    parser.add_argument("--folds", type=int, default=5, help="Cross-validation fold count.")
    parser.add_argument(
        "--negative-offsets",
        default="1,2,3,4,5",
        help="Comma-separated offsets for impostor identity pairing.",
    )
    parser.add_argument("--threshold-start", type=int, default=60, help="Start of base-threshold sweep.")
    parser.add_argument("--threshold-stop", type=int, default=90, help="End of base-threshold sweep.")
    parser.add_argument("--threshold-step", type=int, default=2, help="Step size for base-threshold sweep.")
    args = parser.parse_args()

    if args.use_criminal_db and args.uploads_dir.strip():
        raise SystemExit("Use either --uploads-dir or --use-criminal-db, not both together.")
    if args.threshold_step <= 0:
        raise SystemExit("--threshold-step must be greater than 0.")

    negative_offsets = [int(value.strip()) for value in args.negative_offsets.split(",") if value.strip()]
    if not negative_offsets:
        raise SystemExit("At least one negative offset is required.")

    threshold_values = list(range(args.threshold_start, args.threshold_stop + 1, args.threshold_step))
    if not threshold_values:
        raise SystemExit("Threshold sweep produced no values.")

    results = optimize(
        identities=args.identities,
        negative_offsets=negative_offsets,
        uploads_dir=args.uploads_dir.strip() or None,
        use_criminal_db=args.use_criminal_db,
        include_stress=args.include_stress,
        far_target=args.far_target,
        fold_count=args.folds,
        threshold_values=threshold_values,
    )

    json_path = write_output_text(OUTPUT_DIR / "bozorth3_optimization.json", json.dumps(results, indent=2))
    csv_path = write_output_text(OUTPUT_DIR / "bozorth3_threshold_sweep.csv", build_threshold_csv(results["threshold_sweep"]))
    md_path = write_output_text(OUTPUT_DIR / "BOZORTH3_OPTIMIZATION_REPORT.md", build_markdown_report(results))

    print(f"Saved optimization JSON to {json_path}")
    print(f"Saved threshold sweep CSV to {csv_path}")
    print(f"Saved optimization report to {md_path}")
    print(json.dumps({
        "recommended_params": results["recommended_params"],
        "recommended_metrics": results["recommended_metrics"],
        "cross_validation": {
            "fold_count": results["cross_validation"]["fold_count"],
            "mean_validation_recall_pct": results["cross_validation"]["mean_validation_recall_pct"],
            "mean_validation_far_pct": results["cross_validation"]["mean_validation_far_pct"],
            "mean_validation_frr_pct": results["cross_validation"]["mean_validation_frr_pct"],
        },
    }, indent=2))


if __name__ == "__main__":
    main()
