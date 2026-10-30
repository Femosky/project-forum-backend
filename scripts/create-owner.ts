// Creates the first admin panel owner (staff accounts are separate from forum accounts; modules/staff).
//
//   npm run admin:create-owner -- --email you@example.com --name "Femi"
//
// Prints a temporary password. Sign in at {WEB_URL}/admin/login: you'll set up an authenticator app, then pick a new
// password. Refuses to run when an active owner already exists (owners invite everyone else from the panel), unless
// --force is given.
import { randomBytes } from 'node:crypto';
import prisma from '../src/prismaConnection';
import { env } from '../src/config/env';
import { hashPassword } from '../src/modules/auth/service';

function arg(name: string) {
    const index = process.argv.indexOf(`--${name}`);
    return index > -1 ? process.argv[index + 1] : undefined;
}

(async () => {
    const email = arg('email')?.trim().toLowerCase();
    const name = arg('name')?.trim();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !name) {
        console.error('Usage: npm run admin:create-owner -- --email you@example.com --name "Your name"');
        process.exit(1);
    }
    const owners = await prisma.staffAccount.count({ where: { role: 'owner', disabled_at: null } });
    if (owners > 0 && !process.argv.includes('--force')) {
        console.error('An owner already exists. Invite more staff from Admin -> Admins (or pass --force).');
        process.exit(1);
    }
    if (await prisma.staffAccount.findUnique({ where: { email } })) {
        console.error(`There is already a staff account for ${email}.`);
        process.exit(1);
    }

    const password = randomBytes(12).toString('base64url');
    await prisma.staffAccount.create({
        data: { email, name, role: 'owner', password_hash: await hashPassword(password), password_temporary: true },
    });
    await prisma.staffAudit.create({ data: { action: 'create_owner_cli', target_type: 'staff', details: { email } } });
    console.log(`Owner created for ${email}.`);
    console.log(`Temporary password: ${password}`);
    console.log(`Sign in at ${env.WEB_URL}/admin/login, set up two-factor with an authenticator app, then choose a new password.`);
    await prisma.$disconnect();
})();
