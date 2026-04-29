import express from 'express';
import cors from 'cors';
import compression from 'compression';
import path from 'path';
import { db } from './db';
import { buildTimetable, buildAllTimetables, findRoute, findRoutes } from './routing/csa';
import { fetchLiveDelays } from './services/realtime';
import { syncGtfs, setLogCallback } from './services/gtfsSync';
import fs from 'fs';

const app = express();
app.use(cors());
app.use(compression());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// In-memory log buffer for frontend
const logBuffer: string[] = [];
const MAX_LOG_LINES = 500;

function logToBuffer(msg: string) {
    const timestamp = new Date().toISOString().slice(11, 19);
    logBuffer.push(`[${timestamp}] ${msg}`);
    if (logBuffer.length > MAX_LOG_LINES) logBuffer.shift();
    // Use original console.log to avoid recursion
    process.stdout.write(`[${timestamp}] ${msg}\n`);
}

// Initialize CSA
setTimeout(() => {
    // We delay this so the db is created first. 
    // In production we should wait for GTFS sync to finish if DB is empty
    const stopsCount = db.prepare('SELECT count(*) as c FROM stops').get() as { c: number };
    if (stopsCount.c > 0) {
        buildAllTimetables();
    } else {
        console.warn("DB is empty. Please run sync: npm run sync");
    }
}, 1000);

// Remove diacritics and replace special chars with spaces for search
function normalize(str: string): string {
    return str
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[,()[\]{}.,;:!?\/\\\-_]/g, ' ')
        .toLowerCase();
}

app.get('/api/stops', (req, res) => {
    const q = req.query.q as string;
    if (!q || q.length < 2) return res.json([]);
    
    // Normalize first, then split into words
    const normalizedQ = normalize(q);
    const queryWords = normalizedQ.split(/\s+/).filter(w => w.length > 0);
    
    // Get all stops and filter in memory
    const allStops = db.prepare('SELECT stop_id, stop_name, stop_lat, stop_lon FROM stops').all() as any[];
    
    const filtered = allStops
        .filter(s => {
            // Normalize stop name first, then split into words
            const normalizedName = normalize(s.stop_name);
            const nameWords = normalizedName.split(/\s+/).filter(w => w.length > 0);
            
            // Check if each query word matches a corresponding name word (in order)
            let queryIdx = 0;
            let nameIdx = 0;
            
            while (queryIdx < queryWords.length && nameIdx < nameWords.length) {
                if (nameWords[nameIdx].includes(queryWords[queryIdx])) {
                    queryIdx++;
                }
                nameIdx++;
            }
            
            return queryIdx === queryWords.length;
        })
        .slice(0, 20);
    
    res.json(filtered);
});

