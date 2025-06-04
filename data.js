// --- DATA PROCESSING, IMPORT/EXPORT, SEARCH & FILTER ---

function normalizeAbbreviation(abbr, unmapped) {
    if (!abbr) return '';
    if (state.customAbbreviationMappings && state.customAbbreviationMappings[abbr]) {
        return state.customAbbreviationMappings[abbr];
    }
    if (abbreviationMap[abbr]) {
        return abbreviationMap[abbr];
    }
    if (abbr.length > 0 && !/^\s*$/.test(abbr)) {
        unmapped[abbr] = (unmapped[abbr] || 0) + 1;
    }
    return abbr;
}

function generateTags(roomType, department) {
    const tags = new Set();
    tagRules.forEach(rule => {
        if (rule.pattern.test(roomType) || rule.pattern.test(department || '')) {
            tags.add(rule.tag);
        }
    });
    return Array.from(tags);
}

async function parseFile(file) {
    const fileType = file.name.split('.').pop().toLowerCase();
    updateLoadingStatus(`Parsing ${file.name}...`);
    if (fileType === 'csv') {
        const text = await file.text();
        return Papa.parse(text, { header: true, skipEmptyLines: true, dynamicTyping: true }).data;
    } else if (['xlsx', 'xls'].includes(fileType)) {
        const ab = await file.arrayBuffer();
        const wb = XLSX.read(ab);
        return XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    }
    throw new Error('Unsupported file type for parsing.');
}

async function processRoomData(data) {
    updateLoadingStatus('Processing room data...');
    const processed = [];
    const unmapped = {};
    const buildings = new Set();
    const floors = new Set();
    const tags = new Set();
    let uniqueIdCounter = state.processedData.length;

    data.forEach((row) => {
        if (!row.rmnbr || typeof row.floor === 'undefined' || row.floor === null) {
             console.warn('Skipping row due to missing rmnbr or floor:', row);
             return;
        }

        const building = row.bld_descrshort || 'Unknown Building';
        buildings.add(building);

        const type = normalizeAbbreviation(row.rmtyp_descrshort, unmapped);
        const sub = normalizeAbbreviation(row.rmsubtyp_descrshort, unmapped);
        let full = type;
        if (sub && type !== sub) {
            full = `${type} - ${sub}`;
        }
        if (fullReplacements[`${type} ${sub}`.trim()]) {
            full = fullReplacements[`${type} ${sub}`.trim()];
        } else if (type === sub) {
            full = type;
        }

        const rowTags = generateTags(full, row.dept_descr);
        rowTags.forEach(t => tags.add(t));
        floors.add(row.floor.toString());

        processed.push({
            ...row,
            id: uniqueIdCounter++,
            typeFull: full,
            tags: rowTags,
            mgisLink: generateMgisLink(row),
            building: building
        });
    });

    const buildingsArray = Array.from(buildings);
    buildingsArray.forEach((b, index) => {
        if (!state.buildingColors[b]) {
            state.buildingColors[b] = assignBuildingColor(b, Object.keys(state.buildingColors).length); // Direct call to ui.js function
        }
    });

    state.processedData = state.processedData.concat(processed);
    state.unmappedAbbreviations = { ...state.unmappedAbbreviations, ...unmapped };

    state.availableBuildings = [...new Set([...state.availableBuildings, ...buildingsArray])].sort();
    state.availableFloors = [...new Set([...state.availableFloors, ...Array.from(floors)])].sort((a, b) => Number(a) - Number(b));
    state.availableTags = [...new Set([...state.availableTags, ...Array.from(tags)])].sort();
    state.currentPage = 1;

    updateLoadingStatus('Creating search index...');
    await createSearchIndex();
}

async function processOccupantData(data) {
    updateLoadingStatus('Processing occupant data...');
    data.forEach(occ => {
        if (!occ.rmrecnbr || !occ.person_name) return;
        const room = state.processedData.find(r => String(r.rmrecnbr) === String(occ.rmrecnbr));
        if (room) {
            if (!state.staffTags[room.id]) {
                state.staffTags[room.id] = [];
            }
            const staffTag = `Staff: ${occ.person_name.trim()}`;
            if (!state.staffTags[room.id].includes(staffTag)) {
                state.staffTags[room.id].push(staffTag);
            }
        }
    });
    state.currentPage = 1;
    await createSearchIndex();
}

