'use strict';

const TWO_PI = Math.PI * 2;

function normalizeAngle(angle) {
    const value = Number(angle);
    if (!Number.isFinite(value)) return 0;
    return ((value % TWO_PI) + TWO_PI) % TWO_PI;
}

function signedAngleDifference(left, right) {
    let difference = normalizeAngle(left) - normalizeAngle(right);
    if (difference > Math.PI) difference -= TWO_PI;
    if (difference <= -Math.PI) difference += TWO_PI;
    return difference;
}

function circularAngleDifference(left, right) {
    return Math.abs(signedAngleDifference(left, right));
}

function finiteMinutiae(minutiae) {
    return (Array.isArray(minutiae) ? minutiae : [])
        .map((minutia, index) => ({ ...minutia, _alignmentIndex: index }))
        .filter((minutia) => [minutia.x, minutia.y, minutia.angle].every((value) => Number.isFinite(Number(value))));
}

function buildDescriptors(minutiae, neighborCount = 5) {
    return minutiae.map((origin, originIndex) => {
        const neighbors = minutiae
            .map((neighbor, neighborIndex) => {
                if (neighborIndex === originIndex) return null;
                const dx = Number(neighbor.x) - Number(origin.x);
                const dy = Number(neighbor.y) - Number(origin.y);
                return {
                    distance: Math.hypot(dx, dy),
                    bearing: normalizeAngle(Math.atan2(dy, dx) - Number(origin.angle)),
                    direction: signedAngleDifference(Number(neighbor.angle), Number(origin.angle)),
                    sameType: !origin.type || !neighbor.type || origin.type === neighbor.type
                };
            })
            .filter(Boolean)
            .sort((left, right) => left.distance - right.distance)
            .slice(0, neighborCount);
        return neighbors;
    });
}

function descriptorSimilarity(left, right) {
    const count = Math.min(left.length, right.length);
    if (!count) return 0;
    let total = 0;
    for (let index = 0; index < count; index++) {
        const distanceScore = Math.exp(-Math.abs(left[index].distance - right[index].distance) / 22);
        const bearingScore = Math.exp(-circularAngleDifference(left[index].bearing, right[index].bearing) / 0.55);
        const directionScore = Math.exp(-circularAngleDifference(left[index].direction, right[index].direction) / 0.65);
        const typeScore = left[index].sameType === right[index].sameType ? 1 : 0.75;
        total += (distanceScore * 0.42) + (bearingScore * 0.30) + (directionScore * 0.20) + (typeScore * 0.08);
    }
    return total / count;
}

function applyTransform(minutia, transform) {
    const cos = Math.cos(transform.rotation);
    const sin = Math.sin(transform.rotation);
    const x = Number(minutia.x);
    const y = Number(minutia.y);
    return {
        ...minutia,
        x: (x * cos) - (y * sin) + transform.translation.x,
        y: (x * sin) + (y * cos) + transform.translation.y,
        angle: normalizeAngle(Number(minutia.angle) + transform.rotation)
    };
}

function collectCorrespondences(probe, candidate, probeDescriptors, candidateDescriptors, transform, options) {
    const possibilities = [];
    for (let probeIndex = 0; probeIndex < probe.length; probeIndex++) {
        for (let candidateIndex = 0; candidateIndex < candidate.length; candidateIndex++) {
            const probeMinutia = probe[probeIndex];
            const candidateMinutia = candidate[candidateIndex];
            if (probeMinutia.type && candidateMinutia.type && probeMinutia.type !== candidateMinutia.type) continue;
            const aligned = applyTransform(candidateMinutia, transform);
            const distance = Math.hypot(Number(probeMinutia.x) - aligned.x, Number(probeMinutia.y) - aligned.y);
            if (distance > options.distanceTolerance) continue;
            const directionError = circularAngleDifference(Number(probeMinutia.angle), aligned.angle);
            if (directionError > options.directionTolerance) continue;
            const localSimilarity = descriptorSimilarity(probeDescriptors[probeIndex], candidateDescriptors[candidateIndex]);
            if (localSimilarity < options.minimumDescriptorSimilarity) continue;
            const cost = (distance / options.distanceTolerance)
                + (directionError / options.directionTolerance)
                + ((1 - localSimilarity) * 0.7);
            possibilities.push({ probeIndex, candidateIndex, distance, directionError, localSimilarity, cost, aligned });
        }
    }
    possibilities.sort((left, right) => left.cost - right.cost);
    const usedProbe = new Set();
    const usedCandidate = new Set();
    const pairs = [];
    for (const possibility of possibilities) {
        if (usedProbe.has(possibility.probeIndex) || usedCandidate.has(possibility.candidateIndex)) continue;
        usedProbe.add(possibility.probeIndex);
        usedCandidate.add(possibility.candidateIndex);
        pairs.push(possibility);
    }
    return pairs;
}

