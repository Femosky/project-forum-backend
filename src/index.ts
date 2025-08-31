import express from 'express';
import { authenticateToken } from './middlewares/authMiddleware';
import userRoutes from './routes/private/userRoutes';
import authRoutes from './routes/public/authRoutes';
import testRoutes from './routes/testRoutes';
import communityPublicRoutes from './routes/public/communityPublicRoutes';
import communityPrivateRoutes from './routes/private/communityPrivateRoutes';
import postPrivateRoutes from './routes/private/postPrivateRoutes';
import postPublicRoutes from './routes/public/postPublicRoutes';

const PORT_NUMBER = 3000;

const app = express();
app.use(express.json());

// Auth routes
app.use('/auth', authRoutes);
// app.use('/test', authenticateToken, testRoutes);

// Public routes
app.use('/community', communityPublicRoutes);
app.use('/community', postPublicRoutes);

// Private routes
app.use('/user', authenticateToken, userRoutes);
app.use('/community', authenticateToken, communityPrivateRoutes);
app.use('/community', authenticateToken, postPrivateRoutes);

app.get('/', (request, response) => {
    response.send('Welcome to the "Project Forum" API.');
});

app.listen(PORT_NUMBER, () => {
    console.log(`Server is running on port: ${PORT_NUMBER}`);
});
