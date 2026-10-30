import { env } from './config/env';
import app from './app';
import logger from './lib/logger';
import { startJobs, stopJobs } from './lib/jobs';
import prisma from './prismaConnection';
import { flushAnalytics } from './lib/analytics';
import { reportError } from './lib/errorReport';
import { startMetricsFlusher, stopMetricsFlusher } from './modules/metrics/buffer';

const server = app.listen(env.PORT, () => {
    logger.info(`Server is running on port: ${env.PORT}`);
});

startMetricsFlusher();
startJobs().catch((error) => logger.error({ err: error }, 'Job queue failed to start; jobs will run inline'));

async function shutdown(signal: string) {
    logger.info({ signal }, 'Shutting down');
    server.close();
    // Buffered view counts, visits and last-active times are written before the process goes
    await stopMetricsFlusher().catch(() => undefined);
    await stopJobs().catch(() => undefined);
    await flushAnalytics();
    await prisma.$disconnect();
    process.exit(0);
}
// Crashes outside a request: log and report, then let the host restart the process
process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    reportError(error, { path: 'uncaughtException' });
    setTimeout(() => process.exit(1), 2000);
});
process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
    reportError(reason, { path: 'unhandledRejection' });
});
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
