// Command-line bridge for neilharan/openafis (BSD-2-Clause).
// Input files use OpenAFIS' documented research CSV format.

#include "OpenAFIS.h"
// Upstream currently keeps this template implementation in a .cpp file without
// explicit CSV instantiations, so it must be visible in this translation unit.
#include "TemplateCSV.cpp"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <set>
#include <string>
#include <tuple>
#include <vector>

namespace {
struct PairOutput {
    int similarity;
    int probeX;
    int probeY;
    int referenceX;
    int referenceY;
};

int unscale(OpenAFIS::Field::MinutiaCoordType coordinate, int dimension) {
    return static_cast<int>(std::lround(static_cast<double>(coordinate) * dimension / 256.0));
}

void fail(const std::string& message) {
    std::cerr << message << '\n';
    std::exit(1);
}
}

int main(int argc, char** argv) {
    if (argc != 3) {
        fail("Usage: openafis-match <probe.csv> <reference.csv>");
    }

    using Template = OpenAFIS::TemplateCSV<uint32_t, OpenAFIS::FingerprintRenderable>;
    Template probe(1);
    Template reference(2);
    if (!probe.load(argv[1])) {
        fail("OpenAFIS could not load the probe minutiae CSV.");
    }
    if (!reference.load(argv[2])) {
        fail("OpenAFIS could not load the reference minutiae CSV.");
    }
    if (probe.fingerprints().empty() || reference.fingerprints().empty()) {
        fail("OpenAFIS did not find a fingerprint in one of the minutiae templates.");
    }

    const auto& probeFingerprint = probe.fingerprints().front();
    const auto& referenceFingerprint = reference.fingerprints().front();
    uint8_t score = 0;
    OpenAFIS::MatchSimilarity similarityMatcher;
    similarityMatcher.compute(score, probeFingerprint, referenceFingerprint);

    OpenAFIS::MinutiaPoint::PairRenderable::Set rawPairs;
    OpenAFIS::MatchRenderable pairMatcher;
    pairMatcher.compute(rawPairs, probeFingerprint, referenceFingerprint);

    const int probeWidth = probeFingerprint.dimensions().first;
    const int probeHeight = probeFingerprint.dimensions().second;
    const int referenceWidth = referenceFingerprint.dimensions().first;
    const int referenceHeight = referenceFingerprint.dimensions().second;
    std::vector<PairOutput> pairs;
    pairs.reserve(rawPairs.size());
    for (const auto* pair : rawPairs) {
        pairs.push_back({
            pair->similarity(),
            unscale(pair->probe()->x(), probeWidth),
            unscale(pair->probe()->y(), probeHeight),
            unscale(pair->candidate()->x(), referenceWidth),
            unscale(pair->candidate()->y(), referenceHeight)
        });
    }

    std::sort(pairs.begin(), pairs.end(), [](const PairOutput& left, const PairOutput& right) {
        return left.similarity > right.similarity;
    });
    std::set<std::pair<int, int>> usedProbe;
    std::set<std::pair<int, int>> usedReference;
    std::vector<PairOutput> uniquePairs;
    for (const auto& pair : pairs) {
        const auto probeKey = std::make_pair(pair.probeX, pair.probeY);
        const auto referenceKey = std::make_pair(pair.referenceX, pair.referenceY);
        if (usedProbe.count(probeKey) || usedReference.count(referenceKey)) {
            continue;
        }
        usedProbe.insert(probeKey);
        usedReference.insert(referenceKey);
        uniquePairs.push_back(pair);
    }

    std::cout << "{\"score\":" << static_cast<int>(score) << ",\"matchedPairs\":[";
    for (std::size_t index = 0; index < uniquePairs.size(); ++index) {
        if (index) {
            std::cout << ',';
        }
        const auto& pair = uniquePairs[index];
        std::cout << "{\"probeX\":" << pair.probeX
                  << ",\"probeY\":" << pair.probeY
                  << ",\"referenceX\":" << pair.referenceX
                  << ",\"referenceY\":" << pair.referenceY
                  << ",\"similarity\":" << pair.similarity << '}';
    }
    std::cout << "]}" << '\n';
    return 0;
}
