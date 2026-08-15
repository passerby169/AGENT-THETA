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
  const target = new URL(`/api/v3/${path.map(encodeURIComponent).join('/')}`, baseUrl);
  target.search = request.nextUrl.search;

  try {
    const contentType = request.headers.get('content-type');
    const response = await fetch(target, {
      method: request.method,
      cache: 'no-store',
      headers: contentType ? { 'Content-Type': contentType } : undefined,
      body: request.method === 'GET' ? undefined : await request.arrayBuffer(),
    });
    return new NextResponse(response.body, {
      status: response.status,
      headers: responseHeaders(response),
    });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'AGENT_API_UNAVAILABLE',
          category: 'unavailable',
          message: '无法连接 THETA Agent V3 API。',
          retryable: true,
          recovery: {
            action: 'retry',
            label: '重试',
            description: '确认 Agent API 已启动后重试。',
          },
        },
        meta: {
          apiVersion: '3.0.0',
          requestId: crypto.randomUUID(),
          serverTime: new Date().toISOString(),
        },
      },
      { status: 502 },
    );
  }
}

const responseHeaders = (response: Response): Headers => {
  const headers = new Headers();
  const contentType = response.headers.get('content-type');
  if (contentType) headers.set('Content-Type', contentType);
  const requestId = response.headers.get('x-request-id');
  if (requestId) headers.set('X-Request-ID', requestId);
  headers.set('Cache-Control', 'no-store');
  return headers;
};
