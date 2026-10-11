'use strict';

const SUPPORTING_MATCHERS = ['SourceAFIS', 'OpenAFIS', 'MCC', 'Jiang Matcher'];

function roundPercentage(value) {
    return Math.round(Number(value) * 100) / 100;
}

function buildSupportingMatcherArbiter(matchers) {
    const byAlgorithm = new Map((Array.isArray(matchers) ? matchers : []).map((matcher) => [matcher.algorithm, matcher]));
    const components = SUPPORTING_MATCHERS.map((algorithm) => byAlgorithm.get(algorithm)).filter(Boolean);
    const calibrated = components.filter((matcher) =>
        matcher.status === 'ok'
        && matcher.normalization?.status === 'calibrated'
        && Number.isFinite(Number(matcher.normalizedMatchPercentage)));
    const matchVotes = calibrated.filter((matcher) => matcher.result === 'MATCH').length;
    const noMatchVotes = calibrated.filter((matcher) => matcher.result === 'NO MATCH').length;
    const availableMatchers = calibrated.length;
    const normalizedMatchPercentage = availableMatchers >= 3
        ? roundPercentage(calibrated.reduce((sum, matcher) => sum + Number(matcher.normalizedMatchPercentage), 0) / availableMatchers)
        : null;
    const agreementPercentage = availableMatchers
        ? roundPercentage((Math.max(matchVotes, noMatchVotes) / availableMatchers) * 100)
        : null;
    const complete = availableMatchers === SUPPORTING_MATCHERS.length;
    const result = complete && matchVotes >= 3
        ? 'MATCH'
        : complete && noMatchVotes >= 3
            ? 'NO MATCH'
            : 'REVIEW REQUIRED';

    return {
        name: 'Four-Model Supporting Arbiter',
        status: complete ? 'ok' : availableMatchers >= 3 ? 'incomplete' : 'unavailable',
        method: 'Unweighted mean of matcher-specific calibrated percentages; decision requires a 3-of-4 vote.',
        normalizedMatchPercentage,
        threshold: 50,
        result,
        decision: result,
        matchVotes,
        noMatchVotes,
        availableMatchers,
        expectedMatchers: SUPPORTING_MATCHERS.length,
        agreementPercentage,
        components: SUPPORTING_MATCHERS.map((algorithm) => {
            const matcher = byAlgorithm.get(algorithm);
            return {
                algorithm,
                status: matcher?.normalization?.status || matcher?.status || 'missing',
                normalizedMatchPercentage: Number.isFinite(Number(matcher?.normalizedMatchPercentage))
                    ? Number(matcher.normalizedMatchPercentage)
                    : null,
                decision: matcher?.result || 'UNAVAILABLE'
            };
        }),
        warning: complete
            ? 'The arbiter percentage is a calibrated score interpretation, not a probability of identity or system accuracy.'
            : 'All four supporting matchers must be calibrated and available before the arbiter can issue a MATCH or NO MATCH decision.'
    };
}

module.exports = {
    SUPPORTING_MATCHERS,
    buildSupportingMatcherArbiter
};
