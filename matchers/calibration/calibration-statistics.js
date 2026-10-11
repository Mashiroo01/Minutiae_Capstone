'use strict';

const MINIMUM_CLASS_SAMPLES = 30;

function round(value, digits = 6) {
    const factor = 10 ** digits;
    return Math.round(Number(value) * factor) / factor;
}

function summarizeScores(input) {
    const values = (Array.isArray(input) ? input : [])
        .map((item) => Number(typeof item === 'object' ? item.score : item))
        .filter(Number.isFinite)
        .sort((left, right) => left - right);
    if (!values.length) return null;
    const percentile = (fraction) => values[Math.min(values.length - 1, Math.floor((values.length - 1) * fraction))];
    return {
        count: values.length,
        minimum: values[0],
        p25: percentile(0.25),
        median: percentile(0.5),
        p75: percentile(0.75),
        p95: percentile(0.95),
        maximum: values[values.length - 1],
        mean: round(values.reduce((sum, value) => sum + value, 0) / values.length, 4)
    };
}

function confusion(rows, threshold) {
    const genuine = rows.filter((row) => row.label === 'genuine');
    const impostor = rows.filter((row) => row.label === 'impostor');
    const tp = genuine.filter((row) => Number(row.score) >= threshold).length;
    const fn = genuine.length - tp;
    const fp = impostor.filter((row) => Number(row.score) >= threshold).length;
    const tn = impostor.length - fp;
    const precision = tp + fp ? tp / (tp + fp) : 0;
    const recall = tp + fn ? tp / (tp + fn) : 0;
    const far = fp + tn ? fp / (fp + tn) : 0;
    const frr = fn + tp ? fn / (fn + tp) : 0;
    return {
        threshold: round(threshold, 9),
        tp,
        fn,
        fp,
        tn,
        accuracy: (tp + tn) / Math.max(1, rows.length),
        precision,
        recall,
        f1: precision + recall ? (2 * precision * recall) / (precision + recall) : 0,
        far,
        frr,
        balancedAccuracy: ((tp / Math.max(1, tp + fn)) + (tn / Math.max(1, tn + fp))) / 2
    };
}

function selectThreshold(rows) {
    const scoredRows = (Array.isArray(rows) ? rows : []).filter((row) =>
        ['genuine', 'impostor'].includes(row?.label) && Number.isFinite(Number(row.score)));
    if (!scoredRows.length) throw new Error('Threshold selection requires labeled finite scores.');
    const values = [...new Set(scoredRows.map((row) => Number(row.score)))].sort((left, right) => left - right);
    const span = Math.max(1, Math.abs(values[values.length - 1] - values[0]));
    const epsilon = span * 1e-9;
    const candidates = [values[0] - epsilon, values[values.length - 1] + epsilon];
    for (let index = 0; index < values.length - 1; index += 1) {
        candidates.push((values[index] + values[index + 1]) / 2);
    }
    return candidates
        .map((threshold) => confusion(scoredRows, threshold))
        .sort((left, right) => {
            const leftErrors = left.fp + left.fn;
            const rightErrors = right.fp + right.fn;
            return leftErrors - rightErrors
                || left.fp - right.fp
                || Math.abs(left.far - left.frr) - Math.abs(right.far - right.frr)
                || left.threshold - right.threshold;
        })[0];
}

function buildCalibrationProfile(options) {
    const threshold = Number(options?.threshold);
    const genuine = options?.genuine;
    const impostor = options?.impostor;
    if (!genuine || !impostor
        || genuine.count < MINIMUM_CLASS_SAMPLES
        || impostor.count < MINIMUM_CLASS_SAMPLES) {
        return {
            status: 'calibration_required',
            matcher: options?.matcher || null,
            threshold: Number.isFinite(threshold) ? threshold : null,
            reason: `At least ${MINIMUM_CLASS_SAMPLES} genuine and ${MINIMUM_CLASS_SAMPLES} impostor scores are required.`
        };
    }

    const lowerScore = Number(impostor.p25) < threshold ? Number(impostor.p25) : Number(impostor.minimum);
    const lowerBasis = Number(impostor.p25) < threshold ? 'impostor p25' : 'impostor minimum';
    const upperScore = Number(genuine.p95) > threshold ? Number(genuine.p95) : Number(genuine.maximum);
    const upperBasis = Number(genuine.p95) > threshold ? 'genuine p95' : 'genuine maximum';
    if (![threshold, lowerScore, upperScore].every(Number.isFinite)
        || !(lowerScore < threshold && threshold < upperScore)) {
        return {
            status: 'calibration_required',
            matcher: options?.matcher || null,
            threshold: Number.isFinite(threshold) ? threshold : null,
            reason: 'The benchmark score distributions do not bracket the selected threshold.'
        };
    }

    return {
        status: 'calibrated',
        profileId: options.profileId || `${String(options.matcher || 'matcher').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${String(options.generatedAt || '').replace(/[^0-9]/g, '').slice(0, 14)}`,
        matcher: options.matcher,
        matcherFeed: options.matcherFeed,
        dataset: options.dataset,
        report: options.report,
        generatedAt: options.generatedAt,
        threshold,
        scoreDirection: 'higher-is-more-similar',
        method: 'piecewise-linear-threshold-anchored',
        mapping: {
            lowerScore,
            lowerBasis,
            upperScore,
            upperBasis
        },
        distributions: { impostor, genuine },
        validation: options.validation || null
    };
}

module.exports = {
    MINIMUM_CLASS_SAMPLES,
    buildCalibrationProfile,
    confusion,
    selectThreshold,
    summarizeScores
};
