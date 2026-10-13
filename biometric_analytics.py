#!/usr/bin/env python3
"""Compute de-identified biometric error and posterior analytics from JSON stdin."""

from __future__ import annotations

import json
import math
import sys
from typing import Any, Dict, Optional


def as_count(value: Any) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        return 0
    return max(0, number)


def percent(numerator: float, denominator: float) -> float:
    if denominator <= 0:
        return 0.0
    return round((numerator / denominator) * 100.0, 4)


def wilson_interval(successes: int, total: int, z: float = 1.96) -> Optional[Dict[str, float]]:
    if total <= 0:
        return None
    proportion = successes / total
    denominator = 1.0 + (z * z / total)
    centre = (proportion + (z * z / (2.0 * total))) / denominator
    margin = (
        z
        * math.sqrt((proportion * (1.0 - proportion) / total) + (z * z / (4.0 * total * total)))
        / denominator
    )
    return {
        "lower": round(max(0.0, centre - margin) * 100.0, 4),
        "upper": round(min(1.0, centre + margin) * 100.0, 4),
    }


def normalized_evidence(raw: Any) -> Dict[str, int]:
    source = raw if isinstance(raw, dict) else {}
    keys = (
        "applicant_records",
        "applicants_with_fingerprints",
        "active_criminal_records",
        "active_criminal_fingerprints",
        "dataset_participants",
        "dataset_samples",
        "stored_comparisons",
        "reviewed_comparisons",
        "reviewed_confirmed_matches",
        "reviewed_cleared_matches",
    )
    return {key: as_count(source.get(key)) for key in keys}


def analyze(payload: Any) -> Dict[str, Any]:
    source = payload if isinstance(payload, dict) else {}
    profile = source.get("profile") if isinstance(source.get("profile"), dict) else {}
    evidence = normalized_evidence(source.get("evidence"))
    validation = profile.get("validation") if isinstance(profile.get("validation"), dict) else {}
    required = ("tp", "fn", "fp", "tn")

    if not all(key in validation for key in required):
        return {
            "status": "insufficient_validation_data",
            "message": "A held-out labeled validation confusion matrix is required before posterior probabilities can be reported.",
            "confusion_matrix": None,
            "posterior": None,
            "operational_posterior": None,
            "evidence": evidence,
        }

    tp = as_count(validation.get("tp"))
    fn = as_count(validation.get("fn"))
    fp = as_count(validation.get("fp"))
    tn = as_count(validation.get("tn"))
    sample_count = tp + fn + fp + tn
    if sample_count <= 0 or tp + fn <= 0 or fp + tn <= 0:
        return {
            "status": "insufficient_validation_data",
            "message": "The held-out validation matrix does not contain both genuine and impostor observations.",
            "confusion_matrix": None,
            "posterior": None,
            "operational_posterior": None,
            "evidence": evidence,
        }

    predicted_positive = tp + fp
    predicted_negative = tn + fn
    reviewed = evidence["reviewed_comparisons"]
    confirmed = min(evidence["reviewed_confirmed_matches"], reviewed)
    cleared = min(evidence["reviewed_cleared_matches"], max(0, reviewed - confirmed))
    operational_posterior = None
    warnings = []

    if reviewed > 0:
        operational_posterior = {
            "match_given_reviewed_alert": percent(confirmed + 1, reviewed + 2),
            "reviewed_alerts": reviewed,
            "confirmed_matches": confirmed,
            "cleared_alerts": cleared,
            "confidence_interval_95": wilson_interval(confirmed, reviewed),
            "method": "Beta(1,1) posterior mean over independently reviewed matcher alerts",
        }
        if reviewed < 30:
            warnings.append(
                "Local reviewed outcomes are below 30; use the operational posterior as an early estimate, not a production guarantee."
            )
    else:
        warnings.append(
            "No independently reviewed matcher alerts are available, so no local operational posterior was calculated."
        )

    return {
        "status": "ready",
        "matcher": profile.get("matcher") or "Modified Bozorth3",
        "dataset": profile.get("dataset") or "Unknown held-out dataset",
        "threshold": profile.get("threshold"),
        "generated_at": profile.get("generatedAt"),
        "method": "Laplace-smoothed posterior probabilities from an independent held-out confusion matrix",
        "confusion_matrix": {
            "true_positive": tp,
            "false_negative": fn,
            "false_positive": fp,
            "true_negative": tn,
        },
        "metrics": {
            "sample_count": sample_count,
            "accuracy": percent(tp + tn, sample_count),
            "sensitivity": percent(tp, tp + fn),
            "specificity": percent(tn, tn + fp),
            "false_accept_rate": percent(fp, fp + tn),
            "false_reject_rate": percent(fn, fn + tp),
        },
        "posterior": {
            "match_given_positive": percent(tp + 1, predicted_positive + 2),
            "nonmatch_given_negative": percent(tn + 1, predicted_negative + 2),
            "positive_confidence_interval_95": wilson_interval(tp, predicted_positive),
            "negative_confidence_interval_95": wilson_interval(tn, predicted_negative),
            "prior_note": "The held-out benchmark is balanced; deployment probabilities change with local match prevalence.",
        },
        "operational_posterior": operational_posterior,
        "evidence": evidence,
        "warnings": warnings,
    }


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        json.dump(analyze(payload), sys.stdout, separators=(",", ":"), allow_nan=False)
        return 0
    except Exception as error:  # pragma: no cover - defensive CLI contract
        json.dump({"status": "error", "message": str(error)}, sys.stdout, separators=(",", ":"))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())

