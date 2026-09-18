import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { createCorsOptions, getJwtSecret } from './security.js';

const JWT_SECRET = getJwtSecret();

let io = null;
const presenceState = new Map();

function getPresencePayload(userId) {
  const state = presenceState.get(userId);
  return {
    userId,
    isOnline: Boolean(state?.count),
    lastSeenAt: state?.lastSeenAt || null,
  };
}

function publishPresence(userId) {
  if (!io) return;
  const payload = getPresencePayload(userId);
  io.to(`presence:${userId}`).emit('presence:update', payload);
  io.to(`user:${userId}`).emit('presence:update', payload);
}

function resolveSocketToken(socket) {
  const authToken = socket.handshake.auth?.token;
  if (authToken) return authToken;

  const header = socket.handshake.headers?.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer ')) {
    return header.slice(7);
  }

  return null;
}

export function attachRealtimeServer(server) {
  io = new Server(server, {
    cors: createCorsOptions(),
  });

  io.use((socket, next) => {
    try {
      const token = resolveSocketToken(socket);
      if (!token) {
        return next(new Error('Unauthorized'));
      }

      const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
      socket.user = {
        id: decoded.sub,
        email: decoded.email,
      };
      next();
    } catch (error) {
      next(new Error('Unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const userId = socket.user.id;
    socket.join(`user:${userId}`);

    const existing = presenceState.get(userId) || { count: 0, lastSeenAt: null };
    presenceState.set(userId, {
      count: existing.count + 1,
      lastSeenAt: existing.lastSeenAt,
    });
    publishPresence(userId);

    socket.on('presence:subscribe', (payload = {}) => {
      const userIds = Array.isArray(payload.userIds) ? payload.userIds.filter(Boolean) : [];
      userIds.forEach((targetUserId) => socket.join(`presence:${targetUserId}`));
      socket.emit(
        'presence:snapshot',
        userIds.map((targetUserId) => getPresencePayload(targetUserId))
      );
    });

    socket.on('chat:join', ({ connectionId } = {}) => {
      if (!connectionId) return;
      socket.join(`chat:${connectionId}`);
    });

    socket.on('chat:leave', ({ connectionId } = {}) => {
      if (!connectionId) return;
      socket.leave(`chat:${connectionId}`);
    });

    socket.on('group:join', ({ groupId } = {}) => {
      if (!groupId) return;
      socket.join(`group:${groupId}`);
    });

    socket.on('group:leave', ({ groupId } = {}) => {
      if (!groupId) return;
      socket.leave(`group:${groupId}`);
    });

    socket.on('chat:typing', ({ connectionId, isTyping } = {}) => {
      if (!connectionId) return;
      socket.to(`chat:${connectionId}`).emit('chat:typing', {
        connectionId,
        userId,
        isTyping: Boolean(isTyping),
      });
    });

    socket.on('group:typing', ({ groupId, isTyping } = {}) => {
      if (!groupId) return;
      socket.to(`group:${groupId}`).emit('group:typing', {
        groupId,
        userId,
        isTyping: Boolean(isTyping),
      });
    });

    socket.on('disconnect', () => {
      const previous = presenceState.get(userId);
      if (!previous) return;

      const nextCount = Math.max(0, previous.count - 1);
      presenceState.set(userId, {
        count: nextCount,
        lastSeenAt: nextCount === 0 ? new Date().toISOString() : previous.lastSeenAt,
      });
      publishPresence(userId);
    });
  });

  return io;
}

export function emitUserEvent(userId, eventName, payload) {
  if (!io || !userId) return;
  io.to(`user:${userId}`).emit(eventName, payload);
}

export function emitChatEvent(connectionId, eventName, payload) {
  if (!io || !connectionId) return;
  io.to(`chat:${connectionId}`).emit(eventName, payload);
}

export function emitGroupEvent(groupId, eventName, payload) {
  if (!io || !groupId) return;
  io.to(`group:${groupId}`).emit(eventName, payload);
}

export function getOnlineState(userId) {
  return getPresencePayload(userId);
}