async function processRoomDataFiles(files) {
    let allRoomData = [];
    for (const file of files) {
        try {
            const data = await parseFile(file);
            allRoomData = allRoomData.concat(data);
            state.loadedFiles.push({ name: file.name, type: 'room', rows: data.length, status: 'processed' });
        } catch (e) {
            addError(`Room Data Error (${file.name}): ${e.message}`);
            state.loadedFiles.push({ name: file.name, type: 'room', status: 'error', message: e.message });
        }
    }
    if (allRoomData.length > 0) {
        await processRoomData(allRoomData);
    }
}

async function processOccupantDataFiles(files) {
    let allOccupantData = [];
    for (const file of files) {
        try {
            const data = await parseFile(file);
            allOccupantData = allOccupantData.concat(data);
            state.loadedFiles.push({ name: file.name, type: 'occupant', rows: data.length, status: 'processed' });
        } catch (e) {
            addError(`Occupant Data Error (${file.name}): ${e.message}`);
            state.loadedFiles.push({ name: file.name, type: 'occupant', status: 'error', message: e.message });
        }
    }
    if (allOccupantData.length > 0) {
        await processOccupantData(allOccupantData);
    }
}

async function handleFiles(files) {
    showLoading(true);
    setProcessingState(true, elements.processingIndicator);
    clearErrors();
    let roomDataFiles = [], occupantDataFiles = [], tagFiles = [], sessionFiles = [];

    for (const file of files) {
        const fileType = file.name.split('.').pop().toLowerCase();
        if (fileType === 'json') {
            tagFiles.push(file);
        } else if (fileType === 'umsess') {
            sessionFiles.push(file);
        } else if (['xlsx', 'xls', 'csv'].includes(fileType)) {
            if (file.name.toLowerCase().includes('occupant') || file.name.toLowerCase().includes('staff')) {
                occupantDataFiles.push(file);
            } else {
                roomDataFiles.push(file);
            }
        } else {
            addError(`Unsupported file type: ${file.name}`);
            state.loadedFiles.push({ name: file.name, type: 'unsupported', status: 'error', message: 'Unsupported type' });
        }
    }

    if (sessionFiles.length > 0) {
        for (const sessionFile of sessionFiles) {
            await importSession(sessionFile);
        }
    }
    if (roomDataFiles.length > 0) {
        await processRoomDataFiles(roomDataFiles);
    }
    if (occupantDataFiles.length > 0) {
        await processOccupantDataFiles(occupantDataFiles);
    }
    for (const tagFile of tagFiles) {
        await importCustomTags(tagFile);
    }

    updateFilesListUI(); // Direct call to ui.js function
    updateDataSummary(); // Direct call to ui.js function
    await updateUI();      // Direct call to ui.js function

    if(state.processedData.length > 0) {
        enableDependentFeatures(); // Direct call to ui.js function
        updateUploadAreaState(); // Direct call to ui.js function
    }

    if (state.processedData.length > 0 || Object.keys(state.customTags).length > 0) {
        showSecurityReminder(); // Direct call to app.js function (made global)
    }

    showLoading(false);
    setProcessingState(false, elements.processingIndicator);
}

function exportCustomTags() {
    if (Object.keys(state.customTags).length === 0) {
        addError("No custom tags to export.");
        return;
    }
    const exportData = {
        version: "1.2",
        timestamp: new Date().toISOString(),
        customTags: {},
        roomReference: {}
    };

    Object.keys(state.customTags).forEach(roomId => {
        const room = state.processedData.find(r => r.id.toString() === roomId.toString());
        if (room && state.customTags[roomId] && state.customTags[roomId].length > 0) {
            exportData.customTags[roomId] = state.customTags[roomId];
            exportData.roomReference[roomId] = {
                rmnbr: room.rmnbr,
                typeFull: room.typeFull,
                rmrecnbr: room.rmrecnbr,
                building: room.bld_descrshort
            };
        }
    });

    if (Object.keys(exportData.customTags).length === 0) {
        addError("No valid custom tags found on currently loaded rooms to export.");
        return;
    }
    downloadFile(JSON.stringify(exportData, null, 2), `custom_tags_${new Date().toISOString().split('T')[0]}.json`, 'application/json');
}

