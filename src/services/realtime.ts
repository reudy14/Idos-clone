import axios from 'axios';
import NodeCache from 'node-cache';
import dotenv from 'dotenv';
dotenv.config();

// Standard TTL is 60 seconds
const cache = new NodeCache({ stdTTL: 60, checkperiod: 30 });
const TOKEN = process.env.GOLEMIO_API_TOKEN;
const REALTIME_URL = 'https://api.golemio.cz/v2/vehiclepositions';

export async function fetchLiveDelays(routeName: string): Promise<Record<string, number>> {
    const cacheKey = `delays_${routeName}`;
    let delays = cache.get<Record<string, number>>(cacheKey);

    if (!delays) {
        delays = {};
        if (TOKEN) {
            try {
                // Notice that Golemio vehiclepositions takes route short name or ID
                const res = await axios.get(`${REALTIME_URL}?routeShortName=${routeName}`, {
                    headers: { 'x-access-token': TOKEN }
                });
                
                // Usually returns an array of vehicle positions
                const vehicles = res.data?.features || [];
                for (const v of vehicles) {
                    const tripId = v.properties?.trip?.gtfs_trip_id;
                    const delaySecs = v.properties?.delay?.actual || 0;
                    if (tripId) {
                        delays[tripId] = delaySecs;
                    }
                }
                
                cache.set(cacheKey, delays);
            } catch (err) {
                console.error(`Failed to fetch real-time delays for route ${routeName}`);
            }
        }
    }
    return delays;
}
