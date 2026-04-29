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

export function buildTimetable() {
    console.log('Building in-memory timetable from SQLite for CSA...');
    // Get all trips that are running today
    // For simplicity of this demo, we assume all trips are running. 
    // In a production system, we'd filter by `calendar` based on current day of week and start/end dates.

    const rows = db.prepare(`
        SELECT 
            st.trip_id,
            t.route_id,
            st.stop_sequence,
            st.stop_id,
            st.arrival_time,
            st.departure_time
        FROM stop_times st
        JOIN trips t ON st.trip_id = t.trip_id
        ORDER BY st.trip_id, st.stop_sequence ASC
    `).all() as any[];

    // Convert stop_times into Connections (pairs of adjacent stops)
    const connections: Connection[] = [];
    
    // Using a map to parse sequences quickly
    let previousRow: any = null;
    for (const row of rows) {
        if (previousRow && previousRow.trip_id === row.trip_id) {
            connections.push({
                departure_stop: previousRow.stop_id,
                arrival_stop: row.stop_id,
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
    
    timetable = connections;
    console.log(`Timetable built with ${timetable.length} connections.`);
}

export interface RouteProfile {
    arrival_time: number;
    connection: Connection | null; // which connection got us here
}

export function findRoute(startStopId: string, arrivalStopId: string, startTimeStr: string) {
    const startTimeAsSeconds = timeToSeconds(startTimeStr);
    
    const earliestArrival: Record<string, number> = {};
    const tripReached: Record<string, boolean> = {}; // Tracks if we boarded a trip
    const inConnection: Record<string, Connection> = {}; // Reconstruct path

    earliestArrival[startStopId] = startTimeAsSeconds;

    // Scan connections
    for (const conn of timetable) {
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
            }
        }
    }

    // Reconstruct path
    if (!earliestArrival[arrivalStopId]) {
        return null; // Route not found
    }

    const path: Connection[] = [];
    let currentStop = arrivalStopId;
    while (currentStop !== startStopId) {
        const conn = inConnection[currentStop];
        if (!conn) break;
        path.push(conn);
        currentStop = conn.departure_stop;
    }

    path.reverse();
    return {
        path,
        start_time: startTimeStr,
        arrival_time: secondsToTime(earliestArrival[arrivalStopId]),
        duration_minutes: Math.round((earliestArrival[arrivalStopId] - startTimeAsSeconds) / 60)
    };
}