function refineTransform(probe, candidate, pairs, fallback) {
    if (pairs.length < 2) return fallback;
    let probeX = 0;
    let probeY = 0;
    let candidateX = 0;
    let candidateY = 0;
    for (const pair of pairs) {
        probeX += Number(probe[pair.probeIndex].x);
        probeY += Number(probe[pair.probeIndex].y);
        candidateX += Number(candidate[pair.candidateIndex].x);
        candidateY += Number(candidate[pair.candidateIndex].y);
    }
    probeX /= pairs.length;
    probeY /= pairs.length;
    candidateX /= pairs.length;
    candidateY /= pairs.length;

    let dot = 0;
    let cross = 0;
    for (const pair of pairs) {
        const cx = Number(candidate[pair.candidateIndex].x) - candidateX;
        const cy = Number(candidate[pair.candidateIndex].y) - candidateY;
        const px = Number(probe[pair.probeIndex].x) - probeX;
        const py = Number(probe[pair.probeIndex].y) - probeY;
        dot += (cx * px) + (cy * py);
        cross += (cx * py) - (cy * px);
    }
    const geometryRotation = Math.atan2(cross, dot);
    let directionX = 0;
    let directionY = 0;
    for (const pair of pairs) {
        const difference = signedAngleDifference(
            Number(probe[pair.probeIndex].angle),
            Number(candidate[pair.candidateIndex].angle)
        );
        directionX += Math.cos(difference);
        directionY += Math.sin(difference);
    }
    const directionRotation = Math.atan2(directionY, directionX);
    const geometryWeight = pairs.length >= 3 ? 0.72 : 0.5;
    const gx = Math.cos(geometryRotation) * geometryWeight + Math.cos(directionRotation) * (1 - geometryWeight);
    const gy = Math.sin(geometryRotation) * geometryWeight + Math.sin(directionRotation) * (1 - geometryWeight);
    const rotation = Math.atan2(gy, gx);
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    return {
        rotation,
        translation: {
            x: probeX - ((candidateX * cos) - (candidateY * sin)),
            y: probeY - ((candidateX * sin) + (candidateY * cos))
        }
    };
}

function summarizeAlignment(probe, candidate, pairs, transform) {
    const residuals = pairs.map((pair) => {
        const aligned = applyTransform(candidate[pair.candidateIndex], transform);
        return {
            probeIndex: probe[pair.probeIndex]._alignmentIndex,
            candidateIndex: candidate[pair.candidateIndex]._alignmentIndex,
            probe: {
                x: Number(probe[pair.probeIndex].x),
                y: Number(probe[pair.probeIndex].y),
                angle: normalizeAngle(Number(probe[pair.probeIndex].angle))
            },
            candidate: {
                x: Number(candidate[pair.candidateIndex].x),
                y: Number(candidate[pair.candidateIndex].y),
                angle: normalizeAngle(Number(candidate[pair.candidateIndex].angle))
            },
            aligned: { x: aligned.x, y: aligned.y, angle: aligned.angle },
            distance: Math.hypot(Number(probe[pair.probeIndex].x) - aligned.x, Number(probe[pair.probeIndex].y) - aligned.y),
            directionError: circularAngleDifference(Number(probe[pair.probeIndex].angle), aligned.angle),
            localSimilarity: pair.localSimilarity
        };
    });
    const squareError = residuals.reduce((total, pair) => total + (pair.distance * pair.distance), 0);
    const directionError = residuals.reduce((total, pair) => total + pair.directionError, 0);
    return {
        rotation: signedAngleDifference(transform.rotation, 0),
        translation: { x: transform.translation.x, y: transform.translation.y },
        matchedCount: residuals.length,
        supportRatio: residuals.length / Math.max(1, Math.min(probe.length, candidate.length)),
        rmsError: residuals.length ? Math.sqrt(squareError / residuals.length) : null,
        meanDirectionError: residuals.length ? directionError / residuals.length : null,
        pairs: residuals
    };
}

