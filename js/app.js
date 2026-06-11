const CONFIG = {
    linesPerFile: 50000,
};

const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const splitLimitSelect = document.getElementById('split-limit');
const statusContainer = document.getElementById('status-container');
const statusMessage = document.getElementById('status-message');
const progressBar = document.getElementById('progress-bar');

let progressInterval = null;
let simulatedProgress = 0;

const syncConfigFromUI = () => {
    CONFIG.linesPerFile = parseInt(splitLimitSelect.value, 10);
};

const clearProgressSimulation = () => {
    if (progressInterval) {
        clearInterval(progressInterval);
        progressInterval = null;
    }
};

const setProgressPercent = (percent) => {
    clearProgressSimulation();
    progressBar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
};

const startProgressSimulation = () => {
    simulatedProgress = 8;
    progressBar.style.width = `${simulatedProgress}%`;

    progressInterval = setInterval(() => {
        if (simulatedProgress >= 88) return;

        const increment =
            simulatedProgress < 40 ? 4 : simulatedProgress < 70 ? 2 : 0.6;
        simulatedProgress = Math.min(88, simulatedProgress + increment);
        progressBar.style.width = `${simulatedProgress}%`;
    }, 180);
};

const updateUIStatus = (message, statusClass = '') => {
    statusContainer.classList.remove('hidden');
    statusMessage.textContent = message;

    if (statusClass === 'working' && progressInterval) {
        return;
    }

    statusMessage.classList.remove('error-text', 'success-text');
    progressBar.className = 'progress-bar-fill';
    clearProgressSimulation();

    switch (statusClass) {
        case 'working':
            startProgressSimulation();
            break;
        case 'success':
            setProgressPercent(100);
            progressBar.classList.add('success');
            statusMessage.classList.add('success-text');
            break;
        case 'error':
            setProgressPercent(100);
            progressBar.classList.add('error');
            statusMessage.classList.add('error-text');
            break;
        default:
            setProgressPercent(0);
            break;
    }
};

const INVALID_FILE_MESSAGE =
    'Please drop a valid CSV file. Folders or other formats are not supported.';

const FOLDER_BLOCK_SIZE = 4096;
const SUSPICIOUS_FOLDER_MAX_BYTES = 4096;

const resetDropZoneUI = () => {
    dropZone.classList.remove('dragover');
};

const pickFirstFile = (fileList) => {
    if (!fileList?.length) return null;

    if (fileList.length > 1) {
        console.warn(
            `[DataSplitter] ${fileList.length} files received. Processing only "${fileList[0].name}".`,
        );
    }

    return fileList[0];
};

const hasCsvExtension = (file) => file.name.toLowerCase().endsWith('.csv');

const isLikelyFolder = (file) =>
    file.size > 0 &&
    file.size % FOLDER_BLOCK_SIZE === 0 &&
    file.size <= SUSPICIOUS_FOLDER_MAX_BYTES;

const canReadFileSlice = async (file) => {
    try {
        const bytesToRead = file.size === 0 ? 0 : Math.min(file.size, 512);
        const slice = file.slice(0, bytesToRead);
        await slice.arrayBuffer();
        return true;
    } catch {
        return false;
    }
};

const validateCSVFile = async (file) => {
    if (!hasCsvExtension(file)) {
        return false;
    }

    if (isLikelyFolder(file)) {
        return false;
    }

    return canReadFileSlice(file);
};

const showInvalidFileError = () => {
    resetDropZoneUI();
    updateUIStatus(INVALID_FILE_MESSAGE, 'error');
};

const containsDroppedDirectory = (dataTransfer) => {
    const items = dataTransfer?.items;
    if (!items) {
        return false;
    }

    for (let i = 0; i < items.length; i += 1) {
        const entry = items[i].webkitGetAsEntry?.();
        if (entry?.isDirectory) {
            return true;
        }
    }

    return false;
};

const handleIncomingFiles = async (fileList) => {
    resetDropZoneUI();

    const file = pickFirstFile(fileList);
    if (!file) {
        return;
    }

    const isValid = await validateCSVFile(file);
    if (!isValid) {
        showInvalidFileError();
        return;
    }

    startCSVProcessing(file);
};

dropZone.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('click', (e) => e.stopPropagation());

fileInput.addEventListener('change', (e) => {
    handleIncomingFiles(e.target.files);
    fileInput.value = '';
});

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    resetDropZoneUI();
});

dropZone.addEventListener('dragend', () => {
    resetDropZoneUI();
});

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    resetDropZoneUI();

    if (containsDroppedDirectory(e.dataTransfer)) {
        showInvalidFileError();
        return;
    }

    handleIncomingFiles(e.dataTransfer.files);
});

