'use strict';

function countRidgeTransitions(neighbors) {
    if (!Array.isArray(neighbors) || neighbors.length === 0) return 0;
    let total = 0;
    for (let index = 0; index < neighbors.length; index++) {
        const current = neighbors[index] ? 1 : 0;
        const next = neighbors[(index + 1) % neighbors.length] ? 1 : 0;
        if (current === 0 && next === 1) total++;
    }
    return total;
}

function ridgeNeighborRing(binary, width, x, y) {
    return [
        binary[(y - 1) * width + x],
        binary[(y - 1) * width + (x + 1)],
        binary[y * width + (x + 1)],
        binary[(y + 1) * width + (x + 1)],
        binary[(y + 1) * width + x],
        binary[(y + 1) * width + (x - 1)],
        binary[y * width + (x - 1)],
        binary[(y - 1) * width + (x - 1)]
    ];
}

function classifyMinutiaByCrossingNumber(neighbors) {
    const crossingNumber = countRidgeTransitions(neighbors);
    if (crossingNumber === 1) return 'ending';
    if (crossingNumber === 3) return 'bifurcation';
    return null;
}

module.exports = {
    classifyMinutiaByCrossingNumber,
    countRidgeTransitions,
    ridgeNeighborRing
};