async function importCustomTags(file) {
    showLoading(true);
    setProcessingState(true, elements.processingIndicator);
    clearErrors();
    try {
        const text = await file.text();
        const importData = JSON.parse(text);
        if (!importData.customTags) throw new Error("Invalid tags file: missing customTags data.");

        let importedCount = 0;
        let skippedCount = 0;

        Object.keys(importData.customTags).forEach(roomIdFromFile => {
            const tagsToImport = importData.customTags[roomIdFromFile];
            if (!Array.isArray(tagsToImport) || tagsToImport.length === 0) return;

            let targetRoom = null;
            const roomRef = importData.roomReference ? importData.roomReference[roomIdFromFile] : null;

            if (roomRef && roomRef.rmrecnbr) targetRoom = state.processedData.find(r => String(r.rmrecnbr) === String(roomRef.rmrecnbr));
            if (!targetRoom) targetRoom = state.processedData.find(r => r.id.toString() === roomIdFromFile.toString());
            if (!targetRoom && roomRef && roomRef.rmnbr && roomRef.building) targetRoom = state.processedData.find(r => r.rmnbr === roomRef.rmnbr && (r.bld_descrshort === roomRef.building || r.building === roomRef.building));
            if (!targetRoom && roomRef && roomRef.rmnbr) targetRoom = state.processedData.find(r => r.rmnbr === roomRef.rmnbr);

            if (targetRoom) {
                if (!state.customTags[targetRoom.id]) state.customTags[targetRoom.id] = [];
                tagsToImport.forEach(tagFromFile => {
                    let richTagObject = (typeof tagFromFile === 'string') ?
                        createRichTag(tagFromFile, 'simple', '', '', '', '', 'blue') :
                        createRichTag(tagFromFile.name, tagFromFile.type, tagFromFile.description, tagFromFile.link, tagFromFile.contact, tagFromFile.imageUrl, tagFromFile.color);
                    if (!state.customTags[targetRoom.id].some(existingTag => existingTag.name === richTagObject.name)) {
                        state.customTags[targetRoom.id].push(richTagObject);
                        importedCount++;
                    }
                });
            } else {
                skippedCount++;
            }
        });
        if (importedCount > 0) console.log(`✅ Imported/Updated ${importedCount} custom tags. Skipped ${skippedCount}.`);
        else addError("No new tags imported/updated.");
        await createSearchIndex();
    } catch (e) {
        addError(`Tags Import Error: ${e.message}`);
        console.error(e);
    } finally {
        showLoading(false);
        setProcessingState(false, elements.processingIndicator);
    }
}

function exportSession() {
    if (state.processedData.length === 0 && Object.keys(state.customTags).length === 0) {
        addError("No session data to export.");
        return;
    }
    const sessionData = {
        version: "1.1", timestamp: new Date().toISOString(), type: "um_session",
        data: {
            processedData: state.processedData, customTags: state.customTags, staffTags: state.staffTags,
            buildingColors: state.buildingColors, activeFilters: state.activeFilters,
            searchQuery: state.searchQuery, currentViewMode: state.currentViewMode, resultsPerPage: state.resultsPerPage
        }
    };
    try {
        const jsonString = JSON.stringify(sessionData);
        const compressedData = btoa(unescape(encodeURIComponent(jsonString)));
        downloadFile(compressedData, `hospital_directory_session_${new Date().toISOString().split('T')[0]}.umsess`, 'application/octet-stream');
        console.log(`📦 Session exported.`);
    } catch (error) {
        addError("Error preparing session data for export: " + error.message);
        console.error("Session export error:", error);
    }
}

