import express from 'express';
import cors from 'cors';
import compression from 'compression';
import path from 'path';
import { db } from './db';
import { buildTimetable, findRoute } from './routing/csa';
import { fetchLiveDelays } from './services/realtime';
import fs from 'fs';

const app = express();
app.use(cors());
app.use(compression());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// Initialize CSA
setTimeout(() => {
    // We delay this so the db is created first. 
    // In production we should wait for GTFS sync to finish if DB is empty
    const stopsCount = db.prepare('SELECT count(*) as c FROM stops').get() as { c: number };
    if (stopsCount.c > 0) {
        buildTimetable();
    } else {
        console.warn("DB is empty. Please run sync: npm run sync");
    }
}, 1000);

app.get('/api/stops', (req, res) => {
    const q = req.query.q as string;
    if (!q || q.length < 2) return res.json([]);
    const stmt = db.prepare('SELECT stop_id, stop_name, stop_lat, stop_lon FROM stops WHERE stop_name LIKE ? GROUP BY stop_name LIMIT 20');
    const rows = stmt.all(`%${q}%`);
    res.json(rows);
});

app.get('/api/route', async (req, res) => {
    const { fromId, toId, time } = req.query;
    if (!fromId || !toId || !time) {
        return res.status(400).json({ error: 'fromId, toId, and time are required' });
    }

    try {
        const routeData = findRoute(fromId as string, toId as string, time as string);
        
        if (!routeData) {
            return res.json({ error: 'No route found' });
        }

        // Apply real-time modifications if requested & available
        // Group by distinct route to fetch realtime info
        const distinctRoutes = Array.from(new Set(routeData.path.map(p => p.route_id)));
        
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
        const enrichedPath = routeData.path.map(conn => {
            const depStop = db.prepare('SELECT stop_name FROM stops WHERE stop_id = ?').get(conn.departure_stop) as any;
            const arrStop = db.prepare('SELECT stop_name FROM stops WHERE stop_id = ?').get(conn.arrival_stop) as any;
            const routeInfo = db.prepare('SELECT route_short_name, route_type FROM routes WHERE route_id = ?').get(conn.route_id) as any;
            
            const delay = realtimeDelays[conn.trip_id] || 0;

            return {
                ...conn,
                departure_stop_name: depStop?.stop_name,
                arrival_stop_name: arrStop?.stop_name,
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
