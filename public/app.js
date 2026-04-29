document.addEventListener('DOMContentLoaded', () => {
    // Set default time to now
    document.getElementById('timeInput').value = new Date().toTimeString().slice(0,5);

    let fromStopId = null;
    let toStopId = null;

    function setupAutocomplete(inputId, suggId, onSelect) {
        const input = document.getElementById(inputId);
        const sugg = document.getElementById(suggId);
        
        let timeout = null;

        input.addEventListener('input', () => {
            clearTimeout(timeout);
            const q = input.value;
            if (q.length < 2) {
                sugg.innerHTML = '';
                return;
            }
            timeout = setTimeout(async () => {
                const res = await fetch(`/api/stops?q=${encodeURIComponent(q)}`);
                const data = await res.json();
                sugg.innerHTML = '';
                
                // Group by stop_name to show unique names
                const byName = {};
                data.forEach(stop => {
                    if (!byName[stop.stop_name]) {
                        byName[stop.stop_name] = stop;
                    }
                });
                
                Object.values(byName).forEach(stop => {
                    const li = document.createElement('li');
                    li.textContent = stop.stop_name;
                    li.onclick = () => {
                        input.value = stop.stop_name;
                        onSelect(stop.stop_id);
                        sugg.innerHTML = '';
                    };
                    sugg.appendChild(li);
                });
            }, 300);
        });

        // Close when clicking outside
        document.addEventListener('click', (e) => {
            if (e.target !== input && !sugg.contains(e.target)) {
                sugg.innerHTML = '';
            }
        });
    }

    setupAutocomplete('fromInput', 'fromSuggestions', id => fromStopId = id);
    setupAutocomplete('toInput', 'toSuggestions', id => toStopId = id);

    function formatTime(seconds) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    document.getElementById('searchBtn').addEventListener('click', async () => {
        if (!fromStopId || !toStopId) {
            alert("Please select stops from the dropdown");
            return;
        }
        
        const timeVal = document.getElementById('timeInput').value + ":00";
        const resDiv = document.getElementById('results');
        resDiv.innerHTML = '<p>Loading...</p>';

        try {
            const res = await fetch(`/api/route?fromId=${fromStopId}&toId=${toStopId}&time=${timeVal}`);
            const data = await res.json();

            if (data.error) {
                resDiv.innerHTML = `<p>${data.error}</p>`;
                return;
            }

            let html = `<div class="route-meta">Duration: ${data.duration_minutes} min | Arrival: ${data.arrival_time}</div>`;
            
            // Group consecutive connections by route
            const legs = [];
            let currentLeg = null;
            
            data.path.forEach((conn, index) => {
                if (!currentLeg || currentLeg.route_id !== conn.route_id) {
                    if (currentLeg) {
                        // Add arrival stop to previous leg before starting new one
                        currentLeg.stops.push({
                            name: conn.departure_stop,
                            time: conn.departure_time
                        });
                        legs.push(currentLeg);
                    }
                    currentLeg = {
                        route_id: conn.route_id,
                        route_short_name: conn.route_short_name,
                        stops: [{
                            name: conn.departure_stop,
                            time: conn.departure_time
                        }],
                        departure_time: conn.departure_time,
                        arrival_time: conn.arrival_time
                    };
                } else {
                    currentLeg.stops.push({
                        name: conn.departure_stop,
                        time: conn.departure_time
                    });
                    currentLeg.arrival_time = conn.arrival_time;
                }
            });
            if (currentLeg) {
                // Add final arrival stop
                const lastConn = data.path[data.path.length - 1];
                currentLeg.stops.push({
                    name: lastConn.arrival_stop,
                    time: lastConn.arrival_time
                });
                legs.push(currentLeg);
            }
            
            // Render collapsible legs
            legs.forEach((leg, legIndex) => {
                const isExpanded = legIndex === 0; // First leg expanded by default
                html += `
                <details class="route-leg" ${isExpanded ? 'open' : ''}>
                    <summary class="route-leg-summary">
                        <div class="route-leg-main">
                            <span class="route-number">${leg.route_short_name || 'Walk'}</span>
                            <span class="route-leg-route">${leg.stops[0].name} → ${leg.stops[leg.stops.length-1].name}</span>
                        </div>
                        <div class="route-leg-times">
                            <span class="route-time">${formatTime(leg.departure_time)}</span>
                            <span class="route-duration">${Math.round((leg.arrival_time - leg.departure_time)/60)} min</span>
                        </div>
                    </summary>
                    <div class="route-leg-stops">
                        ${leg.stops.map((s, i) => `
                            <div class="route-stop ${i === 0 ? 'departure' : i === leg.stops.length-1 ? 'arrival' : 'intermediate'}">
                                <span class="route-stop-time">${formatTime(s.time)}</span>
                                <span class="route-stop-name">${s.name}</span>
                            </div>
                        `).join('')}
                    </div>
                </details>`;
            });

            resDiv.innerHTML = html;
        } catch(e) {
            resDiv.innerHTML = `<p>Error fetching route</p>`;
        }
    });

    // Sync button and log streaming
    const syncBtn = document.getElementById('syncBtn');
    const syncStatus = document.getElementById('syncStatus');
    const logContent = document.getElementById('logContent');
    const clearLogsBtn = document.getElementById('clearLogsBtn');
    const autoRefreshBtn = document.getElementById('autoRefreshBtn');

    console.log('Admin elements:', { syncBtn, syncStatus, logContent, clearLogsBtn, autoRefreshBtn });

    if (!syncBtn || !logContent) {
        console.error('Admin elements not found!');
    } else {
        let autoRefresh = false;
        let pollInterval = null;

        function appendLog(line) {
            logContent.textContent += line + '\n';
            logContent.scrollTop = logContent.scrollHeight;
        }

        function pollLogs() {
            if (!autoRefresh) return;
            fetch('/api/logs')
                .then(res => res.json())
                .then(data => {
                    if (data.logs && data.logs.length > 0) {
                        data.logs.forEach(appendLog);
                    }
                })
                .catch(err => console.error('Log poll error:', err));
        }

        function startPolling() {
            pollInterval = setInterval(pollLogs, 1000);
        }

        function stopPolling() {
            if (pollInterval) {
                clearInterval(pollInterval);
                pollInterval = null;
            }
        }

        autoRefreshBtn.addEventListener('change', (e) => {
            autoRefresh = e.target.checked;
            if (autoRefresh) {
                startPolling();
            } else {
                stopPolling();
            }
        });

        syncBtn.addEventListener('click', async () => {
            syncBtn.disabled = true;
            syncStatus.textContent = 'Syncing...';
            syncStatus.className = 'sync-status syncing';
            appendLog('Starting sync...');

            try {
                const res = await fetch('/api/sync', { method: 'POST' });
                const data = await res.json();
                if (data.error) {
                    appendLog('Error: ' + data.error);
                }
            } catch(e) {
                appendLog('Error: ' + e.message);
            }

            syncBtn.disabled = false;
            syncStatus.textContent = '';
            syncStatus.className = 'sync-status';
        });

        clearLogsBtn.addEventListener('click', () => {
            logContent.textContent = '';
        });
    }

});