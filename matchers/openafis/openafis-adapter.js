'use strict';

const TWO_PI = Math.PI * 2;

function normalizeAngle(angle) {
    return ((Number(angle) % TWO_PI) + TWO_PI) % TWO_PI;
}

function signedAngleDifference(left, right) {
    let difference = normalizeAngle(left) - normalizeAngle(right);
    if (difference > Math.PI) difference -= TWO_PI;
    if (difference <= -Math.PI) difference += TWO_PI;
    return difference;
}

function median(values) {
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function positiveDimension(value) {
    const number = Math.ceil(Number(value));
    return Number.isFinite(number) && number > 0 ? number : 0;
}

function createIsotropicCanvas(...templates) {
    const size = Math.max(1, ...templates.flatMap((template) => [
        positiveDimension(template?.width),
        positiveDimension(template?.height)
    ]));
    return { width: size, height: size };
}

function toOpenAfisCsv(minutiae, canvas) {
    const width = positiveDimension(canvas?.width);
    const height = positiveDimension(canvas?.height);
    if (!width || !height) throw new Error('OpenAFIS requires positive template dimensions.');
    const lines = [`${width},${height}`];
    for (const minutia of Array.isArray(minutiae) ? minutiae : []) {
        const type = minutia?.type === 'bifurcation' ? 2 : minutia?.type === 'ending' ? 1 : 0;
        const x = Number(minutia?.x);
        const y = Number(minutia?.y);
        const angle = Number(minutia?.angle);
        if (!type || ![x, y, angle].every(Number.isFinite)) continue;
        lines.push(`${type},${Math.round(x)},${Math.round(y)},${angle}`);
    }
    return `${lines.join('\n')}\n`;
}

function transformPoint(point, transform) {
    const cos = Math.cos(transform.rotation);
    const sin = Math.sin(transform.rotation);
    return {
        x: (Number(point.x) * cos) - (Number(point.y) * sin) + transform.translation.x,
        y: (Number(point.x) * sin) + (Number(point.y) * cos) + transform.translation.y,
        directionRad: Number.isFinite(Number(point.directionRad))
            ? normalizeAngle(Number(point.directionRad) + transform.rotation)
            : null
    };
}

function transformForRotation(pairs, rotation) {
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    return {
        rotation,
        translation: {
            x: median(pairs.map((pair) => Number(pair.probe.x) - ((Number(pair.reference.x) * cos) - (Number(pair.reference.y) * sin)))),
            y: median(pairs.map((pair) => Number(pair.probe.y) - ((Number(pair.reference.x) * sin) + (Number(pair.reference.y) * cos))))
        }
    };
}

function inlierPairs(pairs, transform, distanceTolerance = 20, directionTolerance = 35 * Math.PI / 180) {
    return pairs.filter((pair) => {
        const aligned = transformPoint(pair.reference, transform);
        const distance = Math.hypot(Number(pair.probe.x) - aligned.x, Number(pair.probe.y) - aligned.y);
        const hasDirections = Number.isFinite(Number(pair.probe.directionRad)) && Number.isFinite(Number(pair.reference.directionRad));
        const directionError = hasDirections
            ? Math.abs(signedAngleDifference(Number(pair.probe.directionRad), aligned.directionRad))
            : 0;
        return distance <= distanceTolerance && directionError <= directionTolerance;
    });
}

function refineTransform(pairs, fallback) {
    if (pairs.length < 2) return fallback;
    const probeCenter = {
        x: pairs.reduce((sum, pair) => sum + Number(pair.probe.x), 0) / pairs.length,
        y: pairs.reduce((sum, pair) => sum + Number(pair.probe.y), 0) / pairs.length
    };
    const referenceCenter = {
        x: pairs.reduce((sum, pair) => sum + Number(pair.reference.x), 0) / pairs.length,
        y: pairs.reduce((sum, pair) => sum + Number(pair.reference.y), 0) / pairs.length
    };
    let dot = 0;
    let cross = 0;
    for (const pair of pairs) {
        const rx = Number(pair.reference.x) - referenceCenter.x;
        const ry = Number(pair.reference.y) - referenceCenter.y;
        const px = Number(pair.probe.x) - probeCenter.x;
        const py = Number(pair.probe.y) - probeCenter.y;
        dot += (rx * px) + (ry * py);
        cross += (rx * py) - (ry * px);
    }
    const rotation = Math.atan2(cross, dot);
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    return {
        rotation,
        translation: {
            x: probeCenter.x - ((referenceCenter.x * cos) - (referenceCenter.y * sin)),
            y: probeCenter.y - ((referenceCenter.x * sin) + (referenceCenter.y * cos))
        }
    };
}

function estimateAlignmentFromPairs(rawPairs) {
    const pairs = (Array.isArray(rawPairs) ? rawPairs : []).filter((pair) =>
        [pair?.probe?.x, pair?.probe?.y, pair?.reference?.x, pair?.reference?.y].every((value) => Number.isFinite(Number(value))));
    if (!pairs.length) {
        return {
            available: false,
            message: 'OpenAFIS returned no correspondence pairs from which to estimate a rigid transform.',
            matchedMinutiaeCount: 0,
            rawPairCount: 0,
            pairs: []
        };
    }

    const rotationCandidates = [];
    for (const pair of pairs) {
        if (Number.isFinite(Number(pair.probe.directionRad)) && Number.isFinite(Number(pair.reference.directionRad))) {
            rotationCandidates.push(signedAngleDifference(Number(pair.probe.directionRad), Number(pair.reference.directionRad)));
        }
    }
    for (let left = 0; left < pairs.length; left++) {
        for (let right = left + 1; right < pairs.length; right++) {
            const probeDx = Number(pairs[right].probe.x) - Number(pairs[left].probe.x);
            const probeDy = Number(pairs[right].probe.y) - Number(pairs[left].probe.y);
            const referenceDx = Number(pairs[right].reference.x) - Number(pairs[left].reference.x);
            const referenceDy = Number(pairs[right].reference.y) - Number(pairs[left].reference.y);
            if (Math.hypot(probeDx, probeDy) < 12 || Math.hypot(referenceDx, referenceDy) < 12) continue;
            rotationCandidates.push(signedAngleDifference(Math.atan2(probeDy, probeDx), Math.atan2(referenceDy, referenceDx)));
        }
    }
    if (!rotationCandidates.length) rotationCandidates.push(0);

    let best = null;
    for (const rotation of rotationCandidates) {
        const transform = transformForRotation(pairs, rotation);
        const inliers = inlierPairs(pairs, transform);
        const residual = inliers.reduce((sum, pair) => {
            const aligned = transformPoint(pair.reference, transform);
            return sum + Math.hypot(Number(pair.probe.x) - aligned.x, Number(pair.probe.y) - aligned.y);
        }, 0);
        if (!best || inliers.length > best.inliers.length || (inliers.length === best.inliers.length && residual < best.residual)) {
            best = { transform, inliers, residual };
        }
    }
    let transform = refineTransform(best.inliers, best.transform);
    const inliers = inlierPairs(pairs, transform);
    if (inliers.length >= 2) transform = refineTransform(inliers, transform);
    const inlierSet = new Set(inliers);
    const renderedPairs = pairs.map((pair) => {
        const aligned = transformPoint(pair.reference, transform);
        return {
            ...pair,
            probe: { ...pair.probe },
            reference: { ...pair.reference, alignedX: aligned.x, alignedY: aligned.y, alignedDirectionRad: aligned.directionRad },
            alignmentInlier: inlierSet.has(pair),
            residualPx: Math.hypot(Number(pair.probe.x) - aligned.x, Number(pair.probe.y) - aligned.y)
        };
    });
    const inlierResiduals = renderedPairs.filter((pair) => pair.alignmentInlier).map((pair) => pair.residualPx);
    return {
        available: true,
        source: 'Rigid transform estimated from actual OpenAFIS MatchRenderable correspondence pairs.',
        estimatedRotationDeg: Math.round(signedAngleDifference(transform.rotation, 0) * 180 / Math.PI * 100) / 100,
        estimatedXTranslationPx: Math.round(transform.translation.x * 100) / 100,
        estimatedYTranslationPx: Math.round(transform.translation.y * 100) / 100,
        matchedMinutiaeCount: inliers.length,
        rawPairCount: pairs.length,
        rmsResidualPx: inlierResiduals.length
            ? Math.round(Math.sqrt(inlierResiduals.reduce((sum, value) => sum + (value * value), 0) / inlierResiduals.length) * 100) / 100
            : null,
        transform: { rotation: transform.rotation, translation: transform.translation },
        pairs: renderedPairs
    };
}

module.exports = {
    createIsotropicCanvas,
    estimateAlignmentFromPairs,
    toOpenAfisCsv
};
