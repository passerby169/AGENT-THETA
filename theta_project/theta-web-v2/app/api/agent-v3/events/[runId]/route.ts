import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';

interface RouteContext {
  params: Promise<{ runId: string }>;
}

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, context: RouteContext) {
  const { runId } = await context.params;
  const baseUrl = process.env.THETA_AGENT_API_URL ?? 'http://127.0.0.1:4318';
  const target = new URL(
    `/api/v3/runs/${encodeURIComponent(runId)}/events/stream`,
    baseUrl,
  );
  const afterEventId = request.nextUrl.searchParams.get('afterEventId');
  if (afterEventId) target.searchParams.set('afterEventId', afterEventId);

  const headers = new Headers({ Accept: 'text/event-stream' });
  const lastEventId = request.headers.get('last-event-id');
  if (lastEventId) headers.set('Last-Event-ID', lastEventId);

  try {
    const response = await fetch(target, {
      cache: 'no-store',
      headers,
      signal: request.signal,
    });
    if (!response.ok || !response.body) {
      return new NextResponse(response.body, {
        status: response.status,
        headers: {
          'Content-Type': response.headers.get('content-type') ?? 'application/json',
          'Cache-Control': 'no-store',
        },
      });
    }
    return new NextResponse(response.body, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: 'EVENT_STREAM_UNAVAILABLE',
          category: 'unavailable',
          message: '无法连接 THETA Agent 事件流。',
          retryable: true,
          recovery: {
            action: 'refresh',
            label: '刷新状态',
            description: '重新读取 RunView 后再次连接事件流。',
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
