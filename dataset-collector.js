'use strict';

(function exposeDatasetCollector(root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.DatasetCollector = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function createDatasetCollector() {
    const FINGERS = Object.freeze([
        Object.freeze({ code: 'rth', side: 'right', name: 'thumb', label: 'Right Thumb' }),
        Object.freeze({ code: 'rin', side: 'right', name: 'index', label: 'Right Index' }),
        Object.freeze({ code: 'rmi', side: 'right', name: 'middle', label: 'Right Middle' }),
        Object.freeze({ code: 'rri', side: 'right', name: 'ring', label: 'Right Ring' }),
        Object.freeze({ code: 'rpi', side: 'right', name: 'pinky', label: 'Right Pinky' }),
        Object.freeze({ code: 'lth', side: 'left', name: 'thumb', label: 'Left Thumb' }),
        Object.freeze({ code: 'lin', side: 'left', name: 'index', label: 'Left Index' }),
        Object.freeze({ code: 'lmi', side: 'left', name: 'middle', label: 'Left Middle' }),
        Object.freeze({ code: 'lri', side: 'left', name: 'ring', label: 'Left Ring' }),
        Object.freeze({ code: 'lpi', side: 'left', name: 'pinky', label: 'Left Pinky' })
    ]);

    function normalizeExtension(extension) {
        let value = String(extension || '').trim().toLowerCase().replace(/^image\//, '').replace(/^\./, '');
        if (value === 'jpeg') value = 'jpg';
        if (value === 'tiff') value = 'tif';
        return ['png', 'bmp', 'jpg', 'tif', 'wsq'].includes(value) ? value : '';
    }

    function filenameFor(mode, fingerCode, sampleNumber, extension = '') {
        const normalizedMode = String(mode || '').toLowerCase();
        if (!['applicant', 'criminal'].includes(normalizedMode)) throw new Error('Invalid dataset mode.');
        if (!FINGERS.some((finger) => finger.code === fingerCode)) throw new Error('Invalid finger code.');
        const number = Number(sampleNumber);
        if (!Number.isInteger(number) || number < 1) throw new Error('Invalid sample number.');
        const base = `${normalizedMode === 'applicant' ? 'pt' : 'c'}${fingerCode}${number}`;
        const normalizedExtension = normalizeExtension(extension);
        return normalizedExtension ? `${base}.${normalizedExtension}` : base;
    }

    function qualityState(value) {
        if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) {
            return { score: null, label: 'Unavailable', importable: false };
        }
        const score = Math.max(0, Math.min(100, Math.round(Number(value))));
        if (score >= 70) return { score, label: 'Good', importable: true };
        if (score >= 45) return { score, label: 'Acceptable', importable: true };
        return { score, label: 'Poor', importable: false };
    }

    function fingerByCode(code) {
        return FINGERS.find((finger) => finger.code === code) || FINGERS[0];
    }

    function init() {
        if (typeof document === 'undefined') return;

        const state = {
            view: 'collect',
            mode: 'applicant',
            selectedFingerCode: 'rth',
            collection: null,
            capture: null,
            busy: false,
            dataset: {
                participants: [],
                pagination: { page: 1, total: 0, total_pages: 1 },
                selected: null,
                search: ''
            }
        };
        const elements = {
            viewButtons: [...document.querySelectorAll('[data-workspace-view]')],
            modeButtons: [...document.querySelectorAll('[data-dataset-mode]')],
            collectionView: document.getElementById('collectionView'),
            datasetView: document.getElementById('datasetView'),
            datasetSearch: document.getElementById('datasetSearch'),
            datasetSearchButton: document.getElementById('datasetSearchButton'),
            datasetParticipantList: document.getElementById('datasetParticipantList'),
            datasetParticipantDetail: document.getElementById('datasetParticipantDetail'),
            datasetListSummary: document.getElementById('datasetListSummary'),
            datasetPreviousPage: document.getElementById('datasetPreviousPage'),
            datasetNextPage: document.getElementById('datasetNextPage'),
            datasetPageLabel: document.getElementById('datasetPageLabel'),
            fingerSelector: document.getElementById('fingerSelector'),
            selectedFinger: document.getElementById('selectedFinger'),
            generatedFilename: document.getElementById('generatedFilename'),
            participantLabel: document.getElementById('participantLabel'),
            participantMeta: document.getElementById('participantMeta'),
            consentPanel: document.getElementById('consentPanel'),
            consentCheckbox: document.getElementById('consentCheckbox'),
            newParticipantButton: document.getElementById('newParticipantButton'),
            scanButton: document.getElementById('scanButton'),
            captureAnotherButton: document.getElementById('captureAnotherButton'),
            importButton: document.getElementById('importButton'),
            previewPanel: document.getElementById('previewPanel'),
            previewImage: document.getElementById('previewImage'),
            qualityValue: document.getElementById('qualityValue'),
            qualityNotice: document.getElementById('qualityNotice'),
            entryPreview: document.getElementById('entryPreview'),
            progress: document.getElementById('collectionProgress'),
            progressCount: document.getElementById('progressCount'),
            status: document.getElementById('collectorStatus'),
            userLabel: document.getElementById('collectorUser')
        };

        function setStatus(message, type = 'info') {
            elements.status.textContent = message || '';
            elements.status.className = `status-message ${type}`;
            elements.status.hidden = !message;
        }

        function setBusy(busy) {
            state.busy = busy;
            elements.viewButtons.forEach((button) => { button.disabled = busy; });
            elements.modeButtons.forEach((button) => { button.disabled = busy; });
            elements.newParticipantButton.disabled = busy;
            elements.scanButton.disabled = busy || !state.collection?.participant;
            renderCapture();
            renderDatasetBrowser();
        }

        function imageSource(image, format = 'png') {
            const value = String(image || '').trim();
            if (!value) return '';
            if (/^data:image\//i.test(value)) return value;
            return `data:image/${normalizeExtension(format) || 'png'};base64,${value}`;
        }

        function escapeHtml(value) {
            return String(value ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#039;');
        }

        function selectedFinger() {
            return fingerByCode(state.selectedFingerCode);
        }

        function renderFingerSelector() {
            elements.fingerSelector.innerHTML = ['right', 'left'].map((side) => `
                <fieldset class="hand-group">
                    <legend>${side === 'right' ? 'Right Hand' : 'Left Hand'}</legend>
                    <div class="finger-grid">
                        ${FINGERS.filter((finger) => finger.side === side).map((finger) => `
                            <button type="button" class="finger-button${finger.code === state.selectedFingerCode ? ' selected' : ''}" data-finger-code="${finger.code}" aria-pressed="${finger.code === state.selectedFingerCode}">
                                <span>${finger.name[0].toUpperCase()}${finger.name.slice(1)}</span>
                                <small>${finger.code}</small>
                            </button>
                        `).join('')}
                    </div>
                </fieldset>
            `).join('');
            elements.fingerSelector.querySelectorAll('[data-finger-code]').forEach((button) => {
                button.addEventListener('click', async () => {
                    state.selectedFingerCode = button.dataset.fingerCode;
                    state.capture = null;
                    renderFingerSelector();
                    renderCapture();
                    await loadCollectionState();
                });
            });
        }

        function samplesFor(code) {
            return (state.collection?.samples || []).filter((sample) => sample.finger_code === code);
        }

        function renderProgress() {
            const collected = new Set(state.collection?.collected_finger_codes || []);
            elements.progress.innerHTML = ['right', 'left'].map((side) => `
                <section class="progress-hand">
                    <h3>${side === 'right' ? 'Right Hand' : 'Left Hand'}</h3>
                    ${FINGERS.filter((finger) => finger.side === side).map((finger) => {
                        const samples = samplesFor(finger.code);
                        return `<div class="progress-row">
                            <span class="progress-mark ${collected.has(finger.code) ? 'complete' : ''}">${collected.has(finger.code) ? '✓' : '○'}</span>
                            <span>${finger.name[0].toUpperCase()}${finger.name.slice(1)}</span>
                            <small>${samples.length ? samples.map((sample) => sample.filename).join(', ') : 'No samples'}</small>
                        </div>`;
                    }).join('')}
                </section>
            `).join('');
            elements.progressCount.textContent = `${state.collection?.collected_finger_count || 0} / 10 fingers collected`;
        }

        function renderParticipant() {
            const participant = state.collection?.participant;
            elements.consentPanel.hidden = state.mode !== 'applicant';
            if (!participant) {
                elements.participantLabel.textContent = state.mode === 'applicant' ? 'No active participant' : 'No active synthetic record';
                elements.participantMeta.textContent = state.mode === 'applicant'
                    ? 'Confirm research consent, then start a participant.'
                    : 'Start a synthetic reference participant. The first number will be after the existing database maximum and at least 301.';
                elements.newParticipantButton.textContent = 'Start Participant';
            } else {
                elements.participantLabel.textContent = participant.display_name;
                elements.participantMeta.textContent = state.mode === 'criminal'
                    ? (participant.criminal_record_id
                        ? `Operational criminal record #${participant.criminal_record_id} · Synthetic profile · Age ${participant.age}`
                        : `Synthetic profile · database link pending · Age ${participant.age}`)
                    : `Consented research participant #${participant.participant_number}`;
                elements.newParticipantButton.textContent = 'New Participant';
            }
            elements.scanButton.disabled = state.busy || !participant;
        }

        function renderSelection() {
            const finger = selectedFinger();
            elements.selectedFinger.textContent = finger.label;
            const fallbackNumber = Number(state.collection?.next_sample_number) || 1;
            elements.generatedFilename.textContent = state.collection?.next_filename
                || filenameFor(state.mode, finger.code, fallbackNumber, 'png');
        }

        function renderCapture() {
            const capture = state.capture;
            elements.previewPanel.hidden = !capture;
            elements.captureAnotherButton.hidden = !capture;
            if (!capture) {
                elements.entryPreview.innerHTML = '<p class="empty-state">Scan the selected finger to prepare a dataset entry.</p>';
                elements.importButton.disabled = true;
                elements.importButton.textContent = 'Import to Database';
                return;
            }

            elements.previewImage.src = imageSource(capture.originalImage, capture.imageFormat);
            elements.previewImage.alt = `${selectedFinger().label} original fingerprint capture`;
            elements.qualityValue.textContent = capture.quality.label === 'Unavailable'
                ? 'Unavailable'
                : `${capture.quality.label} (${capture.quality.score}/100)`;
            elements.qualityValue.className = `quality-value quality-${capture.quality.label.toLowerCase()}`;
            elements.qualityNotice.textContent = capture.quality.importable
                ? 'Original scanner image is ready for import.'
                : 'Fingerprint quality is too low. Please scan again.';

            const participant = state.collection?.participant;
            elements.entryPreview.innerHTML = `
                <dl class="entry-grid">
                    <div><dt>Dataset Type</dt><dd>${state.mode === 'applicant' ? 'Applicant' : 'Criminal / Reference (Synthetic)'}</dd></div>
                    <div><dt>${state.mode === 'applicant' ? 'Participant' : 'Synthetic Profile'}</dt><dd>${participant?.display_name || 'Not selected'}</dd></div>
                    ${state.mode === 'criminal' ? `<div><dt>Age</dt><dd>${participant?.age ?? 'Unavailable'}</dd></div>` : ''}
                    <div><dt>Finger</dt><dd>${selectedFinger().label}</dd></div>
                    <div><dt>Filename</dt><dd>${capture.filename || state.collection?.next_filename || '-'}</dd></div>
                    <div><dt>Quality</dt><dd>${capture.quality.label}</dd></div>
                </dl>`;
            elements.importButton.disabled = state.busy || !capture.quality.importable || capture.saved || !participant;
            elements.importButton.textContent = capture.saved ? 'Imported' : (state.mode === 'applicant'
                ? 'Import Applicant Fingerprint to Database'
                : 'Import Criminal Fingerprint to Database');
        }

        function renderAll() {
            elements.viewButtons.forEach((button) => {
                const selected = button.dataset.workspaceView === state.view;
                button.classList.toggle('selected', selected);
                button.setAttribute('aria-pressed', String(selected));
            });
            elements.collectionView.hidden = state.view !== 'collect';
            elements.datasetView.hidden = state.view !== 'browse';
            elements.modeButtons.forEach((button) => {
                const selected = button.dataset.datasetMode === state.mode;
                button.classList.toggle('selected', selected);
                button.setAttribute('aria-pressed', String(selected));
            });
            renderFingerSelector();
            renderParticipant();
            renderSelection();
            renderProgress();
            renderCapture();
            renderDatasetBrowser();
        }

        function renderDatasetBrowser() {
            const participants = state.dataset.participants || [];
            const pagination = state.dataset.pagination || { page: 1, total: 0, total_pages: 1 };
            const typeLabel = state.mode === 'applicant' ? 'applicant' : 'criminal';
            elements.datasetListSummary.textContent = `${pagination.total || 0} imported ${typeLabel} participant${Number(pagination.total) === 1 ? '' : 's'}`;
            elements.datasetPageLabel.textContent = `Page ${pagination.page || 1} of ${pagination.total_pages || 1}`;
            elements.datasetPreviousPage.disabled = state.busy || Number(pagination.page) <= 1;
            elements.datasetNextPage.disabled = state.busy || Number(pagination.page) >= Number(pagination.total_pages);

            if (!participants.length) {
                elements.datasetParticipantList.innerHTML = '<p class="empty-state">No imported participants found for this dataset.</p>';
            } else {
                elements.datasetParticipantList.innerHTML = participants.map((participant) => {
                    const selected = Number(state.dataset.selected?.participant?.id) === Number(participant.id);
                    const identity = state.mode === 'criminal'
                        ? (participant.case_number || `Record #${participant.criminal_record_id || participant.participant_number}`)
                        : `Participant #${participant.participant_number}`;
                    return `<button type="button" class="dataset-person${selected ? ' selected' : ''}" data-dataset-participant-id="${Number(participant.id)}">
                        <strong>${escapeHtml(participant.display_name)}</strong>
                        <span>${escapeHtml(identity)} · ${Number(participant.collected_finger_count) || 0}/10 fingers · ${Number(participant.sample_count) || 0} samples</span>
                    </button>`;
                }).join('');
                elements.datasetParticipantList.querySelectorAll('[data-dataset-participant-id]').forEach((button) => {
                    button.addEventListener('click', () => loadDatasetParticipant(Number(button.dataset.datasetParticipantId)));
                });
            }

            const detail = state.dataset.selected;
            if (!detail?.participant) {
                elements.datasetParticipantDetail.innerHTML = '<p class="empty-state">Select an imported participant to view their dataset samples.</p>';
                return;
            }

            const participant = detail.participant;
            const samples = detail.samples || [];
            const distinctFingers = new Set(samples.map((sample) => sample.finger_code)).size;
            const sexLabel = participant.sex === 'M' ? 'Male' : 'Female';
            const identifier = state.mode === 'criminal'
                ? (participant.case_number || `Record #${participant.criminal_record_id || participant.participant_number}`)
                : `Research participant #${participant.participant_number}`;
            elements.datasetParticipantDetail.innerHTML = `
                <div class="dataset-detail-head">
                    <div><span class="step-label">Participant Dataset</span><h2>${escapeHtml(participant.display_name)}</h2><p>${escapeHtml(identifier)}</p></div>
                    <span class="status-pill">${escapeHtml(participant.status)}</span>
                </div>
                <div class="dataset-facts">
                    <div class="dataset-fact"><span>Fingers</span><strong>${distinctFingers} / 10</strong></div>
                    <div class="dataset-fact"><span>Samples</span><strong>${samples.length}</strong></div>
                    <div class="dataset-fact"><span>${state.mode === 'criminal' ? 'Age' : 'Consent'}</span><strong>${state.mode === 'criminal' ? escapeHtml(participant.age ?? '—') : (Number(participant.consent_given) === 1 ? 'Confirmed' : 'Not recorded')}</strong></div>
                    ${state.mode === 'criminal' ? `<div class="dataset-fact"><span>Sex</span><strong>${sexLabel}</strong></div>` : ''}
                    <div class="dataset-fact"><span>Imported</span><strong>${escapeHtml(participant.created_at || '—')}</strong></div>
                </div>
                <h3>Fingerprint Samples</h3>
                <div class="sample-gallery">
                    ${samples.length ? samples.map((sample) => {
                        const finger = fingerByCode(sample.finger_code);
                        const source = imageSource(sample.original_image, sample.image_format);
                        return `<article class="sample-card">
                            <div class="sample-thumb">${source ? `<img src="${source}" alt="${escapeHtml(finger.label)} fingerprint sample">` : '<span class="empty-state">Image unavailable</span>'}</div>
                            <div class="sample-info"><strong>${escapeHtml(sample.filename)}</strong><span>${escapeHtml(finger.label)} · ${escapeHtml(sample.quality_label)} (${Number(sample.quality_score) || 0}/100)</span><span>${escapeHtml(sample.captured_at || sample.created_at || '')}</span></div>
                        </article>`;
                    }).join('') : '<p class="empty-state">No fingerprint samples have been imported for this participant.</p>'}
                </div>`;
        }

        async function readJson(response) {
            try {
                return await response.json();
            } catch (_) {
                return {};
            }
        }

        async function loadCollectionState(participantId = null) {
            const params = new URLSearchParams({
                action: 'state',
                mode: state.mode,
                finger_code: state.selectedFingerCode,
                image_format: state.capture?.imageFormat || 'png'
            });
            if (participantId) params.set('participant_id', participantId);
            const response = await fetch(`backend/dataset_collection.php?${params.toString()}`, { cache: 'no-store' });
            const data = await readJson(response);
            if (!response.ok || !data.success) throw new Error(data.error || 'Unable to load dataset collection state.');
            state.collection = data;
            renderAll();
        }

        async function loadDatasetParticipants(page = 1) {
            const params = new URLSearchParams({
                mode: state.mode,
                page: String(page),
                page_size: '40',
                search: state.dataset.search
            });
            const response = await fetch(`backend/dataset_collection.php?action=list&${params.toString()}`, { cache: 'no-store' });
            const data = await readJson(response);
            if (!response.ok || !data.success) throw new Error(data.error || 'Unable to load imported dataset participants.');
            state.dataset.participants = data.participants || [];
            state.dataset.pagination = data.pagination || { page: 1, total: 0, total_pages: 1 };
            state.dataset.selected = null;
            renderDatasetBrowser();
            if (state.dataset.participants.length) {
                await loadDatasetParticipant(Number(state.dataset.participants[0].id));
            }
        }

        async function loadDatasetParticipant(participantId) {
            const params = new URLSearchParams({
                mode: state.mode,
                participant_id: String(participantId)
            });
            const response = await fetch(`backend/dataset_collection.php?action=participant&${params.toString()}`, { cache: 'no-store' });
            const data = await readJson(response);
            if (!response.ok || !data.success) throw new Error(data.error || 'Unable to load the participant dataset.');
            state.dataset.selected = data;
            renderDatasetBrowser();
        }

        async function createParticipant() {
            if (state.mode === 'applicant' && !elements.consentCheckbox.checked) {
                setStatus('Explicit research consent is required before starting an applicant participant.', 'error');
                return;
            }
            if (state.collection?.participant && !window.confirm(`Finish ${state.collection.participant.display_name} and start a new participant?`)) return;
            setBusy(true);
            setStatus('Preparing the next dataset participant…', 'info');
            try {
                const response = await fetch('backend/dataset_collection.php?action=new_participant', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ mode: state.mode, consent_given: state.mode === 'applicant' && elements.consentCheckbox.checked })
                });
                const data = await readJson(response);
                if (!response.ok || !data.success) throw new Error(data.error || 'Unable to create the participant.');
                state.capture = null;
                elements.consentCheckbox.checked = false;
                await loadCollectionState(data.participant.id);
                setStatus(`${data.participant.display_name} is ready for collection.`, 'success');
            } catch (error) {
                setStatus(error.message, 'error');
            } finally {
                setBusy(false);
            }
        }

        async function scanFingerprint() {
            if (!state.collection?.participant) {
                setStatus('Start a participant before scanning.', 'error');
                return;
            }
            setBusy(true);
            setStatus(`Place the ${selectedFinger().label.toLowerCase()} on the ZKTeco ZK9500 scanner.`, 'info');
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 55000);
            try {
                const response = await fetch('http://localhost:9000/scan', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type: state.mode === 'criminal' ? 'criminal' : 'applicant' }),
                    signal: controller.signal
                });
                const data = await readJson(response);
                if (!response.ok || !data.success) throw new Error(data.error || 'Fingerprint scan failed.');
                if (data.scanned !== true) throw new Error('Only a real ZKTeco scanner capture can be imported into the research dataset.');
                const quality = qualityState(data.afisQuality ?? data.quality);
                state.capture = {
                    templateBase64: data.templateBase64 || data.template || '',
                    originalImage: data.originalImage || data.image || '',
                    imageFormat: normalizeExtension(data.imageFormat) || 'png',
                    templateFormat: data.format || 'ISO',
                    scannerSource: data.source || 'ZKTeco ZK9500 optical scanner',
                    capturedAt: data.timestamp || new Date().toISOString(),
                    quality,
                    saved: false
                };
                await loadCollectionState(state.collection.participant.id);
                setStatus(quality.importable ? 'Fingerprint captured. Review the entry before importing.' : 'Fingerprint quality is too low. Please scan again.', quality.importable ? 'success' : 'error');
            } catch (error) {
                state.capture = null;
                renderCapture();
                setStatus(error.name === 'AbortError' ? 'Scanner timed out. Lift your finger and try again.' : error.message, 'error');
            } finally {
                clearTimeout(timeout);
                setBusy(false);
            }
        }

        async function importCapture() {
            const capture = state.capture;
            const participant = state.collection?.participant;
            if (!capture || !capture.quality.importable || !participant) return;
            setBusy(true);
            setStatus('Importing the original fingerprint capture…', 'info');
            try {
                const response = await fetch('backend/dataset_collection.php?action=import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        mode: state.mode,
                        participant_id: participant.id,
                        finger_code: state.selectedFingerCode,
                        scanner_capture: true,
                        template_base64: capture.templateBase64,
                        template_format: capture.templateFormat,
                        original_image: capture.originalImage,
                        image_format: capture.imageFormat,
                        quality_score: capture.quality.score,
                        scanner_source: capture.scannerSource,
                        captured_at: capture.capturedAt
                    })
                });
                const data = await readJson(response);
                if (!response.ok || !data.success) throw new Error(data.error || 'Fingerprint import failed.');
                capture.filename = data.sample.filename;
                capture.saved = true;
                state.collection = data.state;
                renderAll();
                setStatus(`${data.sample.filename} was imported without replacing any earlier sample.`, 'success');
            } catch (error) {
                setStatus(error.message, 'error');
            } finally {
                setBusy(false);
            }
        }

        async function checkSession() {
            const response = await fetch('backend/auth.php?action=session', { cache: 'no-store' });
            const data = await readJson(response);
            if (!response.ok || !data.authenticated || !['admin', 'super_admin'].includes(data.user?.role)) {
                window.location.replace('login.html?redirect=dataset-collector.html');
                return false;
            }
            elements.userLabel.textContent = data.user.full_name || data.user.username;
            return true;
        }

        elements.viewButtons.forEach((button) => {
            button.addEventListener('click', async () => {
                const nextView = button.dataset.workspaceView;
                if (state.busy || state.view === nextView) return;
                state.view = nextView;
                setStatus('', 'info');
                renderAll();
                if (state.view === 'browse') {
                    setBusy(true);
                    try {
                        await loadDatasetParticipants(1);
                    } catch (error) {
                        setStatus(error.message, 'error');
                    } finally {
                        setBusy(false);
                    }
                }
            });
        });
        elements.modeButtons.forEach((button) => {
            button.addEventListener('click', async () => {
                if (state.busy || state.mode === button.dataset.datasetMode) return;
                state.mode = button.dataset.datasetMode;
                state.capture = null;
                state.dataset.selected = null;
                state.dataset.participants = [];
                state.dataset.pagination = { page: 1, total: 0, total_pages: 1 };
                setStatus('', 'info');
                try {
                    if (state.view === 'browse') await loadDatasetParticipants(1);
                    else await loadCollectionState();
                } catch (error) {
                    setStatus(error.message, 'error');
                }
            });
        });
        elements.newParticipantButton.addEventListener('click', createParticipant);
        elements.scanButton.addEventListener('click', scanFingerprint);
        elements.importButton.addEventListener('click', importCapture);
        elements.captureAnotherButton.addEventListener('click', () => {
            state.capture = null;
            renderCapture();
            setStatus('Ready to capture another sample of the selected finger.', 'info');
        });
        elements.datasetSearchButton.addEventListener('click', async () => {
            state.dataset.search = elements.datasetSearch.value.trim();
            try {
                await loadDatasetParticipants(1);
            } catch (error) {
                setStatus(error.message, 'error');
            }
        });
        elements.datasetSearch.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                elements.datasetSearchButton.click();
            }
        });
        elements.datasetPreviousPage.addEventListener('click', async () => {
            const page = Math.max(1, Number(state.dataset.pagination.page) - 1);
            try {
                await loadDatasetParticipants(page);
            } catch (error) {
                setStatus(error.message, 'error');
            }
        });
        elements.datasetNextPage.addEventListener('click', async () => {
            const page = Math.min(Number(state.dataset.pagination.total_pages) || 1, Number(state.dataset.pagination.page) + 1);
            try {
                await loadDatasetParticipants(page);
            } catch (error) {
                setStatus(error.message, 'error');
            }
        });

        (async () => {
            try {
                if (await checkSession()) await loadCollectionState();
            } catch (error) {
                setStatus(error.message, 'error');
            }
        })();
    }

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
        else init();
    }

    return { FINGERS, filenameFor, qualityState, normalizeExtension, init };
}));