async function importSession(file) {
    showLoading(true);
    setProcessingState(true, elements.processingIndicator);
    clearErrors();
    try {
        const compressedData = await file.text();
        const jsonString = decodeURIComponent(escape(atob(compressedData)));
        const sessionData = JSON.parse(jsonString);
        if (!sessionData.type || sessionData.type !== "um_session") throw new Error("Invalid session file format.");

        state.processedData = sessionData.data.processedData || [];
        state.customTags = sessionData.data.customTags || {};
        state.staffTags = sessionData.data.staffTags || {};
        state.buildingColors = sessionData.data.buildingColors || {};
        state.activeFilters = sessionData.data.activeFilters || { building: '', floor: '', tags: [] };
        state.searchQuery = sessionData.data.searchQuery || '';
        state.currentViewMode = sessionData.data.currentViewMode || 'desktop';
        state.resultsPerPage = sessionData.data.resultsPerPage || 10;
        state.currentPage = 1;

        state.availableBuildings = [...new Set(state.processedData.map(r => r.building || r.bld_descrshort || 'Unknown'))].sort();
        state.availableFloors = [...new Set(state.processedData.map(r => (r.floor !== null && typeof r.floor !== 'undefined') ? r.floor.toString() : 'N/A'))].sort((a, b) => (a === 'N/A') ? 1 : (b === 'N/A') ? -1 : Number(a) - Number(b));
        state.availableTags = [...new Set(state.processedData.flatMap(r => r.tags || []))].sort();

        if (elements.searchInput) elements.searchInput.value = state.searchQuery;
        if (elements.searchInputMobile) elements.searchInputMobile.value = state.searchQuery;

        state.loadedFiles.push({ name: file.name, type: 'session', status: 'processed' });
        await createSearchIndex();
        console.log(`✅ Session restored.`);
        addError(`Session '${file.name}' loaded successfully.`);
    } catch (e) {
        addError(`Session Import Error (${file.name}): ${e.message}`);
        console.error(e);
    } finally {
        showLoading(false);
        setProcessingState(false, elements.processingIndicator);
    }
}

// --- UNIFIED SEARCH ARCHITECTURE ---

// Create unified tag structure for each room
function createUnifiedTags(room) {
    const tags = [];
    
    // Building tags
    if (room.building) {
        tags.push(room.building.toLowerCase());
        tags.push(`building:${room.building.toLowerCase()}`);
        // Add individual words from building name
        room.building.toLowerCase().split(/\s+/).forEach(word => {
            if (word.length > 1) tags.push(word);
        });
    }
    if (room.bld_descrshort && room.bld_descrshort !== room.building) {
        tags.push(room.bld_descrshort.toLowerCase());
        tags.push(`building:${room.bld_descrshort.toLowerCase()}`);
        room.bld_descrshort.toLowerCase().split(/\s+/).forEach(word => {
            if (word.length > 1) tags.push(word);
        });
    }
    
    // Floor tags
    if (room.floor !== undefined && room.floor !== null) {
        tags.push(`floor:${room.floor}`);
        tags.push(`f${room.floor}`);
        tags.push(`level:${room.floor}`);
        tags.push(room.floor.toString());
    }
    
    // Department tags
    if (room.dept_descr) {
        tags.push(room.dept_descr.toLowerCase());
        tags.push(`department:${room.dept_descr.toLowerCase()}`);
        // Add individual words from department
        room.dept_descr.toLowerCase().split(/\s+/).forEach(word => {
            if (word.length > 2) tags.push(word);
        });
    }
    
    // Room type tags
    if (room.typeFull) {
        tags.push(room.typeFull.toLowerCase());
        tags.push(`type:${room.typeFull.toLowerCase()}`);
        // Add individual words from room type
        room.typeFull.toLowerCase().split(/[\s\-\/]+/).forEach(word => {
            if (word.length > 2) tags.push(word);
        });
    }
    
    // System-generated category tags
    if (room.tags) {
        room.tags.forEach(tag => {
            tags.push(tag.toLowerCase());
            tags.push(`category:${tag.toLowerCase()}`);
            // Add individual words from tags
            tag.toLowerCase().split(/[\s\-]+/).forEach(word => {
                if (word.length > 2) tags.push(word);
            });
        });
    }
    
    // Custom tags
    const customTags = state.customTags[room.id] || [];
    customTags.forEach(tagObj => {
        if (tagObj.name) {
            tags.push(tagObj.name.toLowerCase());
            tags.push(`custom:${tagObj.name.toLowerCase()}`);
            // Add individual words from custom tag names
            tagObj.name.toLowerCase().split(/\s+/).forEach(word => {
                if (word.length > 1) tags.push(word);
            });
        }
        if (tagObj.type) {
            tags.push(`tagtype:${tagObj.type.toLowerCase()}`);
        }
        if (tagObj.color) {
            tags.push(`color:${tagObj.color.toLowerCase()}`);
        }
    });
    
    // Staff tags
    const staffTags = state.staffTags[room.id] || [];
    staffTags.forEach(staffTag => {
        const name = staffTag.replace('Staff: ', '').toLowerCase();
        tags.push(name);
        tags.push(`staff:${name}`);
        // Add individual name parts
        name.split(/\s+/).forEach(namePart => {
            if (namePart.length > 1) tags.push(namePart);
        });
    });
    
    // Room number variations
    if (room.rmnbr) {
        tags.push(room.rmnbr.toString().toLowerCase());
        tags.push(`room:${room.rmnbr.toString().toLowerCase()}`);
    }
    
    return [...new Set(tags)]; // Remove duplicates
}

