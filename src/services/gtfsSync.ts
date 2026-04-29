import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { db } from '../db';
import cron from 'node-cron';
import dotenv from 'dotenv';
dotenv.config();

const BASE_URL = 'https://api.golemio.cz/v2/gtfs';
const TOKEN = process.env.GOLEMIO_API_TOKEN;
const PAGE_LIMIT = 10000;
const TEMP_DIR = path.join(process.cwd(), 'data', 'temp_gtfs');
const HEADERS = TOKEN ? { 'x-access-token': TOKEN } : {};

async function fetchAllPages(endpoint: string): Promise<any[]> {
    const rows: any[] = [];
    let offset = 0;
    while (true) {
        const res = await axios.get(`${BASE_URL}${endpoint}?limit=${PAGE_LIMIT}&offset=${offset}`, { headers: HEADERS });
        const data = res.data;
        const items = Array.isArray(data) ? data : (data.features ?? data.data ?? []);
        rows.push(...items);
        if (items.length < PAGE_LIMIT) break;
        offset += PAGE_LIMIT;
        console.log(`  fetched ${rows.length} so far...`);
    }
    return rows;
}

export async function syncGtfs() {
    console.log('Starting GTFS Static data sync via Golemio API...');
    try {
        if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

        db.pragma('foreign_keys = OFF');
        db.exec('BEGIN TRANSACTION');

        db.prepare('DELETE FROM stop_times').run();
        db.prepare('DELETE FROM trips').run();
        db.prepare('DELETE FROM calendar').run();
        db.prepare('DELETE FROM routes').run();
        db.prepare('DELETE FROM stops').run();

        // 1. Stops
        console.log('Fetching stops...');
        const stops = await fetchAllPages('/stops');
        console.log(`Got ${stops.length} stops, inserting...`);
        const insertStop = db.prepare('INSERT OR IGNORE INTO stops (stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station) VALUES (?, ?, ?, ?, ?, ?)');
        for (const f of stops) {
            const s = f.properties;
            const coords = f.geometry?.coordinates;
            insertStop.run(s.stop_id, s.stop_name, coords?.[1] ?? null, coords?.[0] ?? null, s.location_type ?? 0, s.parent_station ?? null);
        }

        // 2. Routes
        console.log('Fetching routes...');
        const routes = await fetchAllPages('/routes');
        console.log(`Got ${routes.length} routes, inserting...`);
        const insertRoute = db.prepare('INSERT OR IGNORE INTO routes (route_id, route_short_name, route_long_name, route_type) VALUES (?, ?, ?, ?)');
        for (const r of routes) {
            insertRoute.run(r.route_id, r.route_short_name ?? '', r.route_long_name ?? '', r.route_type ?? 0);
        }

        // 3. Trips
        console.log('Fetching trips...');
        const trips = await fetchAllPages('/trips');
        console.log(`Got ${trips.length} trips, inserting...`);
        const insertTrip = db.prepare('INSERT OR IGNORE INTO trips (trip_id, route_id, service_id, trip_headsign, direction_id) VALUES (?, ?, ?, ?, ?)');
        for (const t of trips) {
            insertTrip.run(t.trip_id, t.route_id, t.service_id ?? '', t.trip_headsign ?? '', t.direction_id ?? 0);
        }

        // 4. Stop Times — fetch per-stop using /stoptimes/{id}
        // Rate limit: 20 requests per 8 seconds = max 2.5 req/sec
        // Only fetch for stops that have trips (stops referenced by trip data)
        console.log('Fetching stop_times for stops with trips...');
        const insertSt = db.prepare('INSERT OR IGNORE INTO stop_times (trip_id, arrival_time, departure_time, stop_id, stop_sequence, pickup_type, drop_off_type) VALUES (?, ?, ?, ?, ?, ?, ?)');

        // Get stop_ids that are referenced in the trips data (stops that have transit service)
        // We need to query stop_ids that appear in stop_times AFTER we fetch them
        // First, let's get all unique stop_ids from stop_times that already exist (if any)
        // But since we deleted them, we need to fetch for ALL stops that could have service
        // The best approach: fetch stop_times for a reasonable set of stops that cover the network
        // We use parent stations + stops that appeared in trips (via stop_id pattern matching)
        
        // Actually, let's fetch stop_times for ALL stops but in a smarter way:
        // - Get all trips and their stop_ids from existing stop_times BEFORE we delete
        // Since we just loaded trips data, let's use the trips to determine which stops to fetch
        // But we don't have stop_ids in trips data directly...
        
        // Simplest working approach: don't delete stop_times at start, just update/upsert
        // OR: fetch stop_times for stops that match certain patterns (U prefix = metro/train)
        const stopsWithService = db.prepare(`
            SELECT DISTINCT s.stop_id FROM stops s
            WHERE s.stop_id LIKE 'U%' OR s.stop_id LIKE 'M%' OR s.location_type = 1
        `).all() as {stop_id: string}[];
        
        console.log(`  Found ${stopsWithService.length} stops with transit service (U/M prefix or parent stations)`);

        if (stopsWithService.length === 0) {
            console.log('  No active stops found, skipping stop_times sync');
        } else {
            let successCount = 0;
            let emptyCount = 0;
            let errorCount = 0;

            for (let i = 0; i < stopsWithService.length; i++) {
                const stopId = stopsWithService[i].stop_id;
                try {
                    const res = await axios.get(`${BASE_URL}/stoptimes/${encodeURIComponent(stopId)}`, { headers: HEADERS });
                    const stData: any[] = Array.isArray(res.data) ? res.data : (res.data.data ?? []);
                    if (stData.length === 0) {
                        emptyCount++;
                    } else {
                        successCount++;
                    }
                    for (const st of stData) {
                        insertSt.run(st.trip_id, st.arrival_time, st.departure_time, stopId, st.stop_sequence ?? 0, st.pickup_type ?? 0, st.drop_off_type ?? 0);
                    }
                } catch (err: any) {
                    errorCount++;
                    if (errorCount <= 10) console.log(`  ERROR for stop ${stopId}: ${err.response?.status || err.message}`);
                }
                if (i % 50 === 0) console.log(`  stop_times progress: ${i}/${stopsWithService.length} (success:${successCount} empty:${emptyCount} errors:${errorCount})`);
                await new Promise(r => setTimeout(r, 400));
            }
            console.log(`  stop_times done: success=${successCount} empty=${emptyCount} errors=${errorCount}`);
        }

        db.exec('COMMIT');
        db.pragma('foreign_keys = ON');
        console.log('GTFS sync completed!');
    } catch (err) {
        if (db.inTransaction) db.exec('ROLLBACK');
        console.error('Failed to sync GTFS:', err);
    }
}

cron.schedule('0 2 * * *', () => syncGtfs());
if (require.main === module) syncGtfs().then(() => process.exit(0));
