import prisma from '../src/prismaConnection';

async function seed() {
    await prisma.user.createMany({
        data: [
            {
                username: 'femi',
                email: 'femi@oje.com',
                password_hash: 'password',
                is_email_verified: false,
                account_status: 'active',
                user_type: 'regular',
            },
            {
                username: 'tolu',
                email: 'tolu@oje.com',
                password_hash: 'password',
                is_email_verified: false,
                account_status: 'active',
                user_type: 'regular',
            },
            {
                username: 'tosin',
                email: 'tosin@oje.com',
                password_hash: 'password',
                is_email_verified: false,
                account_status: 'active',
                user_type: 'regular',
            },
        ],
    });
}

seed()
    .then(() => {
        console.log('Seed completed');
    })
    .catch((error) => {
        console.error(error);
    })
    .finally(() => {
        prisma.$disconnect();
    });
