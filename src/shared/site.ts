// The site's name and its own forum account (owner of the launch communities). Rename the site here.
export const SITE_ACCOUNT_NAME = 'Yarnter';
export const SITE_ACCOUNT_USERNAME = 'site_team';

// Launch seed accounts use this email domain (prisma/launch-seed.ts). Stats leave them and the site account out, so
// the numbers show real people only.
export const SEED_EMAIL_DOMAIN = 'seed.invalid';
export const NOT_REAL_PERSON_SQL = `SELECT "id" FROM "User" WHERE "email" LIKE '%@${SEED_EMAIL_DOMAIN}' OR "username" = '${SITE_ACCOUNT_USERNAME}'`;
