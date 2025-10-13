import { Router } from 'express';
import prisma from '../../prismaConnection';
import { AuthRequest } from '../../middlewares/authMiddleware';
import { ErrorResponse } from '../../models/interfaces/errorType';
import { AVATAR_OPTIONS } from '../../models/interfaces/avatar';
import { PasswordService } from '../../services/PasswordService';

const router = Router();

router.post('/change/avatar', async (request: AuthRequest, response) => {
    const user = request.user;
    const { avatar_id } = request.body;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!avatar_id) {
        return response.status(400).json({ error: 'Avatar ID is required' } as ErrorResponse);
    }

    try {
        if (!(avatar_id in AVATAR_OPTIONS)) {
            return response.status(400).json({ error: 'Invalid avatar ID' } as ErrorResponse);
        }

        const isAvatarChanged = await prisma.user.update({
            where: { id: user.id },
            data: { avatar_id: avatar_id },
        });

        if (!isAvatarChanged) {
            return response.status(400).json({ error: 'Failed to change avatar' } as ErrorResponse);
        }

        return response.status(200).json({ message: 'Avatar changed successfully' });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to change avatar', details: error } as ErrorResponse);
    }
});

router.post('/change/password', async (request: AuthRequest, response) => {
    const user = request.user;
    const { old_password, new_password } = request.body;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!old_password || !new_password) {
        return response.status(400).json({ error: 'Old password and new password are required' } as ErrorResponse);
    }

    try {
        const isPasswordValid = await PasswordService.verifyPassword(old_password, user.password_hash);
        if (!isPasswordValid) {
            return response.status(400).json({ error: 'Invalid old password' } as ErrorResponse);
        }

        const newPasswordHash = await PasswordService.hashPassword(new_password);
        const isPasswordChanged = await prisma.user.update({
            where: { id: user.id },
            data: { password_hash: newPasswordHash },
        });

        if (!isPasswordChanged) {
            return response.status(400).json({ error: 'Failed to change password' } as ErrorResponse);
        }

        return response.status(200).json({ message: 'Password changed successfully' });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to change password', details: error } as ErrorResponse);
    }
});

router.post('/change/display-name', async (request: AuthRequest, response) => {
    const user = request.user;
    const { display_name } = request.body;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!display_name) {
        return response.status(400).json({ error: 'Display name is required' } as ErrorResponse);
    }

    try {
        const isDisplayNameChanged = await prisma.user.update({
            where: { id: user.id },
            data: { display_name: display_name },
        });

        if (!isDisplayNameChanged) {
            return response.status(400).json({ error: 'Failed to change display name' } as ErrorResponse);
        }

        return response.status(200).json({ message: 'Display name changed successfully' });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to change display name', details: error } as ErrorResponse);
    }
});

async function reauthenticateUser(username: string | null, email: string | null, password: string) {
    if (username) {
        const user = await prisma.user.findUnique({
            where: { username: username.toLowerCase() },
        });

        if (!user) {
            return false;
        }

        const isPasswordValid = await PasswordService.verifyPassword(password, user.password_hash);
        if (!isPasswordValid) {
            return false;
        }

        return true;
    } else if (email) {
        const user = await prisma.user.findUnique({
            where: { email: email.toLowerCase() },
        });

        if (!user) {
            return false;
        }

        const isPasswordValid = await PasswordService.verifyPassword(password, user.password_hash);
        if (!isPasswordValid) {
            return false;
        }

        return true;
    } else {
        return false;
    }
}

router.post('/delete/account', async (request: AuthRequest, response) => {
    const user = request.user;
    const { reason, username, email, password } = request.body;

    if (!user) {
        return response.status(401).json({ error: 'Unauthorized' } as ErrorResponse);
    }

    if (!reason) {
        return response.status(400).json({ error: 'Reason is required' } as ErrorResponse);
    }

    try {
        const isUserReauthenticated = await reauthenticateUser(username, email, password);
        if (!isUserReauthenticated) {
            return response.status(400).json({ error: 'Invalid username, email or password' } as ErrorResponse);
        }

        const isAccountDeleted = await prisma.user.update({
            where: { id: user.id },
            data: {
                is_deleted: true,
                deleted_at: new Date(),
                deleted_reason: reason,
            },
        });

        if (!isAccountDeleted) {
            return response.status(400).json({ error: 'Failed to delete account' } as ErrorResponse);
        }

        return response.status(200).json({ message: 'Account deleted successfully' });
    } catch (error) {
        return response.status(500).json({ error: 'Failed to delete account', details: error } as ErrorResponse);
    }
});

export default router;
