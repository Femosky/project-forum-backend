// The site's name and its own forum account (owner of the launch communities). Rename the site here.
export const SITE_ACCOUNT_NAME = 'Yarnter';
export const SITE_ACCOUNT_USERNAME = 'site_team';

// Accounts marked is_seed (launch seed accounts and the site account) aren't people; stats leave them out
export const NOT_REAL_PERSON_SQL = `SELECT "id" FROM "User" WHERE "is_seed"`;
