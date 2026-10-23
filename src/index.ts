import { env } from './config/env';
import app from './app';

app.listen(env.PORT, () => {
    console.log(`Server is running on port: ${env.PORT}`);
});
