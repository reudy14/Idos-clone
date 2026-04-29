-- schema.sql: Core tables for GTFS static data + our connection cache

-- STOPS: Physical locations where vehicles pick up or drop off riders.
CREATE TABLE IF NOT EXISTS stops (
    stop_id TEXT PRIMARY KEY,
    stop_name TEXT NOT NULL,
    stop_lat REAL,
    stop_lon REAL,
    location_type INTEGER,
    parent_station TEXT
);

-- ROUTES: A group of trips that are displayed to riders as a single service.
CREATE TABLE IF NOT EXISTS routes (
    route_id TEXT PRIMARY KEY,
    route_short_name TEXT,
    route_long_name TEXT,
    route_type INTEGER
);

-- CALENDAR (simplification, real GTFS is more complex but this works for demo)
CREATE TABLE IF NOT EXISTS calendar (
    service_id TEXT PRIMARY KEY,
    monday INTEGER,
    tuesday INTEGER,
    wednesday INTEGER,
    thursday INTEGER,
    friday INTEGER,
    saturday INTEGER,
    sunday INTEGER,
    start_date TEXT,
    end_date TEXT
);

-- TRIPS: A journey taken by a vehicle through stops.
CREATE TABLE IF NOT EXISTS trips (
    trip_id TEXT PRIMARY KEY,
    route_id TEXT,
    service_id TEXT,
    trip_headsign TEXT,
    direction_id INTEGER,
    FOREIGN KEY(route_id) REFERENCES routes(route_id),
    FOREIGN KEY(service_id) REFERENCES calendar(service_id)
);

-- STOP_TIMES: Times that a vehicle arrives at and departs from empty stops for each trip.
-- Notice we index this heavily later.
CREATE TABLE IF NOT EXISTS stop_times (
    trip_id TEXT,
    arrival_time TEXT,
    departure_time TEXT,
    stop_id TEXT,
    stop_sequence INTEGER,
    pickup_type INTEGER,
    drop_off_type INTEGER,
    PRIMARY KEY(trip_id, stop_sequence),
    FOREIGN KEY(trip_id) REFERENCES trips(trip_id),
    FOREIGN KEY(stop_id) REFERENCES stops(stop_id)
);

-- INDICES for fast routing access
CREATE INDEX IF NOT EXISTS idx_stop_times_stop ON stop_times(stop_id);
CREATE INDEX IF NOT EXISTS idx_stops_name ON stops(stop_name);