// Enhanced search that treats everything as tags
function searchRoomsByTags(searchQuery) {
    if (!searchQuery || !state.processedData.length) {
        return [...state.processedData];
    }
    
    const searchTerms = searchQuery.toLowerCase()
        .split(/[\s,]+/)
        .map(term => term.trim())
        .filter(term => term.length > 0);
    
    if (searchTerms.length === 0) {
        return [...state.processedData];
    }
    
    return state.processedData.filter(room => {
        const roomTags = createUnifiedTags(room);
        
        // For each search term, check if it matches any room tag
        return searchTerms.every(searchTerm => {
            return roomTags.some(tag => {
                // Exact match (highest priority)
                if (tag === searchTerm) return true;
                
                // Prefix match for room numbers and IDs
                if (tag.startsWith(searchTerm) && (searchTerm.length >= 2 || /^\d/.test(searchTerm))) return true;
                
                // Contains match for longer terms
                if (searchTerm.length >= 3 && tag.includes(searchTerm)) return true;
                
                // Handle partial matches for compound terms
                if (searchTerm.includes('-') || searchTerm.includes(' ')) {
                    const searchWords = searchTerm.split(/[\s\-]+/);
                    return searchWords.every(word => 
                        word.length > 1 && roomTags.some(t => t.includes(word))
                    );
                }
                
                return false;
            });
        });
    });
}

// Simplified filter function - now just calls the unified search
function data_getFilteredData() {
    let result = searchRoomsByTags(state.searchQuery);
    
    // Apply dropdown filters (still supported for backward compatibility)
    if (state.activeFilters.building) {
        result = result.filter(r => r.building === state.activeFilters.building);
    }
    if (state.activeFilters.floor) {
        result = result.filter(r => String(r.floor) === String(state.activeFilters.floor));
    }
    if (state.activeFilters.tags.length > 0) {
        // Convert active filter tags to search terms and apply unified search
        const currentQuery = state.searchQuery;
        const combinedQuery = [currentQuery, ...state.activeFilters.tags].filter(Boolean).join(' ');
        result = searchRoomsByTags(combinedQuery);
    }
    
    state.currentFilteredData = result;
    return result;
}

// Helper function to capitalize first letter
function capitalizeFirst(str) {
    return str.charAt(0).toUpperCase() + str.slice(1);
}

// Enhanced autocomplete that suggests all types of tags
function buildUnifiedAutocomplete() {
    const suggestions = new Set();
    const limit = 5000;
    
    state.processedData.forEach(room => {
        if (suggestions.size >= limit) return;
        
        const tags = createUnifiedTags(room);
        tags.forEach(tag => {
            if (suggestions.size < limit) {
                // Add the tag as-is
                suggestions.add(tag);
                
                // Add variations without prefixes for user convenience
                if (tag.includes(':')) {
                    const [prefix, value] = tag.split(':', 2);
                    suggestions.add(value);
                }
            }
        });
        
        // Add room number
        if (room.rmnbr && suggestions.size < limit) {
            suggestions.add(room.rmnbr.toString());
        }
    });
    
    return Array.from(suggestions).sort();
}

// Update the existing buildAutocompleteList function
function buildAutocompleteList() {
    state.autocompleteItems = buildUnifiedAutocomplete();
}

