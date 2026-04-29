import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { db } from '../db';
import AdmZip from 'adm-zip';
import cron from 'node-cron';
import dotenv from 'dotenv';
dotenv.config();

const GTFS_URL = 'http://data.pid.cz/PID_GTFS.zip';
const TEMP_DIR = path.join(process.cwd(), 'data', 'temp_gtfs');

// Global logger callback (set by server.ts)
let logCallback: ((msg: string) => void) | null = null;

export function setLogCallback(cb: ((msg: string) => void) | null) {
    logCallback = cb;
}

function log(msg: string) {
    if (logCallback) {
        logCallback(msg);
    } else {
        process.stdout.write(msg + '\n');
    }
}

async function downloadAndExtract(): Promise<void> {
    const zipPath = path.join(TEMP_DIR, 'pid_gtfs.zip');
    
    log('Downloading GTFS data from PID...');
    const response = await axios.get(GTFS_URL, { responseType: 'arraybuffer', timeout: 120000 });
    fs.writeFileSync(zipPath, response.data);
    log(`Downloaded ${(response.data.length / 1024 / 1024).toFixed(1)} MB`);

    log('Extracting ZIP...');
    const zip = new AdmZip(zipPath);
    zip.extractAllTo(TEMP_DIR, true);
    log('Extracted successfully');
}

