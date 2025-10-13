import express from 'express';
import { authenticateToken } from './middlewares/authMiddleware';
import userPrivateRoutes from './routes/private/userPrivateRoutes';
import authRoutes from './routes/public/authRoutes';
import testRoutes from './routes/testRoutes';
import communityPublicRoutes from './routes/public/communityPublicRoutes';
import communityPrivateRoutes from './routes/private/communityPrivateRoutes';
import postPrivateRoutes from './routes/private/postPrivateRoutes';
import postPublicRoutes from './routes/public/postPublicRoutes';
import commentPrivateRoutes from './routes/private/commentPrivateRoutes';
import commentPublicRoutes from './routes/public/commentPublicRoutes';
import userPublicRoutes from './routes/public/userPublicRoutes';

const PORT_NUMBER = 3000;

const app = express();
app.use(express.json());

// Auth routes
app.use('/auth', authRoutes);
// app.use('/test', authenticateToken, testRoutes);

// Public routes: Starts with /community
app.use('/community', communityPublicRoutes);
app.use('/community', postPublicRoutes);
app.use('/community', commentPublicRoutes);
app.use('/user', userPublicRoutes);

// Private routes
app.use('/user', authenticateToken, userPrivateRoutes);
app.use('/community', authenticateToken, communityPrivateRoutes);
app.use('/post', authenticateToken, postPrivateRoutes);
app.use('/comment', authenticateToken, commentPrivateRoutes);

app.get('/', (request, response) => {
    response.send('Welcome to the "Project Forum" API.');
});

app.listen(PORT_NUMBER, () => {
    console.log(`Server is running on port: ${PORT_NUMBER}`);
});
