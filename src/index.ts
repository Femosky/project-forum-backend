import { env } from './config/env';
import app from './app';
import logger from './lib/logger';
import { startJobs, stopJobs } from './lib/jobs';
import prisma from './prismaConnection';
import { flushAnalytics } from './lib/analytics';

const server = app.listen(env.PORT, () => {
    logger.info(`Server is running on port: ${env.PORT}`);
});

startJobs().catch((error) => logger.error({ err: error }, 'Job queue failed to start; jobs will run inline'));

async function shutdown(signal: string) {
    logger.info({ signal }, 'Shutting down');
    server.close();
    await stopJobs().catch(() => undefined);
    await flushAnalytics();
    await prisma.$disconnect();
    process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
