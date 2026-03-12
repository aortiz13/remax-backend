import IORedis from 'ioredis';

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

export const redisConnection = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
});

redisConnection.on('error', (err) => {
    console.error('💥 Redis connection error:', err.message);
});

redisConnection.on('connect', () => {
    console.log('⚡ Redis connected');
});

export default redisConnection;
