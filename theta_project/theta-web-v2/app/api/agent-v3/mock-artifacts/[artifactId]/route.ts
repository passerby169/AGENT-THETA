import { NextResponse } from 'next/server';

const csv = 'topic_id,topic_label,share\n1,监管框架,0.31\n2,产业应用,0.27\n3,风险治理,0.19\n';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ artifactId: string }> },
) {
  const { artifactId } = await params;
  if (artifactId === 'artifact_topic_table') {
    return new NextResponse(csv, {
      headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'inline; filename="topics.csv"' },
    });
  }
  if (artifactId === 'artifact_model_bundle') {
    return NextResponse.json({ planVersion: 2, experiments: 6, status: 'completed' });
  }
  if (artifactId === 'artifact_topic_share') {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    return new NextResponse(png, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } });
  }
  if (artifactId === 'artifact_overview_report') {
    return new NextResponse('<!doctype html><meta charset="utf-8"><title>THETA 结果概览</title><h1>研究结果概览</h1><p>监管框架、产业应用和风险治理是最稳定的三个主题。</p>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });
}