const startCSVProcessing = (file) => {
    syncConfigFromUI();
    updateUIStatus(`Reading ${file.name}…`, 'working');

    const zip = new JSZip();
    const baseName = file.name.replace(/\.csv$/i, '') || 'export';

    let headerFields = null;
    let currentChunk = [];
    let chunkIndex = 1;
    let totalRows = 0;
    let filesCreated = 0;

    const flushChunk = () => {
        if (currentChunk.length === 0 || !headerFields) return;

        const paddedIndex = String(chunkIndex).padStart(3, '0');
        const csvContent = Papa.unparse({
            fields: headerFields,
            data: currentChunk,
        });

        zip.file(`${baseName}_part${paddedIndex}.csv`, csvContent);
        filesCreated += 1;
        chunkIndex += 1;
        currentChunk = [];
    };

    Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        step: (results) => {
            if (!headerFields && results.meta.fields) {
                headerFields = results.meta.fields;
            }

            const row = results.data;
            if (!row || (typeof row === 'object' && Object.keys(row).length === 0)) {
                return;
            }

            currentChunk.push(row);
            totalRows += 1;

            if (currentChunk.length >= CONFIG.linesPerFile) {
                flushChunk();
                updateUIStatus(
                    `Processed ${totalRows.toLocaleString()} rows · ${filesCreated} file(s) ready…`,
                    'working',
                );
            }
        },
        complete: async () => {
            try {
                flushChunk();

                if (totalRows === 0) {
                    resetDropZoneUI();
                    updateUIStatus('The CSV file appears to be empty.', 'error');
                    return;
                }

                updateUIStatus('Packing ZIP archive…', 'working');
                setProgressPercent(92);

                const blob = await zip.generateAsync(
                    { type: 'blob', compression: 'DEFLATE' },
                    (metadata) => {
                        setProgressPercent(92 + metadata.percent * 0.08);
                    },
                );

                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = `${baseName}_split.zip`;
                link.style.display = 'none';
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);
                URL.revokeObjectURL(url);

                const fileLabel = filesCreated === 1 ? '1 file' : `${filesCreated} files`;
                updateUIStatus(
                    `Done! ${totalRows.toLocaleString()} rows → ${fileLabel}. Download started.`,
                    'success',
                );
                
                // Trigger cross-sell modal after successful completion
                if (crossSellModal?.showCrossSellModal) {
                    crossSellModal.showCrossSellModal();
                }
            } catch (err) {
                resetDropZoneUI();
                updateUIStatus(err.message || 'Failed to create ZIP archive.', 'error');
            }
        },
        error: (err) => {
            resetDropZoneUI();
            updateUIStatus(`Parse error: ${err.message}`, 'error');
        },
    });
};

const initScrollAnimations = () => {
    const animatedElements = document.querySelectorAll('.animate-on-scroll');
    if (animatedElements.length === 0) return;

    const observerOptions = {
        root: null,
        rootMargin: '0px 0px -60px 0px',
        threshold: 0.1,
    };

    const scrollObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach((entry) => {
            if (!entry.isIntersecting) return;

            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
        });
    }, observerOptions);

    animatedElements.forEach((el) => scrollObserver.observe(el));
};

document.addEventListener('DOMContentLoaded', initScrollAnimations);

// Cross-sell Modal Logic
const CROSS_SELL_STORAGE_KEY = 'syntaxlabs_cross_sell_dismissed';
const CROSS_SELL_SHOW_DELAY = 2500; // 2.5 seconds after successful completion

const initCrossSellModal = () => {
    const modal = document.getElementById('syntaxlabs-cross-sell-modal');
    const closeButton = modal?.querySelector('.cross-sell-modal__close');
    const backdrop = modal?.querySelector('.cross-sell-modal__backdrop');

    if (!modal || !closeButton || !backdrop) return;

    const closeModal = () => {
        modal.classList.remove('cross-sell-modal--visible');
        modal.classList.add('cross-sell-modal--hidden');
        localStorage.setItem(CROSS_SELL_STORAGE_KEY, 'true');
    };

    // Close button handler
    closeButton.addEventListener('click', closeModal);

    // Backdrop click handler
    backdrop.addEventListener('click', closeModal);

    // ESC key handler
    const handleEscKey = (e) => {
        if (e.key === 'Escape' && modal.classList.contains('cross-sell-modal--visible')) {
            closeModal();
            document.removeEventListener('keydown', handleEscKey);
        }
    };

    // Show modal function
    const showCrossSellModal = () => {
        // Check if user already dismissed the modal
        if (localStorage.getItem(CROSS_SELL_STORAGE_KEY) === 'true') {
            return;
        }

        setTimeout(() => {
            modal.classList.remove('cross-sell-modal--hidden');
            modal.classList.add('cross-sell-modal--visible');
            document.addEventListener('keydown', handleEscKey);
        }, CROSS_SELL_SHOW_DELAY);
    };

    // Return the show function for external use
    return { showCrossSellModal };
};

// Initialize cross-sell modal
const crossSellModal = initCrossSellModal();