function estimateRigidAlignment(probeInput, candidateInput, overrides = {}) {
    const probe = finiteMinutiae(probeInput);
    const candidate = finiteMinutiae(candidateInput);
    if (probe.length < 2 || candidate.length < 2) return null;
    const options = {
        neighborCount: 5,
        maximumRotation: 45 * Math.PI / 180,
        distanceTolerance: 15,
        directionTolerance: 28 * Math.PI / 180,
        minimumDescriptorSimilarity: 0.28,
        maximumHypotheses: 220,
        ...overrides
    };
    const probeDescriptors = buildDescriptors(probe, options.neighborCount);
    const candidateDescriptors = buildDescriptors(candidate, options.neighborCount);
    const hypotheses = [];
    for (let probeIndex = 0; probeIndex < probe.length; probeIndex++) {
        for (let candidateIndex = 0; candidateIndex < candidate.length; candidateIndex++) {
            if (probe[probeIndex].type && candidate[candidateIndex].type && probe[probeIndex].type !== candidate[candidateIndex].type) continue;
            const rotation = signedAngleDifference(Number(probe[probeIndex].angle), Number(candidate[candidateIndex].angle));
            if (Math.abs(rotation) > options.maximumRotation) continue;
            const descriptorScore = descriptorSimilarity(probeDescriptors[probeIndex], candidateDescriptors[candidateIndex]);
            if (descriptorScore < options.minimumDescriptorSimilarity) continue;
            const cos = Math.cos(rotation);
            const sin = Math.sin(rotation);
            hypotheses.push({
                descriptorScore,
                transform: {
                    rotation,
                    translation: {
                        x: Number(probe[probeIndex].x) - ((Number(candidate[candidateIndex].x) * cos) - (Number(candidate[candidateIndex].y) * sin)),
                        y: Number(probe[probeIndex].y) - ((Number(candidate[candidateIndex].x) * sin) + (Number(candidate[candidateIndex].y) * cos))
                    }
                }
            });
        }
    }
    hypotheses.sort((left, right) => right.descriptorScore - left.descriptorScore);
    let best = null;
    for (const hypothesis of hypotheses.slice(0, options.maximumHypotheses)) {
        let transform = hypothesis.transform;
        let pairs = collectCorrespondences(probe, candidate, probeDescriptors, candidateDescriptors, transform, options);
        for (let iteration = 0; iteration < 2 && pairs.length >= 2; iteration++) {
            transform = refineTransform(probe, candidate, pairs, transform);
            pairs = collectCorrespondences(probe, candidate, probeDescriptors, candidateDescriptors, transform, options);
        }
        const summary = summarizeAlignment(probe, candidate, pairs, transform);
        const rank = (summary.matchedCount * 100)
            + (summary.supportRatio * 20)
            - (summary.rmsError || options.distanceTolerance)
            - ((summary.meanDirectionError || options.directionTolerance) * 5);
        if (!best || rank > best.rank) best = { ...summary, rank };
    }
    if (!best) return null;
    delete best.rank;
    return best;
}

function transformMinutiae(minutiae, transform) {
    if (!transform) return (Array.isArray(minutiae) ? minutiae : []).map((minutia) => ({ ...minutia }));
    return (Array.isArray(minutiae) ? minutiae : []).map((minutia) => {
        const transformed = applyTransform(minutia, transform);
        delete transformed._alignmentIndex;
        return transformed;
    });
}

module.exports = {
    circularAngleDifference,
    estimateRigidAlignment,
    normalizeAngle,
    signedAngleDifference,
    transformMinutiae
};