app.get('/api/routes', async (req, res) => {
    const { fromId, toId, time, day } = req.query;
    if (!fromId || !toId || !time) {
        return res.status(400).json({ error: 'fromId, toId, and time are required' });
    }

    try {
        const routes = findRoutes(fromId as string, toId as string, time as string, 3, day as string | undefined);
        
        if (!routes || routes.length === 0) {
            return res.json({ error: 'No route found' });
        }

        // Enrich each route's path with metadata
        const enrichedRoutes = await Promise.all(routes.map(async (routeData: any) => {
            // Apply real-time modifications if requested & available
            // Group by distinct route to fetch realtime info
            const distinctRoutes = Array.from(new Set(routeData.path.map((p: any) => p.route_id)));
            
            // Fetch short names for those routes to resolve to Golemio query
            let realtimeDelays: Record<string, number> = {};
            for(const r of distinctRoutes) {
                const routeRow = db.prepare('SELECT route_short_name FROM routes WHERE route_id = ?').get(r) as any;
                if (routeRow) {
                    const liveDelays = await fetchLiveDelays(routeRow.route_short_name);
                    realtimeDelays = { ...realtimeDelays, ...liveDelays };
                }
            }

            // Enrich path with metadata and delays
            const enrichedPath = routeData.path.map((conn: any) => {
                const routeInfo = db.prepare('SELECT route_short_name, route_type FROM routes WHERE route_id = ?').get(conn.route_id) as any;
                const delay = realtimeDelays[conn.trip_id] || 0;

                return {
                    ...conn,
                    route_short_name: routeInfo?.route_short_name,
                    route_type: routeInfo?.route_type,
                    delay_seconds: delay
                };
            });

            return {
                ...routeData,
                path: enrichedPath
            };
        }));

        res.json({
            routes: enrichedRoutes,
            count: enrichedRoutes.length
        });

    } catch (err: any) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Keep old endpoint for backwards compatibility
app.get('/api/route', async (req, res) => {
    const { fromId, toId, time } = req.query;
    if (!fromId || !toId || !time) {
        return res.status(400).json({ error: 'fromId, toId, and time are required' });
    }

    try {
        const routes = findRoutes(fromId as string, toId as string, time as string, 1);
        const routeData = routes.length > 0 ? routes[0] : null;
        
        if (!routeData) {
            return res.json({ error: 'No route found' });
        }

        // Apply real-time modifications if requested & available
        const distinctRoutes = Array.from(new Set(routeData.path.map((p: any) => p.route_id)));
        
        let realtimeDelays: Record<string, number> = {};
        for(const r of distinctRoutes) {
            const routeRow = db.prepare('SELECT route_short_name FROM routes WHERE route_id = ?').get(r) as any;
            if (routeRow) {
                const liveDelays = await fetchLiveDelays(routeRow.route_short_name);
                realtimeDelays = { ...realtimeDelays, ...liveDelays };
            }
        }

        const enrichedPath = routeData.path.map((conn: any) => {
            const routeInfo = db.prepare('SELECT route_short_name, route_type FROM routes WHERE route_id = ?').get(conn.route_id) as any;
            const delay = realtimeDelays[conn.trip_id] || 0;

            return {
                ...conn,
                route_short_name: routeInfo?.route_short_name,
                route_type: routeInfo?.route_type,
                delay_seconds: delay
            };
        });

        res.json({
            ...routeData,
            path: enrichedPath
        });

    } catch (err: any) {
        console.error(err);
        res.status(500).json({ error: err.message });
    }
});

// Sync endpoint
let isSyncing = false;
app.post('/api/sync', async (req, res) => {
    if (isSyncing) {
        return res.status(409).json({ error: 'Sync already in progress' });
    }
    isSyncing = true;
    logToBuffer('=== Sync started via API ===');
    
    // Set up log callback for syncGtfs
    setLogCallback(logToBuffer);
    
    // Run sync in background
    syncGtfs().then(() => {
        logToBuffer('=== Sync completed ===');
        isSyncing = false;
        setLogCallback(null);
        // Rebuild timetable after sync
        buildTimetable();
    }).catch((err) => {
        logToBuffer('=== Sync failed: ' + err.message + ' ===');
        isSyncing = false;
        setLogCallback(null);
    });
    
    res.json({ status: 'started' });
});

// Get sync status
app.get('/api/sync/status', (req, res) => {
    res.json({ syncing: isSyncing });
});

// SSE endpoint for live logs
app.get('/api/logs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Accel-Buffering', 'no');
    
    // Send current logs immediately
    const currentLogs = [...logBuffer];
    res.write(`data: ${JSON.stringify({ type: 'init', logs: currentLogs })}\n\n`);
    
    // Send heartbeat every 5 seconds
    const heartbeat = setInterval(() => {
        res.write(`data: ${JSON.stringify({ type: 'heartbeat' })}\n\n`);
    }, 5000);
    
    // Send new logs as they come in
    let lastIndex = logBuffer.length;
    const checkLogs = setInterval(() => {
        if (res.writable) {
            if (logBuffer.length > lastIndex) {
                const newLogs = logBuffer.slice(lastIndex);
                res.write(`data: ${JSON.stringify({ type: 'logs', logs: newLogs })}\n\n`);
                lastIndex = logBuffer.length;
            }
        }
    }, 500);
    
    // Cleanup on disconnect
    req.on('close', () => {
        clearInterval(heartbeat);
        clearInterval(checkLogs);
    });
});

// Polling endpoint as backup
let logIndex = 0;
app.get('/api/logs', (req, res) => {
    const logs = logBuffer.slice(logIndex);
    logIndex = logBuffer.length;
    res.json({ logs });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    logToBuffer(`Server running on port ${PORT}`);
});
