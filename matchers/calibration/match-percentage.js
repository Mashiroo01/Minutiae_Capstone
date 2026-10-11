'use strict';

const defaultCalibration = require('../../config/matcher-calibration.json');

const FORMULA = 'score < T: 50 × (score - L) / (T - L); score = T: 50; score > T: 50 + 50 × (score - T) / (U - T); clamp to 0-100';

function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
}

function roundPercentage(value) {
    return Math.round(value * 100) / 100;
}

function normalizeWithProfile(rawScore, profile) {
    const score = Number(rawScore);
    const threshold = Number(profile?.threshold);
    const lowerScore = Number(profile?.mapping?.lowerScore);
    const upperScore = Number(profile?.mapping?.upperScore);

    if (!Number.isFinite(score)
        || !Number.isFinite(threshold)
        || !Number.isFinite(lowerScore)
        || !Number.isFinite(upperScore)
        || !(lowerScore < threshold && threshold < upperScore)
        || profile?.scoreDirection !== 'higher-is-more-similar') {
        return null;
    }

    if (score === threshold) return 50;
    const percentage = score < threshold
        ? 50 * ((score - lowerScore) / (threshold - lowerScore))
        : 50 + (50 * ((score - threshold) / (upperScore - threshold)));
    return roundPercentage(clamp(percentage, 0, 100));
}

function baseNormalization(profile) {
    return {
        status: profile?.status || 'calibration_required',
        method: profile?.method || null,
        formula: profile?.method === 'piecewise-linear-threshold-anchored' ? FORMULA : null,
        profileId: profile?.profileId || null,
        dataset: profile?.dataset || null,
        matcherFeed: profile?.matcherFeed || null,
        calibrationThreshold: Number.isFinite(Number(profile?.threshold)) ? Number(profile.threshold) : null,
        mapping: profile?.mapping || null,
        distributions: profile?.distributions || null,
        validation: profile?.validation || null,
        report: profile?.report || null,
        warning: profile?.reason || null
    };
}

function attachMatchPercentage(matcherResult, calibration = defaultCalibration) {
    const result = matcherResult && typeof matcherResult === 'object' ? matcherResult : {};
    const profile = calibration?.profiles?.[result.algorithm];
    const normalization = baseNormalization(profile);
    const decorated = {
        ...result,
        rawScore: result.rawScore ?? result.score ?? null,
        normalizedMatchPercentage: null,
        decision: result.result ?? null,
        normalization
    };

    if (result.status !== 'ok' || !Number.isFinite(Number(decorated.rawScore))) {
        normalization.status = 'unavailable';
        normalization.warning = result.error || 'The matcher did not return a finite native score.';
        return decorated;
    }

    if (!profile || profile.status !== 'calibrated') {
        normalization.status = 'calibration_required';
        normalization.warning = profile?.reason
            || 'No labeled genuine/impostor benchmark score set is available for this matcher.';
        return decorated;
    }

    const runtimeThreshold = Number(result.threshold);
    const calibratedThreshold = Number(profile.threshold);
    if (!Number.isFinite(runtimeThreshold) || Math.abs(runtimeThreshold - calibratedThreshold) > 1e-9) {
        normalization.status = 'threshold_mismatch';
        normalization.warning = `Calibration Required: runtime threshold is ${result.threshold}; calibrated threshold is ${profile.threshold}.`;
        return decorated;
    }

    const percentage = normalizeWithProfile(decorated.rawScore, profile);
    if (!Number.isFinite(percentage)) {
        normalization.status = 'invalid_profile';
        normalization.warning = 'Calibration Required: the stored calibration profile is incomplete or invalid.';
        return decorated;
    }

    decorated.normalizedMatchPercentage = percentage;
    normalization.status = 'calibrated';
    normalization.warning = 'This percentage is a matcher-specific interpretation of the native score, not a probability of identity or system accuracy.';
    return decorated;
}

module.exports = {
    attachMatchPercentage,
    normalizeWithProfile
};
