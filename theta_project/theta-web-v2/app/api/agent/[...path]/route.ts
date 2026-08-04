import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { path } = await context.params;
  const baseUrl = process.env.THETA_AGENT_API_URL ?? 'http://127.0.0.1:4318';
  const target = new URL(`/api/v2/${path.map(encodeURIComponent).join('/')}`, baseUrl);
  target.search = request.nextUrl.search;

  try {
    const response = await fetch(target, { cache: 'no-store' });
    const body = await response.text();
    return new NextResponse(body, {
      status: response.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
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
