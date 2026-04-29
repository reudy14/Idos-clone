import { db } from '../db';

export interface Connection {
    departure_stop: string;
    arrival_stop: string;
    departure_time: number; // in seconds from midnight
    arrival_time: number;
    trip_id: string;
    route_id: string; // denormalized for easier UI output
}

// In-memory timetable: sorted array of all connections
export let timetable: Connection[] = [];

// Cached timetables per day of week
const timetablesByDay: Record<string, Connection[]> = {
    monday: [],
    tuesday: [],
    wednesday: [],
    thursday: [],
    friday: [],
    saturday: [],
    sunday: [],
};

// Stop name cache for grouping stops by name
let stopNameCache: Record<string, string> = {}; // stop_id -> stop_name
let stopsByName: Record<string, string[]> = {}; // stop_name -> stop_ids

// Helper to convert "HH:MM:SS" to seconds from midnight
export function timeToSeconds(timeStr: string): number {
    const parts = timeStr.split(':').map(Number);
    // Note: GTFS times can exceed 24:00:00 for past-midnight trips
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

// Helper to format seconds to time
export function secondsToTime(secs: number): string {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

export function buildTimetable(dayOfWeek?: string) {
    console.log(`Building in-memory timetable from SQLite for CSA (day: ${dayOfWeek || 'all'})...`);
    
    // Build stop name cache and group stops by name
    const allStops = db.prepare('SELECT stop_id, stop_name FROM stops').all() as any[];
    stopNameCache = {};
    stopsByName = {};
    for (const s of allStops) {
        stopNameCache[s.stop_id] = s.stop_name;
        if (!stopsByName[s.stop_name]) {
            stopsByName[s.stop_name] = [];
        }
        stopsByName[s.stop_name].push(s.stop_id);
    }
    console.log(`Loaded ${allStops.length} stops, ${Object.keys(stopsByName).length} unique names`);

    // Filter trips by day of week using calendar table
    let serviceIds: string[] | null = null;
    if (dayOfWeek) {
        const dayColumn = dayOfWeek.toLowerCase();
        const validDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
        if (validDays.includes(dayColumn)) {
            // GTFS uses YYYYMMDD format
            const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            const calendarRows = db.prepare(`
                SELECT service_id FROM calendar
                WHERE ${dayColumn} = 1
                AND start_date <= ?
                AND end_date >= ?
            `).all(today, today) as any[];
            serviceIds = calendarRows.map(r => r.service_id);
            console.log(`Found ${serviceIds.length} service_ids running on ${dayOfWeek}`);
        }
    }

    let query = `
        SELECT 
            st.trip_id,
            t.route_id,
            st.stop_sequence,
            st.stop_id,
            st.arrival_time,
            st.departure_time
        FROM stop_times st
        JOIN trips t ON st.trip_id = t.trip_id
    `;
    if (serviceIds !== null) {
        query += ` WHERE t.service_id IN (${serviceIds.map(() => '?').join(',')})`;
    }
    query += ` ORDER BY st.trip_id, st.stop_sequence ASC`;

    const rows = serviceIds !== null
        ? db.prepare(query).all(...serviceIds) as any[]
        : db.prepare(query).all() as any[];

    // Convert stop_times into Connections (pairs of adjacent stops)
    // Use STOP NAMES instead of stop_ids to group A/B directions
    const connections: Connection[] = [];
    
    // Using a map to parse sequences quickly
    let previousRow: any = null;
    for (const row of rows) {
        if (previousRow && previousRow.trip_id === row.trip_id) {
            const depName = stopNameCache[previousRow.stop_id] || previousRow.stop_id;
            const arrName = stopNameCache[row.stop_id] || row.stop_id;
            connections.push({
                departure_stop: depName,  // Use name instead of id
                arrival_stop: arrName,   // Use name instead of id
                departure_time: timeToSeconds(previousRow.departure_time),
                arrival_time: timeToSeconds(row.arrival_time),
                trip_id: row.trip_id,
                route_id: row.route_id
            });
        }
        previousRow = row;
    }

    // Crux of CSA: SORT BY DEPARTURE TIME
    connections.sort((a, b) => a.departure_time - b.departure_time);
    
    if (dayOfWeek && timetablesByDay[dayOfWeek] !== undefined) {
        timetablesByDay[dayOfWeek] = connections;
        console.log(`Timetable for ${dayOfWeek} cached with ${connections.length} connections.`);
    } else {
        timetable = connections;
        console.log(`Timetable built with ${timetable.length} connections.`);
    }
}

export function buildAllTimetables() {
    console.log('Building all timetables at startup...');
    const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    for (const day of days) {
        buildTimetable(day);
    }
    // Set default timetable to today
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();
    timetable = timetablesByDay[today] || timetable;
    console.log(`Default timetable set to ${today}`);
}

export interface RouteProfile {
    arrival_time: number;
    connection: Connection | null; // which connection got us here
}

export function findRoute(startStopId: string, arrivalStopId: string, startTimeStr: string, dayOfWeek?: string) {
    const routes = findRoutes(startStopId, arrivalStopId, startTimeStr, 1, dayOfWeek);
    return routes.length > 0 ? routes[0] : null;
}

export function findRoutes(startStopId: string, arrivalStopId: string, startTimeStr: string, maxRoutes = 3, dayOfWeek?: string) {
    // Use cached timetable for the day, or default
    const activeTimetable = (dayOfWeek && timetablesByDay[dayOfWeek]?.length > 0)
        ? timetablesByDay[dayOfWeek]
        : timetable;
    
    if (activeTimetable.length === 0) {
        console.warn('Timetable is empty. Did you call buildAllTimetables()?');
    }
    
    const startTimeAsSeconds = timeToSeconds(startTimeStr);
    
    // Convert stop_ids to stop_names for unified routing
    const startStopName = stopNameCache[startStopId] || startStopId;
    const arrivalStopName = stopNameCache[arrivalStopId] || arrivalStopId;
    
    const results: any[] = [];
    const usedTrips = new Set<string>();
    
    for (let routeNum = 0; routeNum < maxRoutes; routeNum++) {
        const earliestArrival: Record<string, number> = {};
        const tripReached: Record<string, boolean> = {}; // Tracks if we boarded a trip
        const inConnection: Record<string, Connection> = {}; // Reconstruct path
        const arrivedVia: Record<string, Connection> = {}; // Track which connection arrived at each stop

        earliestArrival[startStopName] = startTimeAsSeconds;

        // Scan connections
        for (const conn of activeTimetable) {
            // Skip trips already used in previous routes
            if (usedTrips.has(conn.trip_id)) continue;
            
            // Only process connections departing on or after start time
            if (conn.departure_time < startTimeAsSeconds) continue;

            // Can we catch this connection? 
            // Either we are already at the stop before it leaves, or we transfer to this trip
            const canCatch = earliestArrival[conn.departure_stop] <= conn.departure_time || tripReached[conn.trip_id];

            if (canCatch) {
                tripReached[conn.trip_id] = true;
                
                // Check if this improves arrival time at the next stop
                if (!earliestArrival[conn.arrival_stop] || conn.arrival_time < earliestArrival[conn.arrival_stop]) {
                    earliestArrival[conn.arrival_stop] = conn.arrival_time;
                    inConnection[conn.arrival_stop] = conn;
                    arrivedVia[conn.arrival_stop] = conn;
                }
            }
        }

        // Reconstruct path
        if (!earliestArrival[arrivalStopName]) {
            break; // No more routes found
        }

        const path: Connection[] = [];
        let currentStop = arrivalStopName;
        while (currentStop !== startStopName) {
            const conn = inConnection[currentStop];
            if (!conn) break;
            path.push(conn);
            currentStop = conn.departure_stop;
        }

        path.reverse();
        
        if (path.length === 0) break;
        
        results.push({
            path,
            start_time: startTimeStr,
            arrival_time: secondsToTime(earliestArrival[arrivalStopName]),
            duration_minutes: Math.round((earliestArrival[arrivalStopName] - startTimeAsSeconds) / 60)
        });
        
        // Mark all trips used in this route to avoid them in next routes
        for (const conn of path) {
            usedTrips.add(conn.trip_id);
        }
    }
    
    return results;
}
