import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';

const SALT_ROUNDS = 10;
const JWT_EXPIRY = '24h';

/**
 * Auth utility class for DevAgent
 */
export class Auth {
  constructor(jwtSecret) {
    this.passwordHash = null;
    this.jwtSecret = jwtSecret || this.generateSecret();
  }

  static async create(password, jwtSecret) {
    const instance = new Auth(jwtSecret);
    await instance.initPassword(password);
    return instance;
  }

  /**
   * Generate a random JWT secret
   */
  generateSecret() {
    return Array.from({ length: 64 }, () => 
      Math.random().toString(36).charAt(2)
    ).join('');
  }

  /**
   * Initialize password hash
   */
  async initPassword(password) {
    if (!password) {
      throw new Error('PASSWORD environment variable is required');
    }
    this.passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  }

  /**
   * Verify password against stored hash
   */
  async verifyPassword(password) {
    return bcrypt.compare(password, this.passwordHash);
  }

  /**
   * Generate JWT token
   */
  generateToken(payload = {}) {
    return jwt.sign(
      { 
        ...payload, 
        iat: Date.now() 
      }, 
      this.jwtSecret, 
      { expiresIn: JWT_EXPIRY }
    );
  }

  /**
   * Verify JWT token
   */
  verifyToken(token) {
    try {
      return jwt.verify(token, this.jwtSecret);
    } catch (error) {
      return null;
    }
  }

  /**
   * Express middleware for route protection
   */
  middleware() {
    return (req, res, next) => {
      const authHeader = req.headers.authorization;
      
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ 
          success: false, 
          error: 'No token provided' 
        });
      }

      const token = authHeader.substring(7);
      const decoded = this.verifyToken(token);

      if (!decoded) {
        return res.status(401).json({ 
          success: false, 
          error: 'Invalid or expired token' 
        });
      }

      req.user = decoded;
      next();
    };
  }

  /**
   * Verify WebSocket token
   */
  verifyWebSocketToken(token) {
    return this.verifyToken(token);
  }
}

/**
 * Rate limiter for login endpoint
 */
export const loginRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 attempts per minute
  message: { 
    success: false, 
    error: 'Too many login attempts. Please try again later.' 
  },
  standardHeaders: true,
  legacyHeaders: false,
});

export default Auth;
