import { defineScheduledJob } from '../../lib/jobs';
import { computeTrending } from './service';

// Every 10 minutes: trending posts, rising communities and topics (service.ts)
export const trendingJob = defineScheduledJob('trending.compute', '*/10 * * * *', computeTrending);
