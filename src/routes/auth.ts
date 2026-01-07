import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { AuthService } from '../services/auth-service';

const router = Router();

router.post('/register', async (req: Request, res: Response) => {
    try {
        const { username, fullName, password } = req.body;
        const user = await AuthService.register(username, fullName, password);
        res.status(201).json({ message: 'User registered', user });
    } catch (err) {
        res.status(400).json({ error: 'Username already exists' });
    }
});

router.post('/login', async (req: Request, res: Response) => {
    const { username, password } = req.body;
    const user = await AuthService.validateUser(username, password);

    if (!user) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET!, { expiresIn: '1d' });
    res.json({ message: 'Login successful', token, user });
});

export default router;