/**
 * GET /api/comfyui-workflows — mirrors app/api/comfyui-workflows/route.ts. Public.
 * Note: returns { workflows: [...] } directly (not the success envelope), matching the Next route.
 */
import { Hono } from 'hono';
import { NextResponse } from 'next/server';
import { listComfyuiWorkflows } from '@/lib/media/comfyui-workflows';

export const comfyuiWorkflowsRoute = new Hono();

comfyuiWorkflowsRoute.get('/', async () => {
  try {
    return NextResponse.json({ workflows: await listComfyuiWorkflows() });
  } catch (err) {
    console.error('[ComfyUI Workflows API] Failed to list workflows:', err);
    return NextResponse.json({ workflows: [] });
  }
});
