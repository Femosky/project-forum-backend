import express from 'express';
import userRoutes from './routes/userRoutes';
import authRoutes from './routes/authRoutes';
import testRoutes from './routes/testRoutes';
import { authenticateToken } from './middlewares/authMiddleware';

const PORT_NUMBER = 3000;

const app = express();
app.use(express.json());

app.use('/user', authenticateToken, userRoutes);
app.use('/auth', authRoutes);
app.use('/test', authenticateToken, testRoutes);

app.get('/', (request, response) => {
    response.send('Welcome to the "Project Forum" API.');
});

app.listen(PORT_NUMBER, () => {
    console.log(`Server is running on port: ${PORT_NUMBER}`);
});
