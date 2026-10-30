import express, { Router } from 'express';
import { z } from 'zod';
import { forbidden, parse } from '../../lib/http';
import { AuthRequest, requireAuth, viewerOf } from '../../middlewares/auth';
import { communityRef } from '../../shared/validation';
import { canModerate, findCommunity, viewerContext } from '../communities/access';
import { MAX_IMAGE_BYTES, processUpload } from './service';

// POST /v1/images?purpose=community_icon|community_banner&community=: the picture itself is the request body
// (Content-Type image/jpeg, png, webp or gif). For that community's moderators. Ad pictures go through the admin
// panel instead (POST /v1/admin/images).

const router = Router();

const uploadQuery = z.object({
    purpose: z.enum(['community_icon', 'community_banner']),
    community: communityRef,
});

export const imageBody = express.raw({ type: ['image/*', 'application/octet-stream'], limit: MAX_IMAGE_BYTES + 1024 });
export const bodyBuffer = (body: unknown) => (Buffer.isBuffer(body) ? body : Buffer.alloc(0));

router.post('/', requireAuth, imageBody, async (request: AuthRequest, response) => {
    const { user } = viewerOf(request);
    const query = parse(uploadQuery, request.query);
    const community = await findCommunity(query.community);
    if (!canModerate(await viewerContext(request.viewer), community.id)) throw forbidden('Only moderators can change this.', 'not_moderator');
    response.status(201).json({ image: await processUpload(bodyBuffer(request.body), query.purpose, user.id) });
});

export default router;
