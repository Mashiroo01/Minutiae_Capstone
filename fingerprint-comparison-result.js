'use strict';

(function exposeFingerprintComparison(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) {
        module.exports = api;
    }
    if (root) {
        root.FingerprintComparison = api;
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function createFingerprintComparisonApi() {
    const MATCHER_ORDER = ['Modified Bozorth3', 'SourceAFIS', 'OpenAFIS', 'MCC', 'Jiang Matcher'];

    function finiteNumber(value) {
        const number = Number(value);
        return Number.isFinite(number) ? number : null;
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function safeJson(value) {
        try {
            return JSON.stringify(value ?? null, null, 2);
        } catch (error) {
            return 'Unavailable';
        }
    }

    function formatValue(value, suffix = '') {
        if (value === null || value === undefined || value === '') return 'Unavailable';
        const number = Number(value);
        if (Number.isFinite(number)) {
            const rounded = Math.round(number * 100) / 100;
            return `${rounded}${suffix}`;
        }
        return `${String(value)}${suffix}`;
    }

    function qualityState(value) {
        const score = finiteNumber(value);
        if (score === null) return { score: null, label: 'Unavailable' };
        if (score >= 70) return { score, label: 'Good' };
        if (score >= 45) return { score, label: 'Acceptable' };
        return { score, label: 'Poor' };
    }

    function matcherPercentage(matcher) {
        if (!matcher || matcher.normalization?.status !== 'calibrated') return null;
        return finiteNumber(matcher.normalizedMatchPercentage);
    }

    function matcherDecision(matcher) {
        const decision = String(matcher?.decision ?? matcher?.result ?? '').toUpperCase();
        return ['MATCH', 'NO MATCH', 'BORDERLINE'].includes(decision) ? decision : 'UNAVAILABLE';
    }

    function matcherByName(result, algorithm) {
        const requested = String(algorithm || '');
        const primaryAliases = ['Modified Bozorth3', 'Bozorth3'];
        return (Array.isArray(result?.matchers) ? result.matchers : [])
            .find((matcher) => primaryAliases.includes(requested)
                ? primaryAliases.includes(matcher?.algorithm)
                : matcher?.algorithm === requested) || null;
    }

    function deriveFinalResult(primaryMatcher) {
        const primaryDecision = matcherDecision(primaryMatcher);
        const reviewRequired = !primaryMatcher
            || primaryMatcher.status !== 'ok'
            || primaryMatcher.reviewRecommended === true
            || !['MATCH', 'NO MATCH'].includes(primaryDecision);

        return {
            decision: reviewRequired ? 'REVIEW REQUIRED' : primaryDecision,
            primaryMatcher: 'Modified Bozorth3',
            requiresHumanReview: true,
            reviewRecommended: reviewRequired
        };
    }

    function buildFingerprintComparisonResult(payload, metadata = {}) {
        const source = payload && typeof payload === 'object' ? payload : {};
        const matchers = Array.isArray(source.matchers) ? source.matchers : [];
        const primaryMatcher = matcherByName(source, 'Modified Bozorth3');
        const primaryDecision = matcherDecision(primaryMatcher);
        const completedMatchers = matchers.filter((matcher) => matcher?.status === 'ok');
        const agreeingMatchers = completedMatchers.filter((matcher) => matcherDecision(matcher) === primaryDecision);
        const openAfis = matcherByName(source, 'OpenAFIS');
        const correspondenceAvailable = openAfis?.matchedMinutiae?.available === true
            && Array.isArray(openAfis.matchedMinutiae.pairs);
        const pairs = correspondenceAvailable ? openAfis.matchedMinutiae.pairs : [];
        const subjectFingerprint = metadata.subjectFingerprint
            || source.subjectFingerprint
            || source.probe
            || null;
        const referenceFingerprint = metadata.referenceFingerprint
            || source.referenceFingerprint
            || source.reference
            || source.candidate
            || null;
        const comparisonId = metadata.comparisonId
            || source.comparisonId
            || source.traceId
            || null;
        const {
            subjectFingerprint: _storedSubjectAlias,
            referenceFingerprint: _storedReferenceAlias,
            visualization: _storedVisualization,
            ...serializableSource
        } = source;

        return {
            ...serializableSource,
            contractVersion: 'fingerprint-comparison-result/v1',
            comparisonId,
            probe: source.probe || subjectFingerprint,
            reference: source.reference || referenceFingerprint,
            quality: {
                subject: qualityState(subjectFingerprint?.afisQuality ?? subjectFingerprint?.quality),
                reference: qualityState(referenceFingerprint?.afisQuality ?? referenceFingerprint?.quality)
            },
            preprocessing: {
                subject: subjectFingerprint?.preprocessing ?? null,
                reference: referenceFingerprint?.preprocessing ?? null
            },
            matchers,
            primaryMatcher,
            matcherAgreement: {
                agreeing: agreeingMatchers.length,
                completed: completedMatchers.length,
                total: matchers.length,
                basisDecision: primaryDecision,
                label: `${agreeingMatchers.length} of ${completedMatchers.length}`
            },
            finalResult: deriveFinalResult(primaryMatcher),
            visualization: {
                sourceMatcher: correspondenceAvailable ? 'OpenAFIS' : null,
                correspondenceAvailable
            },
            correspondences: {
                available: correspondenceAvailable,
                sourceMatcher: correspondenceAvailable ? 'OpenAFIS' : null,
                pairs,
                message: openAfis?.matchedMinutiae?.message || null
            },
            technicalDetails: {
                traceId: source.traceId ?? null,
                inputDiagnostics: source.inputDiagnostics ?? null,
                sharedMinutiaeDiagnostics: source.sharedMinutiaeDiagnostics ?? null,
                supportingArbiter: source.supportingArbiter ?? null,
                scoreNotice: source.scoreNotice ?? null
            },
            createdAt: metadata.createdAt || source.createdAt || new Date().toISOString()
        };
    }

    function ensureComparisonResult(value) {
        if (value?.contractVersion === 'fingerprint-comparison-result/v1') {
            const subjectFingerprint = value.subjectFingerprint || value.probe || null;
            const referenceFingerprint = value.referenceFingerprint || value.reference || null;
            return {
                ...value,
                subjectFingerprint,
                referenceFingerprint,
                visualization: {
                    ...(value.visualization || {}),
                    subjectFingerprint,
                    referenceFingerprint
                }
            };
        }
        return buildFingerprintComparisonResult(value);
    }

    function imageSource(image) {
        const value = String(image || '').trim();
        if (!value) return '';
        return /^data:image\//i.test(value) ? value : `data:image/png;base64,${value}`;
    }

    function pointType(point) {
        const type = String(point?.type || '').toLowerCase();
        if (type.includes('bifur')) return 'bifurcation';
        if (type.includes('ending')) return 'ridge-ending';
        return 'unknown';
    }

    function plotPoint(point, fingerprint, area) {
        const width = finiteNumber(fingerprint?.width) || 500;
        const height = finiteNumber(fingerprint?.height) || 500;
        const x = finiteNumber(point?.x);
        const y = finiteNumber(point?.y);
        if (x === null || y === null) return null;
        const scale = Math.min(area.width / width, area.height / height);
        const renderedWidth = width * scale;
        const renderedHeight = height * scale;
        const imageX = area.x + ((area.width - renderedWidth) / 2);
        const imageY = area.y + ((area.height - renderedHeight) / 2);
        return {
            x: imageX + (x * scale),
            y: imageY + (y * scale)
        };
    }

    function marker(point, plotted, pairId, side) {
        if (!plotted) return '';
        const title = `${side} ${pointType(point)} (${formatValue(point?.x)}, ${formatValue(point?.y)})`;
        if (pointType(point) === 'bifurcation') {
            const points = `${plotted.x},${plotted.y - 6} ${plotted.x - 6},${plotted.y + 5} ${plotted.x + 6},${plotted.y + 5}`;
            return `<polygon class="fp-marker fp-bifurcation" data-pair-id="${escapeHtml(pairId)}" points="${points}" tabindex="0"><title>${escapeHtml(title)}</title></polygon>`;
        }
        if (pointType(point) === 'unknown') {
            return `<rect class="fp-marker fp-unknown-minutia" data-pair-id="${escapeHtml(pairId)}" x="${plotted.x - 5}" y="${plotted.y - 5}" width="10" height="10" tabindex="0"><title>${escapeHtml(`${side} minutia type unavailable (${formatValue(point?.x)}, ${formatValue(point?.y)})`)}</title></rect>`;
        }
        return `<circle class="fp-marker fp-ridge-ending" data-pair-id="${escapeHtml(pairId)}" cx="${plotted.x}" cy="${plotted.y}" r="5" tabindex="0"><title>${escapeHtml(title)}</title></circle>`;
    }

    function renderFingerprintVisualization(input) {
        const result = ensureComparisonResult(input);
        const subject = result.subjectFingerprint || result.probe || {};
        const reference = result.referenceFingerprint || result.reference || {};
        const subjectImage = imageSource(subject.originalImage || subject.image);
        const referenceImage = imageSource(reference.originalImage || reference.image);
        const pairs = result.correspondences?.available && Array.isArray(result.correspondences.pairs)
            ? result.correspondences.pairs
            : [];
        const subjectArea = { x: 20, y: 45, width: 440, height: 440 };
        const referenceArea = { x: 540, y: 45, width: 440, height: 440 };
        const pairGraphics = pairs.map((pair, index) => {
            const pairId = pair?.id ?? `pair-${index + 1}`;
            const probe = plotPoint(pair?.probe, subject, subjectArea);
            const candidate = plotPoint(pair?.reference, reference, referenceArea);
            if (!probe || !candidate) return '';
            return `<g class="fp-correspondence" data-pair-id="${escapeHtml(pairId)}">
                <line x1="${probe.x}" y1="${probe.y}" x2="${candidate.x}" y2="${candidate.y}"><title>${escapeHtml(`OpenAFIS correspondence ${pairId}`)}</title></line>
                ${marker(pair?.probe, probe, pairId, 'Subject')}
                ${marker(pair?.reference, candidate, pairId, 'Reference')}
            </g>`;
        }).join('');

        const availability = pairs.length
            ? `${pairs.length} backend-provided OpenAFIS correspondence${pairs.length === 1 ? '' : 's'} shown.`
            : 'Correspondence data is unavailable; no correspondence lines were generated.';

        return `<div class="fp-visualization" aria-label="Fingerprint correspondence visualization">
            <div class="fp-visualization-legend"><span><i class="fp-legend-circle"></i> Ridge Ending</span><span><i class="fp-legend-triangle"></i> Bifurcation</span></div>
            <svg viewBox="0 0 1000 505" role="img" aria-label="Subject and reference fingerprints with actual matched minutiae">
                <text x="240" y="24" text-anchor="middle">Subject Fingerprint</text>
                <text x="760" y="24" text-anchor="middle">Reference Fingerprint</text>
                ${subjectImage ? `<image href="${escapeHtml(subjectImage)}" x="20" y="45" width="440" height="440" preserveAspectRatio="xMidYMid meet" />` : '<text x="240" y="255" text-anchor="middle">Image unavailable</text>'}
                ${referenceImage ? `<image href="${escapeHtml(referenceImage)}" x="540" y="45" width="440" height="440" preserveAspectRatio="xMidYMid meet" />` : '<text x="760" y="255" text-anchor="middle">Image unavailable</text>'}
                ${pairGraphics}
            </svg>
            <p class="fp-visualization-note">${escapeHtml(availability)}</p>
        </div>`;
    }

    function renderMatcherRow(matcher) {
        if (!matcher) return '';
        const decision = matcherDecision(matcher);
        const percentage = matcherPercentage(matcher);
        return `<div class="fp-matcher-row">
            <strong>${escapeHtml(matcher.algorithm || 'Unavailable')}</strong>
            <span class="fp-decision fp-${decision === 'MATCH' ? 'match' : decision === 'NO MATCH' ? 'no-match' : 'review'}">${escapeHtml(decision)}</span>
            <span>${percentage === null ? 'Unavailable' : `${formatValue(percentage)}%`}</span>
        </div>`;
    }

    function renderAdvancedInfo(result) {
        const matcherCards = result.matchers.map((matcher) => {
            const minutiae = matcher.inputMinutiae || matcher.minutiaeCount || null;
            const normalizedPercentage = matcherPercentage(matcher);
            const inputFormat = matcher.inputMinutiae?.format || matcher.imageInput?.format || null;
            return `<section class="fp-technical-card">
                <h5>${escapeHtml(matcher.algorithm || 'Matcher')}</h5>
                <dl>
                    <dt>Raw Score</dt><dd>${escapeHtml(formatValue(matcher.rawScore ?? matcher.score))}</dd>
                    <dt>Match Percentage</dt><dd>${escapeHtml(normalizedPercentage === null ? 'Unavailable' : `${formatValue(normalizedPercentage)}%`)}</dd>
                    <dt>Threshold</dt><dd>${escapeHtml(formatValue(matcher.threshold))}</dd>
                    <dt>Processing Time</dt><dd>${escapeHtml(formatValue(matcher.processingTimeMs, ' ms'))}</dd>
                    <dt>Minutiae Count</dt><dd>${escapeHtml(minutiae ? safeJson(minutiae) : 'Unavailable')}</dd>
                    <dt>Template / Input Format</dt><dd>${escapeHtml(inputFormat || 'Unavailable')}</dd>
                    <dt>Normalization</dt><dd>${escapeHtml(matcher.normalization ? safeJson(matcher.normalization) : 'Unavailable')}</dd>
                </dl>
            </section>`;
        }).join('');
        const preprocessing = {
            subject: result.preprocessing?.subject,
            reference: result.preprocessing?.reference,
            subjectInput: result.subjectFingerprint?.inputMetrics ?? null,
            referenceInput: result.referenceFingerprint?.inputMetrics ?? null,
            subjectDimensions: result.subjectFingerprint ? {
                width: result.subjectFingerprint.width ?? null,
                height: result.subjectFingerprint.height ?? null
            } : null,
            referenceDimensions: result.referenceFingerprint ? {
                width: result.referenceFingerprint.width ?? null,
                height: result.referenceFingerprint.height ?? null
            } : null
        };
        const stageDefinitions = [
            ['Original', 'originalImage'],
            ['Denoised', 'denoisedImage'],
            ['Gabor Enhanced', 'gaborEnhancedImage'],
            ['Binarized', 'binarizedImage'],
            ['Zhang-Suen Thinned', 'thinnedImage'],
            ['Minutiae Detected', 'minutiaeOverlayImage']
        ];
        const renderPipeline = (fingerprint, label) => `<section class="fp-pipeline-side"><h6>${escapeHtml(label)}</h6><div class="fp-pipeline-images">${stageDefinitions.map(([stageLabel, field]) => {
            const source = imageSource(fingerprint?.[field] || (field === 'gaborEnhancedImage' ? fingerprint?.enhancedImage : ''));
            return `<figure><figcaption>${escapeHtml(stageLabel)}</figcaption>${source ? `<img src="${escapeHtml(source)}" alt="${escapeHtml(`${label} ${stageLabel}`)}">` : '<div class="fp-image-unavailable">Unavailable</div>'}</figure>`;
        }).join('')}</div></section>`;

        return `<details class="fp-advanced">
            <summary>Show Advanced Info</summary>
            <div class="fp-advanced-content">
                <section class="fp-modified-bozorth3-pipeline">
                    <h5>Modified Bozorth3 Processing Pipeline</h5>
                    <p>Modified Bozorth3 extracts candidates from denoised grayscale fingerprints with NIST MINDTCT, then validates those candidates against the adaptive Gabor, binarized, Zhang-Suen skeleton before NIST Bozorth3 matching.</p>
                    <p><strong>Base Matcher:</strong> Bozorth3</p>
                    <p aria-label="Completed Modified Bozorth3 stages">✓ Denoising · ✓ NIST MINDTCT Candidate Extraction · ✓ Gabor Ridge Enhancement · ✓ Binarization · ✓ Zhang-Suen Thinning · ✓ Zhang-Suen Skeleton Validation · ✓ Bozorth3 Matching</p>
                    ${renderPipeline(result.subjectFingerprint, 'Applicant / Subject')}
                    ${renderPipeline(result.referenceFingerprint, 'Criminal / Reference')}
                </section>
                <div class="fp-technical-grid">${matcherCards || '<p>Matcher details are unavailable.</p>'}</div>
                <h5>Preprocessing and Input Details</h5>
                <pre>${escapeHtml(safeJson(preprocessing))}</pre>
                <details class="fp-developer-diagnostics">
                    <summary>Developer Diagnostics</summary>
                    <p>Includes backend-provided paths, hashes, XYT data, commands, stdout/stderr, coordinate and angle conversions, API fields, and internal IDs where available.</p>
                    <pre>${escapeHtml(safeJson(result))}</pre>
                </details>
            </div>
        </details>`;
    }

    function renderComparisonResult(input) {
        const result = ensureComparisonResult(input);
        const primary = result.primaryMatcher;
        const supporting = MATCHER_ORDER.slice(1).map((name) => matcherByName(result, name));
        const primaryPercentage = matcherPercentage(primary);
        const subjectImage = imageSource(result.subjectFingerprint?.originalImage || result.subjectFingerprint?.image);
        const referenceImage = imageSource(result.referenceFingerprint?.originalImage || result.referenceFingerprint?.image);
        const finalDecision = result.finalResult?.decision || 'REVIEW REQUIRED';

        return `<article class="fp-result" data-comparison-id="${escapeHtml(result.comparisonId || '')}">
            <header class="fp-result-header">
                <span>Fingerprint Comparison Result</span>
                <strong>${escapeHtml(finalDecision)}</strong>
            </header>
            <div class="fp-quality">Fingerprint Quality: <strong>Subject ${escapeHtml(result.quality?.subject?.label || 'Unavailable')} · Reference ${escapeHtml(result.quality?.reference?.label || 'Unavailable')}</strong></div>
            <div class="fp-image-grid">
                <figure><figcaption>Subject Fingerprint</figcaption>${subjectImage ? `<img src="${escapeHtml(subjectImage)}" alt="Subject fingerprint">` : '<div class="fp-image-unavailable">Unavailable</div>'}</figure>
                <figure><figcaption>Reference Fingerprint</figcaption>${referenceImage ? `<img src="${escapeHtml(referenceImage)}" alt="Reference fingerprint">` : '<div class="fp-image-unavailable">Unavailable</div>'}</figure>
            </div>
            <section class="fp-primary">
                <span>Primary Matcher</span>
                <h4>Modified Bozorth3</h4>
                <div class="fp-primary-decision">${escapeHtml(matcherDecision(primary))}</div>
                <div class="fp-primary-percentage">${primaryPercentage === null ? 'Unavailable' : `${formatValue(primaryPercentage)}% Match`}</div>
            </section>
            <section class="fp-supporting">
                <h4>Supporting Matchers</h4>
                ${supporting.map((matcher, index) => matcher ? renderMatcherRow(matcher) : renderMatcherRow({ algorithm: MATCHER_ORDER[index + 1] })).join('')}
                <div class="fp-agreement">Matcher Agreement: <strong>${escapeHtml(result.matcherAgreement?.label || 'Unavailable')}</strong></div>
            </section>
            <section class="fp-final">
                <span>Final Comparison Result</span>
                <strong>${escapeHtml(finalDecision)}</strong>
                <p>Research/demo result — human review is required before interpretation.</p>
            </section>
            <details class="fp-visualization-details">
                <summary>View Fingerprint Visualization</summary>
                ${renderFingerprintVisualization(result)}
            </details>
            ${renderAdvancedInfo(result)}
        </article>`;
    }

    return {
        MATCHER_ORDER,
        buildFingerprintComparisonResult,
        ensureComparisonResult,
        formatValue,
        matcherByName,
        matcherDecision,
        matcherPercentage,
        qualityState,
        renderComparisonResult,
        renderFingerprintVisualization
    };
}));
