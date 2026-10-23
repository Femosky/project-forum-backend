import { defineJob } from '../../lib/jobs';
import { Email, sendEmail } from '../../lib/email';

export const emailJob = defineJob<Email>('email.send', sendEmail, { retryLimit: 5 });
