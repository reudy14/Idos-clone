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
                data.forEach(stop => {
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
            
            data.path.forEach((conn, index) => {
                const delayText = conn.delay_seconds > 0 
                    ? `<span class="delay-badge">+${Math.round(conn.delay_seconds / 60)} min</span>` 
                    : '';

                html += `
                <div class="route-step">
                    <div class="route-time">${formatTime(conn.departure_time)}</div>
                    <div class="route-details">
                        <strong>${conn.departure_stop_name}</strong>
                        <div><span class="route-number">${conn.route_short_name || 'Walk'}</span> ⬇</div>
                    </div>
                    ${delayText}
                </div>`;
                
                // Print explicit arrival for the very last stop
                if (index === data.path.length - 1) {
                    html += `
                    <div class="route-step">
                        <div class="route-time">${formatTime(conn.arrival_time)}</div>
                        <div class="route-details">
                            <strong>${conn.arrival_stop_name}</strong>
                        </div>
                    </div>`;
                }
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

    let eventSource = null;

    function appendLog(line) {
        logContent.textContent += line + '\n';
        logContent.scrollTop = logContent.scrollHeight;
    }

    function connectLogStream() {
        eventSource = new EventSource('/api/logs/stream');
        
        eventSource.onmessage = (e) => {
            const data = JSON.parse(e.data);
            if (data.type === 'init') {
                logContent.textContent = data.logs.join('\n') + '\n';
                logContent.scrollTop = logContent.scrollHeight;
            } else if (data.type === 'logs') {
                data.logs.forEach(appendLog);
            }
        };

        eventSource.onerror = () => {
            eventSource.close();
            setTimeout(connectLogStream, 3000);
        };
    }

    connectLogStream();

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

});