function parseCSV<T>(filepath: string, mapper: (row: any) => T): T[] {
    const content = fs.readFileSync(filepath, 'utf-8');
    const lines = content.split('\n');
    if (lines.length < 2) return [];
    
    const headers = lines[0].split(',').map(h => h.trim().replace(/"/g, ''));
    const results: T[] = [];
    
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        const values: string[] = [];
        let current = '';
        let inQuotes = false;
        
        for (const char of line) {
            if (char === '"') {
                inQuotes = !inQuotes;
            } else if (char === ',' && !inQuotes) {
                values.push(current.trim());
                current = '';
            } else {
                current += char;
            }
        }
        values.push(current.trim());
        
        const row: any = {};
        headers.forEach((h, idx) => {
            row[h] = values[idx] || '';
        });
        
        try {
            results.push(mapper(row));
        } catch (e) {
            // Skip malformed rows
        }
    }
    
    return results;
}

export async function syncGtfs() {
    log('Starting GTFS Static data sync via PID ZIP...');
    
    try {
        if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

        db.pragma('foreign_keys = OFF');
        db.exec('BEGIN TRANSACTION');

        db.prepare('DELETE FROM stop_times').run();
        db.prepare('DELETE FROM trips').run();
        db.prepare('DELETE FROM calendar').run();
        db.prepare('DELETE FROM routes').run();
        db.prepare('DELETE FROM stops').run();

        await downloadAndExtract();

        const files = fs.readdirSync(TEMP_DIR);
        log('Extracted files: ' + files.join(', '));

        // 1. Stops
        const stopsFile = path.join(TEMP_DIR, 'stops.txt');
        if (fs.existsSync(stopsFile)) {
            log('Parsing stops...');
            const stops = parseCSV(stopsFile, (row) => ({
                stop_id: row.stop_id,
                stop_name: row.stop_name,
                stop_lat: parseFloat(row.stop_lat) || 0,
                stop_lon: parseFloat(row.stop_lon) || 0,
                location_type: parseInt(row.location_type) || 0,
                parent_station: row.parent_station || null
            }));
            log(`Got ${stops.length} stops, inserting...`);
            
            const insertStop = db.prepare('INSERT OR IGNORE INTO stops (stop_id, stop_name, stop_lat, stop_lon, location_type, parent_station) VALUES (?, ?, ?, ?, ?, ?)');
            for (const s of stops) {
                insertStop.run(s.stop_id, s.stop_name, s.stop_lat, s.stop_lon, s.location_type, s.parent_station);
            }
        }

        // 2. Routes
        const routesFile = path.join(TEMP_DIR, 'routes.txt');
        if (fs.existsSync(routesFile)) {
            log('Parsing routes...');
            const routes = parseCSV(routesFile, (row) => ({
                route_id: row.route_id,
                route_short_name: row.route_short_name || '',
                route_long_name: row.route_long_name || '',
                route_type: parseInt(row.route_type) || 0
            }));
            log(`Got ${routes.length} routes, inserting...`);
            
            const insertRoute = db.prepare('INSERT OR IGNORE INTO routes (route_id, route_short_name, route_long_name, route_type) VALUES (?, ?, ?, ?)');
            for (const r of routes) {
                insertRoute.run(r.route_id, r.route_short_name, r.route_long_name, r.route_type);
            }
        }

        // 3. Trips
        const tripsFile = path.join(TEMP_DIR, 'trips.txt');
        if (fs.existsSync(tripsFile)) {
            log('Parsing trips...');
            const trips = parseCSV(tripsFile, (row) => ({
                trip_id: row.trip_id,
                route_id: row.route_id,
                service_id: row.service_id || '',
                trip_headsign: row.trip_headsign || '',
                direction_id: parseInt(row.direction_id) || 0
            }));
            log(`Got ${trips.length} trips, inserting...`);
            
            const insertTrip = db.prepare('INSERT OR IGNORE INTO trips (trip_id, route_id, service_id, trip_headsign, direction_id) VALUES (?, ?, ?, ?, ?)');
            for (const t of trips) {
                insertTrip.run(t.trip_id, t.route_id, t.service_id, t.trip_headsign, t.direction_id);
            }
        }

        // 4. Stop Times
        const stopTimesFile = path.join(TEMP_DIR, 'stop_times.txt');
        if (fs.existsSync(stopTimesFile)) {
            log('Parsing stop_times...');
            const stopTimes = parseCSV(stopTimesFile, (row) => ({
                trip_id: row.trip_id,
                arrival_time: row.arrival_time,
                departure_time: row.departure_time,
                stop_id: row.stop_id,
                stop_sequence: parseInt(row.stop_sequence) || 0,
                pickup_type: parseInt(row.pickup_type) || 0,
                drop_off_type: parseInt(row.drop_off_type) || 0
            }));
            log(`Got ${stopTimes.length} stop_times, inserting...`);
            
            const insertSt = db.prepare('INSERT OR IGNORE INTO stop_times (trip_id, arrival_time, departure_time, stop_id, stop_sequence, pickup_type, drop_off_type) VALUES (?, ?, ?, ?, ?, ?, ?)');
            for (const st of stopTimes) {
                insertSt.run(st.trip_id, st.arrival_time, st.departure_time, st.stop_id, st.stop_sequence, st.pickup_type, st.drop_off_type);
            }
        }

        // 5. Calendar
        const calendarFile = path.join(TEMP_DIR, 'calendar.txt');
        if (fs.existsSync(calendarFile)) {
            log('Parsing calendar...');
            const calendar = parseCSV(calendarFile, (row) => ({
                service_id: row.service_id,
                monday: parseInt(row.monday) || 0,
                tuesday: parseInt(row.tuesday) || 0,
                wednesday: parseInt(row.wednesday) || 0,
                thursday: parseInt(row.thursday) || 0,
                friday: parseInt(row.friday) || 0,
                saturday: parseInt(row.saturday) || 0,
                sunday: parseInt(row.sunday) || 0,
                start_date: row.start_date,
                end_date: row.end_date
            }));
            log(`Got ${calendar.length} calendar entries, inserting...`);
            
            const insertCal = db.prepare('INSERT OR IGNORE INTO calendar (service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
            for (const c of calendar) {
                insertCal.run(c.service_id, c.monday, c.tuesday, c.wednesday, c.thursday, c.friday, c.saturday, c.sunday, c.start_date, c.end_date);
            }
        }

        db.exec('COMMIT');
        db.pragma('foreign_keys = ON');
        log('GTFS sync completed!');
    } catch (err: any) {
        if (db.inTransaction) db.exec('ROLLBACK');
        log('Sync failed: ' + err.message);
        throw err;
    }
}

cron.schedule('0 2 * * *', () => syncGtfs());
if (require.main === module) syncGtfs().then(() => process.exit(0));
