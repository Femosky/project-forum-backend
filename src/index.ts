import { env } from './config/env';
import express from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { authenticateToken } from './middlewares/authMiddleware';
import userPrivateRoutes from './routes/private/userPrivateRoutes';
import authRoutes from './routes/public/authRoutes';
import communityPublicRoutes from './routes/public/communityPublicRoutes';
import communityPrivateRoutes from './routes/private/communityPrivateRoutes';
import postPrivateRoutes from './routes/private/postPrivateRoutes';
import postPublicRoutes from './routes/public/postPublicRoutes';
import commentPrivateRoutes from './routes/private/commentPrivateRoutes';
import commentPublicRoutes from './routes/public/commentPublicRoutes';
import userPublicRoutes from './routes/public/userPublicRoutes';
import { errorHandler, notFoundHandler } from './utils/errorUtils';

const app = express();

// Behind a hosting proxy, so request.ip and rate limiting see the real client IP
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors({ origin: env.WEB_ORIGINS, credentials: true }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

// In-memory rate limits (single instance). Move to a shared store if the API ever runs on more than one instance.
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many attempts, please try again later.' },
});

const writeLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: (request) => request.method === 'GET',
    message: { error: 'Too many requests, please slow down.' },
});

// Auth routes
app.use('/auth/login', authLimiter);
app.use('/auth/signup', authLimiter);
app.use('/auth', authRoutes);

// Public routes: Starts with /community
app.use('/community', communityPublicRoutes);
app.use('/community', postPublicRoutes);
app.use('/community', commentPublicRoutes);
app.use('/user', userPublicRoutes);

// Private routes
app.use('/user', authenticateToken, writeLimiter, userPrivateRoutes);
app.use('/community', authenticateToken, writeLimiter, communityPrivateRoutes);
app.use('/post', authenticateToken, writeLimiter, postPrivateRoutes);
app.use('/comment', authenticateToken, writeLimiter, commentPrivateRoutes);

app.get('/', (request, response) => {
    response.send('Welcome to the "Project Forum" API.');
});

app.use(notFoundHandler);
app.use(errorHandler);

app.listen(env.PORT, () => {
    console.log(`Server is running on port: ${env.PORT}`);
});
