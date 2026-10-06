const assert = require('node:assert/strict');
const test = require('node:test');

const {
    classifyMinutiaByCrossingNumber,
    countRidgeTransitions
} = require('../matchers/minutiae-conventions');

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
