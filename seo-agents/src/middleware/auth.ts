import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { supabase } from '../config/supabase';

export interface AuthRequest extends Request {
  userId?: string;
  userEmail?: string;
}

export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid authorization header' });
    return;
  }

  const token = authHeader.slice(7);

  try {
    const decoded = jwt.verify(token, config.jwt.secret) as { userId: string; email: string };

    // Verify user exists
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email')
      .eq('id', decoded.userId)
      .single();

    if (error || !user) {
      res.status(401).json({ error: 'User not found' });
      return;
    }

    req.userId = user.id;
    req.userEmail = user.email;
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: 'Token expired' });
      return;
    }
    res.status(401).json({ error: 'Invalid token' });
  }
}
