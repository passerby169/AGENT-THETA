import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  return proxy(request, context);
}

export async function POST(request: NextRequest, context: RouteContext) {
  return proxy(request, context);
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  return proxy(request, context);
}

async function proxy(request: NextRequest, context: RouteContext) {
  const { path } = await context.params;
  const baseUrl = process.env.THETA_AGENT_API_URL ?? 'http://127.0.0.1:4318';
  const target = new URL(`/api/v2/${path.map(encodeURIComponent).join('/')}`, baseUrl);
  target.search = request.nextUrl.search;

  try {
    const requestContentType = request.headers.get('content-type');
    const response = await fetch(target, {
      method: request.method,
      cache: 'no-store',
      headers: request.method === 'POST' && requestContentType ? { 'Content-Type': requestContentType } : undefined,
      body: request.method === 'POST' ? await request.arrayBuffer() : undefined,
    });
    const body = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
    return new NextResponse(body, {
      status: response.status,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': contentType.startsWith('image/') ? 'private, max-age=300' : 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'THETA_AGENT_API_UNAVAILABLE',
          message: '无法连接 THETA Agent API，请先启动二代后端。',
        },
      },
      { status: 502 },
    );
  }
}
