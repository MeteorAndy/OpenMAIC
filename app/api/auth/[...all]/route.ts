import { auth } from '@/lib/auth';
import { toNextJsHandler } from 'better-auth/next-js';

// Catch-all handler mounting better-auth at /api/auth/*
export const { GET, POST } = toNextJsHandler(auth);
