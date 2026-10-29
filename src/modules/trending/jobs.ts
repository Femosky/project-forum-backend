import { defineScheduledJob, onJobsWake } from '../../lib/jobs';
import { computeTrending, ensureFreshTrending } from './service';

// Every 10 minutes: trending posts, rising communities and topics (service.ts)
export const trendingJob = defineScheduledJob('trending.compute', '*/10 * * * *', computeTrending);

// After an idle spell (or a restart) the 10-minute schedule may have missed runs: refresh a stale snapshot
onJobsWake('trending', ensureFreshTrending);
