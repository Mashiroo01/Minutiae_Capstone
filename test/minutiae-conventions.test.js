const assert = require('node:assert/strict');
const test = require('node:test');

const {
    classifyMinutiaByCrossingNumber,
    countRidgeTransitions,
    ridgeNeighborRing
} = require('../matchers/minutiae-conventions');

test('the crossing-number ring contains each of the eight neighbors exactly once in clockwise order', () => {
    const binary = Uint8Array.from([
        1, 2, 3,
        8, 0, 4,
        7, 6, 5
    ]);
    assert.deepEqual(ridgeNeighborRing(binary, 3, 1, 1), [2, 3, 4, 5, 6, 7, 8, 1]);
});

test('one ridge transition is a ridge ending', () => {
    const neighbors = [1, 0, 0, 0, 0, 0, 0, 0];
    assert.equal(countRidgeTransitions(neighbors), 1);
    assert.equal(classifyMinutiaByCrossingNumber(neighbors), 'ending');
});

test('three ridge transitions are a bifurcation', () => {
    const neighbors = [1, 0, 1, 0, 1, 0, 0, 0];
    assert.equal(countRidgeTransitions(neighbors), 3);
    assert.equal(classifyMinutiaByCrossingNumber(neighbors), 'bifurcation');
});

test('ordinary two-neighbor ridge pixels are not minutiae', () => {
    const neighbors = [1, 0, 0, 0, 1, 0, 0, 0];
    assert.equal(countRidgeTransitions(neighbors), 2);
    assert.equal(classifyMinutiaByCrossingNumber(neighbors), null);
});