// Enhanced search index creation
async function createSearchIndex() {
    if (state.processedData.length === 0) {
        state.fuse = null;
        buildAutocompleteList();
        return;
    }
    
    // Create enhanced data for Fuse with unified tags
    const dataForIndex = state.processedData.map(r => ({
        ...r,
        unifiedTags: createUnifiedTags(r).join(' '),
        rmnbrStr: r.rmnbr ? r.rmnbr.toString() : ''
    }));
    
    // Simplified Fuse configuration focusing on unified tags
    state.fuse = new Fuse(dataForIndex, {
        keys: [
            { name: 'rmnbrStr', weight: 3.0 },
            { name: 'unifiedTags', weight: 2.0 }
        ],
        threshold: 0.3,
        ignoreLocation: true,
        useExtendedSearch: true,
        includeMatches: true,
        minMatchCharLength: 1
    });
    
    buildAutocompleteList();
}

function updateAutocomplete(query) {
    if (!elements.autocompleteContainer || !query || query.length < 1) {
        hideAutocomplete();
        return;
    }
    
    let matches = [];
    const lowerQuery = query.toLowerCase();
    const stringItems = state.autocompleteItems.filter(item => typeof item === 'string' && item.length > 0);

    if (/^\d/.test(query)) {
        // For queries starting with numbers, prioritize exact matches
        matches = stringItems.filter(i => i.toLowerCase().startsWith(lowerQuery) || i.toLowerCase() === lowerQuery).slice(0, 10);
    } else {
        // For text queries, show starts-with first, then contains
        const startsWith = stringItems.filter(i => i.toLowerCase().startsWith(lowerQuery)).slice(0, 5);
        const includes = stringItems.filter(i => !i.toLowerCase().startsWith(lowerQuery) && i.toLowerCase().includes(lowerQuery)).slice(0, 5);
        matches = [...startsWith, ...includes];
    }

    elements.autocompleteContainer.innerHTML = '';
    if (matches.length === 0) {
        hideAutocomplete();
        return;
    }

    matches.forEach((item, idx) => {
        const clone = elements.autocompleteItemTemplate.content.cloneNode(true);
        const div = clone.querySelector('div');
        div.textContent = item;
        div.id = `ac-item-${idx}`;
        div.dataset.item = item;
        elements.autocompleteContainer.appendChild(clone);
    });
    
    elements.autocompleteContainer.classList.remove('hidden');
    state.autocompleteActiveIndex = -1;
}

function hideAutocomplete() {
    if (elements.autocompleteContainer) elements.autocompleteContainer.classList.add('hidden');
}

function handleAutocompleteKeydown(e) {
    if (!elements.autocompleteContainer || elements.autocompleteContainer.classList.contains('hidden')) return;
    const items = elements.autocompleteContainer.querySelectorAll('[role="option"]');
    if (items.length === 0) return;
    let newIndex = state.autocompleteActiveIndex;

    if (e.key === 'ArrowDown') {
        e.preventDefault();
        newIndex = (state.autocompleteActiveIndex + 1) % items.length;
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        newIndex = (state.autocompleteActiveIndex - 1 + items.length) % items.length;
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (newIndex > -1 && items[newIndex]) {
            const selectedValue = items[newIndex].dataset.item;
            elements.searchInput.value = selectedValue;
            if (elements.searchInputMobile) elements.searchInputMobile.value = selectedValue;
            state.searchQuery = selectedValue;
            hideAutocomplete();
            state.currentPage = 1;
            updateResults(); // Direct call to ui.js function
        }
        return;
    } else if (e.key === 'Escape') {
        hideAutocomplete();
        return;
    } else {
        return;
    }

    if (state.autocompleteActiveIndex > -1 && items[state.autocompleteActiveIndex]) {
        items[state.autocompleteActiveIndex].classList.remove('bg-um-maize-light');
        items[state.autocompleteActiveIndex].removeAttribute('aria-selected');
    }
    if (items[newIndex]) {
        items[newIndex].classList.add('bg-um-maize-light');
        items[newIndex].setAttribute('aria-selected', 'true');
    }
    state.autocompleteActiveIndex = newIndex;
}